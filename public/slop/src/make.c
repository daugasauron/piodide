/*
 * pmake - a small make implementation for the piodide/slop WASI environment.
 *
 * It deliberately executes recipes through /bin/slop using piodide's spawn
 * host call.  A conventional WASI build of GNU make cannot run recipes because
 * WASI has no fork/exec; this keeps make useful while remaining a normal WASI
 * command.
 *
 * Supported: explicit and % pattern rules, timestamps, .PHONY, order-only
 * prerequisites, recursive/simple/conditional/append variables, command-line
 * variables, common text functions, includes, basic conditionals, automatic
 * variables, -C/-f/-n/-s/-B/-q/-t/-k, and serial recipe execution.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <glob.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define MAX_RULES 1024
#define MAX_VARS 1024
#define MAX_CMDS 256
#define MAX_DEPS 1024
#define MAX_NODES 2048
#define MAX_GROUP 128
#define MAX_INCLUDE_DEPTH 16
#define MAX_COND_DEPTH 32
#define MAX_EXPAND_DEPTH 40
#define LINE_CAP 65536
#define PATH_CAP 4096

typedef struct {
  const char *stdin_data;
  int stdin_len;
  char *capture;
  int capture_cap;
  int *capture_len;
  const char *out_file;
  int out_append;
  const char *env_data;
  int env_len;
} slop_io;

/* Defined in a separate placeholder translation unit, then replaced with the
 * piodide.spawn_v3 import by patch_import.py after linking. */
extern int piodide_spawn(const char *path, const char *argv_blob, const char *cwd,
                         slop_io *io);

typedef struct {
  char *s;
  size_t len, cap;
} Buf;

typedef struct {
  char *name, *value;
  int simple, locked, exported;
} Var;

typedef struct {
  char *target;
  char *deps;
  char **cmds;
  int ncmd, cmdcap;
  int builtin;
} Rule;

typedef struct {
  int64_t seconds;
  long nanoseconds;
} FileTime;

typedef struct {
  char *name;
  int state;                 /* 0 unseen, 1 visiting, 2 done */
  int updated, failed;
  FileTime mtime;
} Node;

typedef struct {
  const char *target, *first, *all, *newer, *stem;
} Auto;

typedef struct {
  char *name;
  int order_only;
} Dep;

static Var vars[MAX_VARS];
static int nvars;
static Rule rules[MAX_RULES];
static int nrules;
static Node nodes[MAX_NODES];
static int nnodes;
static char *first_goal;
static int opt_dry, opt_silent, opt_always, opt_question, opt_touch;
static int opt_keep, opt_no_builtin, query_needed, errors;
static const char *program = "make";

static void die(const char *fmt, ...) {
  va_list ap;
  fprintf(stderr, "%s: ", program);
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fputc('\n', stderr);
  exit(2);
}

static void *xmalloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) die("out of memory");
  return p;
}

static char *xstrdup(const char *s) {
  char *p = strdup(s ? s : "");
  if (!p) die("out of memory");
  return p;
}

static void binit(Buf *b) {
  b->cap = 128;
  b->len = 0;
  b->s = xmalloc(b->cap);
  b->s[0] = 0;
}

static void bgrow(Buf *b, size_t add) {
  if (b->len + add + 1 <= b->cap) return;
  while (b->len + add + 1 > b->cap) {
    if (b->cap > (16u * 1024u * 1024u)) die("expanded text is too large");
    b->cap *= 2;
  }
  b->s = realloc(b->s, b->cap);
  if (!b->s) die("out of memory");
}

static void bputn(Buf *b, const char *s, size_t n) {
  bgrow(b, n);
  memcpy(b->s + b->len, s, n);
  b->len += n;
  b->s[b->len] = 0;
}

static void bputs(Buf *b, const char *s) { bputn(b, s, strlen(s)); }
static void bputc(Buf *b, char c) { bputn(b, &c, 1); }

static char *trim(char *s) {
  while (isspace((unsigned char)*s)) s++;
  char *e = s + strlen(s);
  while (e > s && isspace((unsigned char)e[-1])) *--e = 0;
  return s;
}

static int file_mtime(const char *path, FileTime *out) {
  struct stat st;
  if (stat(path, &st) != 0) return 0;
  out->seconds = (int64_t)st.st_mtim.tv_sec;
  out->nanoseconds = st.st_mtim.tv_nsec;
  return 1;
}

static int file_time_compare(FileTime left, FileTime right) {
  if (left.seconds < right.seconds) return -1;
  if (left.seconds > right.seconds) return 1;
  if (left.nanoseconds < right.nanoseconds) return -1;
  if (left.nanoseconds > right.nanoseconds) return 1;
  return 0;
}

static Var *find_var(const char *name) {
  for (int i = nvars - 1; i >= 0; i--)
    if (!strcmp(vars[i].name, name)) return &vars[i];
  return NULL;
}

static Var *ensure_var(const char *name) {
  Var *v = find_var(name);
  if (v) return v;
  if (nvars >= MAX_VARS) die("too many variables (limit %d)", MAX_VARS);
  v = &vars[nvars++];
  memset(v, 0, sizeof *v);
  v->name = xstrdup(name);
  v->value = xstrdup("");
  return v;
}

static const char *raw_var(const char *name) {
  Var *v = find_var(name);
  if (v) return v->value;
  const char *e = getenv(name);
  return e ? e : "";
}

static char *expand_depth(const char *in, const Auto *a, int depth);

static void set_var(const char *name, const char *value, int simple, int locked,
                    int conditional, int append) {
  Var *v = find_var(name);
  if (conditional && (v || getenv(name))) return;
  if (v && v->locked && !locked) return;
  if (!v) v = ensure_var(name);
  if (append) {
    char *rhs = simple || v->simple ? expand_depth(value, NULL, 0) : xstrdup(value);
    size_t old = strlen(v->value), add = strlen(rhs);
    char *joined = xmalloc(old + add + 2);
    memcpy(joined, v->value, old);
    if (old && add) joined[old++] = ' ';
    memcpy(joined + old, rhs, add + 1);
    free(v->value);
    free(rhs);
    v->value = joined;
  } else {
    char *nv = simple ? expand_depth(value, NULL, 0) : xstrdup(value);
    free(v->value);
    v->value = nv;
    v->simple = simple;
  }
  if (locked) v->locked = 1;
}

static void split_words(const char *s, char ***out, int *count) {
  char *copy = xstrdup(s), *p = copy;
  char **v = NULL;
  int n = 0, cap = 0;
  while (*p) {
    while (isspace((unsigned char)*p)) p++;
    if (!*p) break;
    char *start = p;
    while (*p && !isspace((unsigned char)*p)) p++;
    if (*p) *p++ = 0;
    if (n == cap) {
      cap = cap ? cap * 2 : 8;
      v = realloc(v, (size_t)cap * sizeof *v);
      if (!v) die("out of memory");
    }
    v[n++] = xstrdup(start);
  }
  free(copy);
  *out = v;
  *count = n;
}

static void free_words(char **v, int n) {
  for (int i = 0; i < n; i++) free(v[i]);
  free(v);
}

static void join_word(Buf *b, const char *word, int *first) {
  if (!*first) bputc(b, ' ');
  bputs(b, word);
  *first = 0;
}

static int pattern_match(const char *pat, const char *word, char **stem_out) {
  const char *pct = strchr(pat, '%');
  if (!pct) return !strcmp(pat, word);
  size_t pre = (size_t)(pct - pat), suf = strlen(pct + 1), wl = strlen(word);
  if (wl < pre + suf || strncmp(pat, word, pre) ||
      strcmp(pct + 1, word + wl - suf)) return 0;
  if (stem_out) {
    size_t n = wl - pre - suf;
    *stem_out = xmalloc(n + 1);
    memcpy(*stem_out, word + pre, n);
    (*stem_out)[n] = 0;
  }
  return 1;
}

static char *pattern_replace(const char *pat, const char *replacement,
                             const char *word) {
  char *stem = NULL;
  if (!pattern_match(pat, word, &stem)) return xstrdup(word);
  const char *pct = strchr(replacement, '%');
  if (!pct) {
    free(stem);
    return xstrdup(replacement);
  }
  Buf b;
  binit(&b);
  bputn(&b, replacement, (size_t)(pct - replacement));
  bputs(&b, stem ? stem : "");
  bputs(&b, pct + 1);
  free(stem);
  return b.s;
}

/* Split function arguments on top-level commas. */
static int split_args(char *s, char **args, int max) {
  int n = 0, level = 0;
  char *start = s;
  for (char *p = s;; p++) {
    if (*p == '$' && (p[1] == '(' || p[1] == '{')) {
      level++;
      p++;
    } else if (level && (*p == ')' || *p == '}')) {
      level--;
    } else if ((*p == ',' && level == 0) || *p == 0) {
      if (n < max) {
        char save = *p;
        *p = 0;
        args[n++] = trim(start);
        if (!save) break;
        start = p + 1;
      }
      if (!*p) break;
    }
  }
  return n;
}

static char *map_path_function(const char *name, const char *input) {
  char **w;
  int n, first = 1;
  Buf b;
  binit(&b);
  split_words(input, &w, &n);
  for (int i = 0; i < n; i++) {
    char *x = w[i], *r = NULL;
    const char *slash = strrchr(x, '/');
    const char *dot = strrchr(slash ? slash + 1 : x, '.');
    if (!strcmp(name, "notdir")) r = xstrdup(slash ? slash + 1 : x);
    else if (!strcmp(name, "dir")) {
      if (!slash) r = xstrdup("./");
      else {
        size_t z = (size_t)(slash - x + 1);
        r = xmalloc(z + 1);
        memcpy(r, x, z);
        r[z] = 0;
      }
    } else if (!strcmp(name, "basename")) {
      size_t z = dot ? (size_t)(dot - x) : strlen(x);
      r = xmalloc(z + 1);
      memcpy(r, x, z);
      r[z] = 0;
    } else if (!strcmp(name, "suffix")) r = xstrdup(dot ? dot : "");
    if (r && *r) join_word(&b, r, &first);
    free(r);
  }
  free_words(w, n);
  return b.s;
}

static char *eval_function(const char *fname, char *body, const Auto *a, int depth) {
  char *args[8] = {0};
  int na = split_args(body, args, 8);
  Buf out;
  binit(&out);

  if (!strcmp(fname, "strip")) {
    char *x = expand_depth(na ? args[0] : "", a, depth + 1);
    char **w; int n, first = 1;
    split_words(x, &w, &n);
    for (int i = 0; i < n; i++) join_word(&out, w[i], &first);
    free_words(w, n); free(x);
  } else if (!strcmp(fname, "wildcard")) {
    char *x = expand_depth(na ? args[0] : "", a, depth + 1);
    char **patterns; int np, first = 1;
    split_words(x, &patterns, &np);
    for (int i = 0; i < np; i++) {
      glob_t g;
      memset(&g, 0, sizeof g);
      if (glob(patterns[i], 0, NULL, &g) == 0)
        for (size_t j = 0; j < g.gl_pathc; j++) join_word(&out, g.gl_pathv[j], &first);
      globfree(&g);
    }
    free_words(patterns, np); free(x);
  } else if (!strcmp(fname, "subst") && na >= 3) {
    char *from = expand_depth(args[0], a, depth + 1);
    char *to = expand_depth(args[1], a, depth + 1);
    char *text = expand_depth(args[2], a, depth + 1);
    size_t fl = strlen(from);
    if (!fl) bputs(&out, text);
    else for (char *p = text; *p;) {
      char *q = strstr(p, from);
      if (!q) { bputs(&out, p); break; }
      bputn(&out, p, (size_t)(q - p)); bputs(&out, to); p = q + fl;
    }
    free(from); free(to); free(text);
  } else if (!strcmp(fname, "patsubst") && na >= 3) {
    char *pat = expand_depth(args[0], a, depth + 1);
    char *rep = expand_depth(args[1], a, depth + 1);
    char *text = expand_depth(args[2], a, depth + 1);
    char **w; int n, first = 1;
    split_words(text, &w, &n);
    for (int i = 0; i < n; i++) {
      char *r = pattern_replace(pat, rep, w[i]);
      join_word(&out, r, &first); free(r);
    }
    free_words(w, n); free(pat); free(rep); free(text);
  } else if ((!strcmp(fname, "addprefix") || !strcmp(fname, "addsuffix")) && na >= 2) {
    char *affix = expand_depth(args[0], a, depth + 1);
    char *text = expand_depth(args[1], a, depth + 1);
    char **w; int n, first = 1;
    split_words(text, &w, &n);
    for (int i = 0; i < n; i++) {
      Buf t; binit(&t);
      if (!strcmp(fname, "addprefix")) { bputs(&t, affix); bputs(&t, w[i]); }
      else { bputs(&t, w[i]); bputs(&t, affix); }
      join_word(&out, t.s, &first); free(t.s);
    }
    free_words(w, n); free(affix); free(text);
  } else if (!strcmp(fname, "notdir") || !strcmp(fname, "dir") ||
             !strcmp(fname, "basename") || !strcmp(fname, "suffix")) {
    char *x = expand_depth(na ? args[0] : "", a, depth + 1);
    free(out.s); out.s = map_path_function(fname, x); out.len = strlen(out.s);
    free(x);
  } else if (!strcmp(fname, "firstword") || !strcmp(fname, "lastword") ||
             !strcmp(fname, "words")) {
    char *x = expand_depth(na ? args[0] : "", a, depth + 1);
    char **w; int n;
    split_words(x, &w, &n);
    if (!strcmp(fname, "words")) {
      char num[32]; snprintf(num, sizeof num, "%d", n); bputs(&out, num);
    } else if (n) bputs(&out, !strcmp(fname, "firstword") ? w[0] : w[n - 1]);
    free_words(w, n); free(x);
  } else if (!strcmp(fname, "word") && na >= 2) {
    char *ix = expand_depth(args[0], a, depth + 1);
    char *x = expand_depth(args[1], a, depth + 1);
    int wanted = atoi(ix); char **w; int n;
    split_words(x, &w, &n);
    if (wanted > 0 && wanted <= n) bputs(&out, w[wanted - 1]);
    free_words(w, n); free(ix); free(x);
  } else if (!strcmp(fname, "filter") || !strcmp(fname, "filter-out")) {
    char *ps = expand_depth(na ? args[0] : "", a, depth + 1);
    char *text = expand_depth(na > 1 ? args[1] : "", a, depth + 1);
    char **pv, **wv; int np, nw, first = 1;
    split_words(ps, &pv, &np); split_words(text, &wv, &nw);
    for (int i = 0; i < nw; i++) {
      int hit = 0;
      for (int j = 0; j < np; j++) if (pattern_match(pv[j], wv[i], NULL)) { hit = 1; break; }
      if (hit != !strcmp(fname, "filter-out")) join_word(&out, wv[i], &first);
    }
    free_words(pv, np); free_words(wv, nw); free(ps); free(text);
  } else {
    free(out.s);
    return NULL;
  }
  return out.s;
}

static const char *auto_value(const char *name, const Auto *a) {
  if (!a || !name[0] || name[1]) return NULL;
  switch (name[0]) {
    case '@': return a->target ? a->target : "";
    case '<': return a->first ? a->first : "";
    case '^': return a->all ? a->all : "";
    case '?': return a->newer ? a->newer : "";
    case '*': return a->stem ? a->stem : "";
    default: return NULL;
  }
}

static char *eval_ref(char *content, const Auto *a, int depth) {
  char *t = trim(content);
  const char *av = auto_value(t, a);
  if (av) return xstrdup(av);

  static const char *funcs[] = {"strip", "wildcard", "subst", "patsubst",
    "addprefix", "addsuffix", "notdir", "dir", "basename", "suffix",
    "firstword", "lastword", "word", "words", "filter", "filter-out", NULL};
  for (int i = 0; funcs[i]; i++) {
    size_t n = strlen(funcs[i]);
    if (!strncmp(t, funcs[i], n) && isspace((unsigned char)t[n])) {
      char *body = trim(t + n);
      char *r = eval_function(funcs[i], body, a, depth);
      if (r) return r;
    }
  }

  /* GNU-style substitution reference: $(OBJS:.c=.o). */
  char *colon = strchr(t, ':');
  char *eq = colon ? strchr(colon + 1, '=') : NULL;
  if (colon && eq) {
    *colon = 0; *eq = 0;
    char *name = trim(t), *from = colon + 1, *to = eq + 1;
    char *base = expand_depth(raw_var(name), a, depth + 1);
    char **w; int n, first = 1; Buf b; binit(&b);
    split_words(base, &w, &n);
    for (int i = 0; i < n; i++) {
      size_t wl = strlen(w[i]), fl = strlen(from);
      if (wl >= fl && !strcmp(w[i] + wl - fl, from)) {
        Buf q; binit(&q); bputn(&q, w[i], wl - fl); bputs(&q, to);
        join_word(&b, q.s, &first); free(q.s);
      } else join_word(&b, w[i], &first);
    }
    free_words(w, n); free(base);
    return b.s;
  }

  char *name = expand_depth(t, a, depth + 1);
  Var *v = find_var(name);
  const char *value = v ? v->value : getenv(name);
  char *r;
  if (!value) r = xstrdup("");
  else if (v && v->simple) r = xstrdup(value);
  else r = expand_depth(value, a, depth + 1);
  free(name);
  return r;
}

static char *expand_depth(const char *in, const Auto *a, int depth) {
  if (depth > MAX_EXPAND_DEPTH) die("variable expansion is too deeply recursive");
  Buf b; binit(&b);
  for (size_t i = 0; in[i];) {
    if (in[i] != '$') { bputc(&b, in[i++]); continue; }
    i++;
    if (!in[i]) { bputc(&b, '$'); break; }
    if (in[i] == '$') { bputc(&b, '$'); i++; continue; }
    if (strchr("@<^?*", in[i])) {
      char n[2] = {in[i++], 0};
      const char *v = auto_value(n, a);
      if (v) bputs(&b, v);
      continue;
    }
    if (in[i] == '(' || in[i] == '{') {
      char open = in[i], close = open == '(' ? ')' : '}';
      size_t start = ++i; int level = 1;
      while (in[i] && level) {
        if (in[i] == open) level++;
        else if (in[i] == close) level--;
        if (level) i++;
      }
      if (level) die("unterminated variable reference");
      size_t n = i - start;
      char *inside = xmalloc(n + 1);
      memcpy(inside, in + start, n); inside[n] = 0; i++;
      char *v = eval_ref(inside, a, depth);
      bputs(&b, v); free(v); free(inside);
    } else {
      char n[2] = {in[i++], 0};
      char *v = eval_ref(n, a, depth);
      bputs(&b, v); free(v);
    }
  }
  return b.s;
}

static Rule *new_rule(const char *target, int builtin) {
  if (nrules >= MAX_RULES) die("too many rules (limit %d)", MAX_RULES);
  Rule *r = &rules[nrules++];
  memset(r, 0, sizeof *r);
  r->target = xstrdup(target);
  r->deps = xstrdup("");
  r->builtin = builtin;
  return r;
}

static Rule *find_explicit(const char *target) {
  for (int i = 0; i < nrules; i++)
    if (!strchr(rules[i].target, '%') && !strcmp(rules[i].target, target)) return &rules[i];
  return NULL;
}

static Rule *get_rule(const char *target, int builtin) {
  Rule *r = find_explicit(target);
  return r ? r : new_rule(target, builtin);
}

static void append_deps(Rule *r, const char *deps) {
  if (!deps || !*deps) return;
  size_t a = strlen(r->deps), b = strlen(deps);
  char *n = xmalloc(a + b + 2);
  memcpy(n, r->deps, a);
  if (a) n[a++] = ' ';
  memcpy(n + a, deps, b + 1);
  free(r->deps); r->deps = n;
}

static void append_cmd(Rule *r, const char *cmd) {
  if (r->ncmd == r->cmdcap) {
    r->cmdcap = r->cmdcap ? r->cmdcap * 2 : 4;
    if (r->cmdcap > MAX_CMDS) die("too many commands for target %s", r->target);
    r->cmds = realloc(r->cmds, (size_t)r->cmdcap * sizeof *r->cmds);
    if (!r->cmds) die("out of memory");
  }
  r->cmds[r->ncmd++] = xstrdup(cmd);
}

static char *strip_comment(char *s) {
  int sq = 0, dq = 0;
  for (char *p = s; *p; p++) {
    if (*p == '\\' && p[1]) { p++; continue; }
    if (*p == '\'' && !dq) sq = !sq;
    else if (*p == '"' && !sq) dq = !dq;
    else if (*p == '#' && !sq && !dq) { *p = 0; break; }
  }
  return s;
}

static int parse_assignment(char *line, int locked) {
  char *eq = strchr(line, '=');
  if (!eq) return 0;
  char op = 0;
  char *opstart = eq;
  if (eq > line && strchr(":+?", eq[-1])) { op = eq[-1]; opstart = eq - 1; }
  for (char *p = line; p < opstart; p++) if (*p == ':') return 0;
  *opstart = 0;
  char *name = trim(line), *value = trim(eq + 1);
  if (!*name || strpbrk(name, " \t")) return 0;
  set_var(name, value, op == ':', locked, op == '?', op == '+');
  return 1;
}

static int active_conditions(int *conds, int n) {
  for (int i = 0; i < n; i++) if (!conds[i]) return 0;
  return 1;
}

static void parse_file(const char *path, int required, int depth);

static void parse_include_list(const char *text, int required, int depth) {
  char *x = expand_depth(text, NULL, 0);
  char **w; int n;
  split_words(x, &w, &n);
  for (int i = 0; i < n; i++) {
    glob_t g; memset(&g, 0, sizeof g);
    int rc = glob(w[i], 0, NULL, &g);
    if (rc == 0) {
      for (size_t j = 0; j < g.gl_pathc; j++) parse_file(g.gl_pathv[j], required, depth + 1);
    } else parse_file(w[i], required, depth + 1);
    globfree(&g);
  }
  free_words(w, n); free(x);
}

static void parse_file(const char *path, int required, int depth) {
  if (depth > MAX_INCLUDE_DEPTH) die("include nesting is too deep");
  FILE *f = fopen(path, "r");
  if (!f) {
    if (required) die("%s: %s", path, strerror(errno));
    return;
  }
  char physical[LINE_CAP], logical[LINE_CAP];
  size_t llen = 0;
  int logical_recipe = 0, lineno = 0;
  Rule *group[MAX_GROUP]; int ngroup = 0;
  int conds[MAX_COND_DEPTH], ncond = 0;

  while (fgets(physical, sizeof physical, f)) {
    lineno++;
    size_t z = strlen(physical);
    if (z == sizeof physical - 1 && physical[z - 1] != '\n')
      die("%s:%d: line is too long", path, lineno);
    while (z && (physical[z - 1] == '\n' || physical[z - 1] == '\r')) physical[--z] = 0;
    if (!llen) logical_recipe = physical[0] == '\t';
    char *part = physical + ((llen && logical_recipe && physical[0] == '\t') ? 1 : 0);
    z = strlen(part);
    int continuation = z && part[z - 1] == '\\';
    if (continuation) part[--z] = 0;
    if (llen && llen + 1 < sizeof logical) logical[llen++] = ' ';
    if (llen + z + 1 >= sizeof logical) die("%s:%d: logical line is too long", path, lineno);
    memcpy(logical + llen, part, z + 1); llen += z;
    if (continuation) continue;

    char *line = logical;
    if (logical_recipe && *line == '\t') line++;
    if (!logical_recipe) line = trim(strip_comment(line));

    /* Conditionals are recognized even in an inactive block. */
    if (!logical_recipe) {
      if (!strncmp(line, "ifdef ", 6) || !strncmp(line, "ifndef ", 7)) {
        if (ncond >= MAX_COND_DEPTH) die("%s:%d: conditional nesting too deep", path, lineno);
        int neg = line[2] == 'n';
        char *name = trim(line + (neg ? 7 : 6));
        int yes = *raw_var(name) != 0;
        conds[ncond++] = neg ? !yes : yes;
        llen = 0; continue;
      }
      if (!strncmp(line, "ifeq", 4) || !strncmp(line, "ifneq", 5)) {
        if (ncond >= MAX_COND_DEPTH) die("%s:%d: conditional nesting too deep", path, lineno);
        int neg = line[2] == 'n';
        char *p = trim(line + (neg ? 5 : 4));
        char *left = p, *right = NULL;
        if (*p == '(') {
          left = ++p; char *comma = strchr(p, ','); char *end = strrchr(p, ')');
          if (comma && end && comma < end) { *comma = 0; *end = 0; right = comma + 1; }
        } else {
          char **w; int n; split_words(p, &w, &n);
          if (n >= 2) { left = w[0]; right = w[1]; }
          char *a1 = expand_depth(left, NULL, 0), *a2 = expand_depth(right ? right : "", NULL, 0);
          int yes = !strcmp(a1, a2); free(a1); free(a2); free_words(w, n);
          conds[ncond++] = neg ? !yes : yes; llen = 0; continue;
        }
        char *a1 = expand_depth(trim(left), NULL, 0), *a2 = expand_depth(trim(right ? right : ""), NULL, 0);
        int yes = !strcmp(a1, a2); free(a1); free(a2);
        conds[ncond++] = neg ? !yes : yes; llen = 0; continue;
      }
      if (!strcmp(line, "else")) {
        if (!ncond) die("%s:%d: unexpected else", path, lineno);
        conds[ncond - 1] = !conds[ncond - 1]; llen = 0; continue;
      }
      if (!strcmp(line, "endif")) {
        if (!ncond) die("%s:%d: unexpected endif", path, lineno);
        ncond--; llen = 0; continue;
      }
    }
    if (!active_conditions(conds, ncond)) { llen = 0; continue; }
    if (!*line) { llen = 0; continue; }

    if (logical_recipe) {
      if (!ngroup) die("%s:%d: recipe commences before first target", path, lineno);
      for (int i = 0; i < ngroup; i++) append_cmd(group[i], line);
      llen = 0; continue;
    }
    ngroup = 0;

    if (!strncmp(line, "include ", 8)) {
      parse_include_list(trim(line + 8), 1, depth); llen = 0; continue;
    }
    if (!strncmp(line, "-include ", 9) || !strncmp(line, "sinclude ", 9)) {
      parse_include_list(trim(line + 9), 0, depth); llen = 0; continue;
    }

    int export_flag = 0;
    if (!strncmp(line, "export ", 7)) { export_flag = 1; line = trim(line + 7); }
    if (parse_assignment(line, 0)) {
      if (export_flag) {
        char *eq = strchr(line, 0); (void)eq; /* name is now the left NUL-terminated field */
        Var *v = find_var(trim(line)); if (v) v->exported = 1;
      }
      llen = 0; continue;
    }
    if (export_flag) {
      char **w; int n; split_words(line, &w, &n);
      for (int i = 0; i < n; i++) ensure_var(w[i])->exported = 1;
      free_words(w, n); llen = 0; continue;
    }

    char *colon = strchr(line, ':');
    if (!colon) die("%s:%d: expected assignment or target rule", path, lineno);
    *colon = 0;
    char *target_text = expand_depth(trim(line), NULL, 0);
    char *rest = trim(colon + 1);
    char *semi = strchr(rest, ';');
    char *inline_cmd = NULL;
    if (semi) { *semi = 0; inline_cmd = trim(semi + 1); }
    char *deps = trim(rest);
    char **targets; int nt;
    split_words(target_text, &targets, &nt);
    if (!nt) die("%s:%d: empty target", path, lineno);
    for (int i = 0; i < nt; i++) {
      Rule *r = strchr(targets[i], '%') ? new_rule(targets[i], 0) : get_rule(targets[i], 0);
      append_deps(r, deps);
      if (inline_cmd && *inline_cmd) append_cmd(r, inline_cmd);
      if (ngroup < MAX_GROUP) group[ngroup++] = r;
      else die("%s:%d: too many targets in one rule", path, lineno);
      if (!first_goal && targets[i][0] != '.' && !strchr(targets[i], '%')) first_goal = xstrdup(targets[i]);
    }
    free_words(targets, nt); free(target_text);
    llen = 0;
  }
  if (ferror(f)) die("%s: read error", path);
  if (llen) die("%s:%d: trailing line continuation", path, lineno);
  if (ncond) die("%s: unterminated conditional", path);
  fclose(f);
}

static void add_builtin_rules(void) {
  if (opt_no_builtin) return;
  Rule *r = new_rule("%.o", 1);
  append_deps(r, "%.c"); append_cmd(r, "$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@");
  r = new_rule("%.wasm", 1);
  append_deps(r, "%.o"); append_cmd(r, "$(LD) $(LDFLAGS) $< $(LDLIBS) -o $@");
}

static int is_phony(const char *target) {
  Rule *p = find_explicit(".PHONY");
  if (!p) return 0;
  char *x = expand_depth(p->deps, NULL, 0);
  char **w; int n, hit = 0;
  split_words(x, &w, &n);
  for (int i = 0; i < n; i++) if (!strcmp(w[i], target)) { hit = 1; break; }
  free_words(w, n); free(x);
  return hit;
}

static Rule *find_pattern(const char *target, char **stem) {
  for (int i = 0; i < nrules; i++)
    if (strchr(rules[i].target, '%') && pattern_match(rules[i].target, target, stem)) return &rules[i];
  return NULL;
}

static Node *get_node(const char *name) {
  for (int i = 0; i < nnodes; i++) if (!strcmp(nodes[i].name, name)) return &nodes[i];
  if (nnodes >= MAX_NODES) die("dependency graph is too large (limit %d)", MAX_NODES);
  Node *n = &nodes[nnodes++]; memset(n, 0, sizeof *n); n->name = xstrdup(name); return n;
}

static int expand_dependencies(Rule *r, const char *stem, Dep *deps, int max) {
  Auto a = {0}; a.stem = stem;
  char *x = expand_depth(r ? r->deps : "", &a, 0);
  char **w; int n, out = 0, order = 0;
  split_words(x, &w, &n);
  for (int i = 0; i < n; i++) {
    if (!strcmp(w[i], "|")) { order = 1; continue; }
    char *name;
    if (stem && strchr(w[i], '%')) {
      const char *pct = strchr(w[i], '%'); Buf b; binit(&b);
      bputn(&b, w[i], (size_t)(pct - w[i])); bputs(&b, stem); bputs(&b, pct + 1); name = b.s;
    } else name = xstrdup(w[i]);
    if (strpbrk(name, "*?[")) {
      glob_t g; memset(&g, 0, sizeof g);
      if (glob(name, 0, NULL, &g) == 0) {
        for (size_t j = 0; j < g.gl_pathc; j++) {
          if (out >= max) die("too many prerequisites");
          deps[out].name = xstrdup(g.gl_pathv[j]); deps[out++].order_only = order;
        }
        free(name); globfree(&g); continue;
      }
      globfree(&g);
    }
    if (out >= max) die("too many prerequisites");
    deps[out].name = name; deps[out++].order_only = order;
  }
  free_words(w, n); free(x);
  return out;
}

static char *join_deps(Dep *deps, int n, int newer_only, FileTime target_time) {
  Buf b; binit(&b); int first = 1;
  for (int i = 0; i < n; i++) {
    if (newer_only && deps[i].order_only) continue;
    FileTime mt = {0};
    if (newer_only && (!file_mtime(deps[i].name, &mt) ||
                       file_time_compare(mt, target_time) < 0)) continue;
    int duplicate = 0;
    char **old; int no;
    split_words(b.s, &old, &no);
    for (int j = 0; j < no; j++) if (!strcmp(old[j], deps[i].name)) duplicate = 1;
    free_words(old, no);
    if (!duplicate) join_word(&b, deps[i].name, &first);
  }
  return b.s;
}

static void export_variables(void) {
  for (int i = 0; i < nvars; i++) if (vars[i].exported) {
    char *v = vars[i].simple ? xstrdup(vars[i].value) : expand_depth(vars[i].value, NULL, 0);
    setenv(vars[i].name, v, 1); free(v);
  }
}

static char *strip_recipe_comment(char *s) {
  return strip_comment(s);
}

static void print_slop_capture(const char *data, int length) {
  static const char banner[] = "\033[1mslop\033[0m — the piodide shell · type 'help'\n";
  static const char prompt[] = "\033[35mslop\033[0m \033[36m";
  static const char failure[] = "\033[2m↳ exit ";
  static const char prompt_end[] = "\033[0m ❯ ";
  int i = 0;
  while (i < length) {
    if (i + (int)sizeof banner - 1 <= length &&
        !memcmp(data + i, banner, sizeof banner - 1)) {
      i += (int)sizeof banner - 1; continue;
    }
    if (i + (int)sizeof prompt - 1 <= length &&
        !memcmp(data + i, prompt, sizeof prompt - 1)) {
      const char *end = NULL;
      for (int j = i + (int)sizeof prompt - 1;
           j + (int)sizeof prompt_end - 1 <= length; j++)
        if (!memcmp(data + j, prompt_end, sizeof prompt_end - 1)) {
          end = data + j + sizeof prompt_end - 1; break;
        }
      if (end) {
        i = (int)(end - data);
        if (i + 1 == length && data[i] == '\n') i++;
        continue;
      }
    }
    if (i + (int)sizeof failure - 1 <= length &&
        !memcmp(data + i, failure, sizeof failure - 1)) {
      while (i < length && data[i++] != '\n') {}
      continue;
    }
    fputc((unsigned char)data[i++], stdout);
  }
}

extern char **environ;

static char *recipe_environment(int *length) {
  size_t total = 1;
  for (char **e = environ; e && *e; e++) total += strlen(*e) + 1;
  if (total > 65536) return NULL;
  char *blob = xmalloc(total); size_t used = 0;
  for (char **e = environ; e && *e; e++) { size_t n = strlen(*e) + 1; memcpy(blob + used, *e, n); used += n; }
  blob[used++] = 0; *length = (int)used; return blob;
}

static int run_recipe(const char *command) {
  const char *cwd = getenv("PWD");
  if (!cwd || cwd[0] != '/') cwd = "/home/web";
  Buf input; binit(&input); bputs(&input, command); bputc(&input, '\n');
  static const char blob[] = "/bin/slop\0-s\0\0";
  const int capture_cap = 1024 * 1024;
  char *capture = xmalloc(capture_cap);
  int capture_len = 0;
  slop_io io; memset(&io, 0, sizeof io);
  io.stdin_data = input.s; io.stdin_len = (int)input.len;
  io.capture = capture; io.capture_cap = capture_cap; io.capture_len = &capture_len;
  int env_len = 0; char *env_blob = recipe_environment(&env_len);
  if (!env_blob) { free(capture); free(input.s); return 2; }
  io.env_data = env_blob; io.env_len = env_len;
  int rc = piodide_spawn("/bin/slop", blob, cwd, &io);
  free(env_blob);
  int shown = capture_len > capture_cap ? capture_cap : capture_len;
  print_slop_capture(capture, shown);
  if (capture_len > capture_cap)
    fprintf(stderr, "%s: recipe output truncated at %d bytes\n", program, capture_cap);
  free(capture); free(input.s);
  return rc;
}

static int build(const char *target) {
  Node *node = get_node(target);
  if (node->state == 2) return node->failed ? -1 : node->updated;
  if (node->state == 1) { fprintf(stderr, "%s: circular dependency involving '%s'\n", program, target); node->failed = 1; return -1; }
  node->state = 1;

  Rule *r = find_explicit(target);
  char *stem = NULL;
  if (!r) r = find_pattern(target, &stem);
  int phony = is_phony(target);
  FileTime before = {0};
  int exists = file_mtime(target, &before);
  if (!r && !exists && !phony) {
    fprintf(stderr, "%s: *** No rule to make target '%s'.  Stop.\n", program, target);
    node->failed = 1; node->state = 2; errors++; free(stem); return -1;
  }

  Dep deps[MAX_DEPS];
  int nd = expand_dependencies(r, stem, deps, MAX_DEPS);
  int dep_failed = 0, need = opt_always || phony || !exists;
  for (int i = 0; i < nd; i++) {
    int changed = build(deps[i].name);
    if (changed < 0) dep_failed = 1;
    else if (!deps[i].order_only && changed) need = 1;
    FileTime mt;
    if (!deps[i].order_only && file_mtime(deps[i].name, &mt) &&
        (!exists || file_time_compare(mt, before) >= 0)) need = 1;
    if (dep_failed && !opt_keep) break;
  }
  if (dep_failed) {
    node->failed = 1; node->state = 2;
    for (int i = 0; i < nd; i++) free(deps[i].name);
    free(stem); return -1;
  }

  if (need && opt_question) {
    if (phony || opt_touch || (r && r->ncmd)) query_needed = 1;
    node->updated = 1;
  }
  else if (need && opt_touch && !phony) {
    if (!opt_silent) printf("touch %s\n", target);
    FILE *tf = fopen(target, "r+b");
    if (!tf && errno == ENOENT) tf = fopen(target, "w+b");
    int touch_failed = tf == NULL;
    int touch_errno = errno;
    if (!touch_failed) {
      struct stat st;
      if (fstat(fileno(tf), &st)) { touch_failed = 1; touch_errno = errno; }
      else {
        if (st.st_size > 0) {
          int c = fgetc(tf);
          if (c == EOF || fseek(tf, 0, SEEK_SET) || fputc(c, tf) == EOF || fflush(tf)) {
            touch_failed = 1; touch_errno = errno ? errno : EIO;
          }
        } else {
          if (fputc(0, tf) == EOF || fflush(tf) || ftruncate(fileno(tf), 0)) {
            touch_failed = 1; touch_errno = errno ? errno : EIO;
          }
        }
      }
      if (fclose(tf) && !touch_failed) { touch_failed = 1; touch_errno = errno; }
    }
    if (touch_failed) {
      fprintf(stderr, "%s: cannot touch '%s': %s\n", program, target, strerror(touch_errno));
      node->failed = 1; errors++;
    } else {
      node->updated = 1;
    }
  } else if (need && r && r->ncmd) {
    char *all = join_deps(deps, nd, 0, before);
    char *newer = join_deps(deps, nd, 1, before);
    Auto a = {target, nd ? deps[0].name : "", all, newer, stem ? stem : ""};
    for (int i = 0; i < r->ncmd; i++) {
      char *cmd = expand_depth(r->cmds[i], &a, 0);
      char *p = cmd; int quiet = 0, ignore = 0, force = 0;
      while (*p == '@' || *p == '-' || *p == '+') {
        if (*p == '@') quiet = 1; else if (*p == '-') ignore = 1; else force = 1;
        p++;
      }
      while (*p == ' ' || *p == '\t') p++;
      strip_recipe_comment(p);
      if (!*p) { free(cmd); continue; }
      if (!opt_silent && !quiet) printf("%s\n", p);
      int rc = 0;
      if (!opt_dry || force) { export_variables(); rc = run_recipe(p); }
      if (rc && !ignore) {
        fprintf(stderr, "%s: *** [%s] Error %d\n", program, target, rc);
        node->failed = 1; errors++; free(cmd); break;
      }
      if (rc && ignore) fprintf(stderr, "%s: [%s] Error %d (ignored)\n", program, target, rc);
      free(cmd);
    }
    free(all); free(newer);
    if (!node->failed) node->updated = 1;
  } else if (need) {
    /* A phony/aggregate target without a recipe is still considered updated. */
    node->updated = 1;
  }

  file_mtime(target, &node->mtime);
  node->state = 2;
  for (int i = 0; i < nd; i++) free(deps[i].name);
  free(stem);
  return node->failed ? -1 : node->updated;
}

static void print_database(void) {
  puts("# Variables");
  for (int i = 0; i < nvars; i++) printf("%s %s %s\n", vars[i].name, vars[i].simple ? ":=" : "=", vars[i].value);
  puts("\n# Rules");
  for (int i = 0; i < nrules; i++) {
    printf("%s: %s\n", rules[i].target, rules[i].deps);
    for (int j = 0; j < rules[i].ncmd; j++) printf("\t%s\n", rules[i].cmds[j]);
  }
}

static void normalize_path(char *path) {
  char *copy = xstrdup(path), *parts[512];
  int n = 0;
  for (char *p = strtok(copy, "/"); p && n < 512; p = strtok(NULL, "/")) {
    if (!strcmp(p, ".")) continue;
    if (!strcmp(p, "..")) { if (n) n--; continue; }
    parts[n++] = p;
  }
  char *o = path; *o++ = '/';
  for (int i = 0; i < n; i++) {
    size_t z = strlen(parts[i]); memcpy(o, parts[i], z); o += z;
    if (i + 1 < n) *o++ = '/';
  }
  *o = 0; free(copy);
}

/* WASI has no chdir. Re-spawn make once in the requested host-side cwd, with
 * all -C options removed, so libc and every recipe see the correct directory. */
static int reexec_for_directory(int argc, char **argv) {
  char cwd[PATH_CAP];
  const char *pwd = getenv("PWD");
  snprintf(cwd, sizeof cwd, "%s", pwd && *pwd == '/' ? pwd : "/home/web");
  int found = 0;
  Buf blob; binit(&blob); bputs(&blob, "/bin/make"); bputc(&blob, 0);
  for (int i = 1; i < argc; i++) {
    const char *dir = NULL;
    if (!strcmp(argv[i], "-C") || !strcmp(argv[i], "--directory")) {
      if (++i >= argc) die("option -C needs an argument");
      dir = argv[i]; found = 1;
    } else if (!strncmp(argv[i], "-C", 2) && argv[i][2]) {
      dir = argv[i] + 2; found = 1;
    } else if (!strncmp(argv[i], "--directory=", 12)) {
      dir = argv[i] + 12; found = 1;
    }
    if (dir) {
      char next[PATH_CAP];
      if (*dir == '/') snprintf(next, sizeof next, "%s", dir);
      else snprintf(next, sizeof next, "%s/%s", cwd, dir);
      if (strlen(next) >= sizeof next - 1) die("directory path is too long");
      normalize_path(next); snprintf(cwd, sizeof cwd, "%s", next);
    } else {
      bputs(&blob, argv[i]); bputc(&blob, 0);
    }
  }
  if (!found) { free(blob.s); return -1; }
  struct stat st;
  if (stat(cwd, &st) || !S_ISDIR(st.st_mode)) die("%s: no such directory", cwd);
  bputc(&blob, 0);
  slop_io io; memset(&io, 0, sizeof io);
  setenv("PWD", cwd, 1);
  int rc = piodide_spawn("/bin/make", blob.s, cwd, &io);
  free(blob.s); return rc;
}

static void usage(void) {
  printf("pmake 1.0 - make for piodide/slop\n"
         "Usage: make [options] [VAR=value] [targets]\n"
         "  -C DIR   change directory       -f FILE  read FILE\n"
         "  -n       dry run                -s       silent\n"
         "  -B       always build           -q       question mode\n"
         "  -t       touch targets          -k       keep going\n"
         "  -r       no built-in rules      -p       print database\n"
         "  -j[N]    accepted; builds remain serial in the browser\n"
         "Freshness: full filesystem subsecond mtimes; equal normal prerequisites are stale\n");
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  if (argc && argv[0] && *argv[0]) {
    const char *slash = strrchr(argv[0], '/');
    program = slash ? slash + 1 : argv[0];
  }
  int directory_rc = reexec_for_directory(argc, argv);
  if (directory_rc >= 0) return directory_rc;
  char *makefile = NULL;
  char **goals = xmalloc((size_t)(argc + 1) * sizeof *goals); int ngoals = 0;
  int print_db = 0;

  /* Command-line assignments are installed first and locked against makefiles. */
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] == '-' || !strchr(argv[i], '=')) continue;
    char *a = xstrdup(argv[i]);
    if (!parse_assignment(a, 1)) die("invalid command-line assignment '%s'", argv[i]);
    free(a);
  }

  for (int i = 1; i < argc; i++) {
    char *a = argv[i];
    if (a[0] != '-' && strchr(a, '=')) continue;
    if (!strcmp(a, "--version")) { puts("pmake 1.0 (piodide native)"); return 0; }
    if (!strcmp(a, "--help") || !strcmp(a, "-h")) { usage(); return 0; }
    if (!strcmp(a, "--no-print-directory")) continue;
    if (!strcmp(a, "-n") || !strcmp(a, "--just-print")) opt_dry = 1;
    else if (!strcmp(a, "-s") || !strcmp(a, "--silent")) opt_silent = 1;
    else if (!strcmp(a, "-B") || !strcmp(a, "--always-make")) opt_always = 1;
    else if (!strcmp(a, "-q") || !strcmp(a, "--question")) opt_question = 1;
    else if (!strcmp(a, "-t") || !strcmp(a, "--touch")) opt_touch = 1;
    else if (!strcmp(a, "-k") || !strcmp(a, "--keep-going")) opt_keep = 1;
    else if (!strcmp(a, "-r") || !strcmp(a, "--no-builtin-rules")) opt_no_builtin = 1;
    else if (!strcmp(a, "-p") || !strcmp(a, "--print-data-base")) print_db = 1;
    else if (!strcmp(a, "-f") || !strcmp(a, "--file")) {
      if (++i >= argc) die("option %s needs an argument", a); makefile = argv[i];
    } else if (!strncmp(a, "-f", 2) && a[2]) makefile = a + 2;
    else if (!strcmp(a, "-C") || !strcmp(a, "--directory")) {
      /* -C is handled by the early re-exec pass below. */
      if (++i >= argc) die("option %s needs an argument", a);
    } else if (!strncmp(a, "-C", 2) && a[2]) {
      /* handled by the early re-exec pass */
    } else if (!strncmp(a, "-j", 2)) {
      if (!a[2] && i + 1 < argc && isdigit((unsigned char)argv[i + 1][0])) i++;
    } else if (a[0] == '-') die("unknown option '%s' (try --help)", a);
    else goals[ngoals++] = a;
  }

  set_var("CC", "cc", 0, 0, 1, 0);
  set_var("LD", "ld", 0, 0, 1, 0);
  set_var("CPPFLAGS", "", 0, 0, 1, 0);
  set_var("CFLAGS", "", 0, 0, 1, 0);
  set_var("LDFLAGS", "", 0, 0, 1, 0);
  set_var("LDLIBS", "", 0, 0, 1, 0);
  set_var("MAKE", "make", 0, 0, 1, 0);

  if (makefile) parse_file(makefile, 1, 0);
  else if (access("GNUmakefile", R_OK) == 0) parse_file("GNUmakefile", 1, 0);
  else if (access("makefile", R_OK) == 0) parse_file("makefile", 1, 0);
  else if (access("Makefile", R_OK) == 0) parse_file("Makefile", 1, 0);
  else if (!ngoals) die("no makefile found");
  add_builtin_rules();
  if (print_db) print_database();

  const char *dg = raw_var(".DEFAULT_GOAL");
  if (!ngoals) {
    if (*dg) goals[ngoals++] = (char *)dg;
    else if (first_goal) goals[ngoals++] = first_goal;
    else if (!print_db) die("no targets specified and no default target");
  }
  for (int i = 0; i < ngoals; i++) {
    int rc = build(goals[i]);
    if (rc < 0 && !opt_keep) break;
  }
  free(goals);
  if (errors) return 2;
  if (opt_question && query_needed) return 1;
  return 0;
}
