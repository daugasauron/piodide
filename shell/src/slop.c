/*
 * slop - a small build-oriented shell for the piodide browser runtime.
 *
 * Provides: scripts and -c, quoting and parameter expansion, arithmetic
 * expansion, globbing, command lists, buffered pipes, redirects (including
 * stderr), useful builtins, line-oriented if/for/while/case blocks, and
 * shell functions.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <glob.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Spawn ABI v3, implemented by the browser host. */
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

extern int piodide_spawn(const char *path, const char *argv_blob, const char *cwd,
                         slop_io *io);

/* Forward declaration for positional params in arithmetic */
static const char *positional(int index);

#define MAX_ARGS 128
#define MAX_CMDS 32
#define MAX_LISTS 128
#define MAX_LINES 4096
#define LINE_CAP 65536
#define PATH_CAP 4096
#define PIPE_CAP (1024 * 1024)
#define SCRIPT_CAP (2 * 1024 * 1024)
#define LOOP_LIMIT 10000
#define ENV_CAP 65536
#define MAX_FUNCS 64

typedef struct { char *s; size_t len, cap; } Buf;
typedef struct { char *text; int quoted; } Token;
typedef struct { char *name, *value; int was_set; } SavedAssignment;
typedef struct { SavedAssignment items[MAX_ARGS]; int count; } AssignmentScope;
typedef struct {
  char *argv[MAX_ARGS];
  int argc;
  char *in_file;
  char *out_file;
  int append;
  char *err_file;
  int err_append;
  int err_to_out;
} Command;
typedef enum { COND_ALWAYS, COND_AND, COND_OR } Condition;
typedef struct { char *text; Condition condition; } ListItem;
typedef struct { char *name; char *body; } Function;

static char cwd[PATH_CAP] = "/home/web";
static int last_status;
static int shell_argc;
static char **shell_argv;
static const char *shell_name = "slop";
static int exit_requested;
static int exit_status;
static int flow_signal;
static int option_errexit, option_xtrace;
static int suppress_errexit;
static int capture_active, capture_length;
static char *capture_buffer;
static char parse_error[256];
static char *pipe_a, *pipe_b, *redirect_input, *spawn_env;
static Function functions[MAX_FUNCS];
static int func_count;

static int execute_script(char *text);
static int execute_command_list(char *line);

static void *xmalloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) { fprintf(stderr, "slop: out of memory\n"); exit(2); }
  return p;
}

static char *xstrdup(const char *s) {
  char *p = strdup(s ? s : "");
  if (!p) { fprintf(stderr, "slop: out of memory\n"); exit(2); }
  return p;
}

static void binit(Buf *b) {
  b->cap = 128; b->len = 0; b->s = xmalloc(b->cap); b->s[0] = 0;
}
static void bgrow(Buf *b, size_t add) {
  if (b->len + add + 1 <= b->cap) return;
  while (b->len + add + 1 > b->cap) {
    if (b->cap >= SCRIPT_CAP * 8u) { fprintf(stderr, "slop: expansion is too large\n"); exit(2); }
    b->cap *= 2;
  }
  b->s = realloc(b->s, b->cap);
  if (!b->s) { fprintf(stderr, "slop: out of memory\n"); exit(2); }
}
static void bputn(Buf *b, const char *s, size_t n) { bgrow(b, n); memcpy(b->s + b->len, s, n); b->len += n; b->s[b->len] = 0; }
static void bputs(Buf *b, const char *s) { bputn(b, s, strlen(s)); }
static void bputc(Buf *b, char c) { bputn(b, &c, 1); }

static char *trim(char *s) {
  while (isspace((unsigned char)*s)) s++;
  char *e = s + strlen(s);
  while (e > s && isspace((unsigned char)e[-1])) *--e = 0;
  return s;
}

static int valid_name_n(const char *s, size_t n) {
  if (!n || !(s[0] == '_' || isalpha((unsigned char)s[0]))) return 0;
  for (size_t i = 1; i < n; i++)
    if (!(s[i] == '_' || isalnum((unsigned char)s[i]))) return 0;
  return 1;
}

static int assignment_word(const char *s, const char **eq_out) {
  const char *eq = strchr(s, '=');
  if (!eq || !valid_name_n(s, (size_t)(eq - s))) return 0;
  if (eq_out) *eq_out = eq;
  return 1;
}

/* --------------------------- function table ----------------------------- */

static Function *find_function(const char *name) {
  for (int i = 0; i < func_count; i++)
    if (!strcmp(functions[i].name, name)) return &functions[i];
  return NULL;
}

static void define_function(const char *name, const char *body) {
  Function *f = find_function(name);
  if (f) { free(f->body); f->body = xstrdup(body); return; }
  if (func_count >= MAX_FUNCS) { fprintf(stderr, "slop: too many functions\n"); return; }
  functions[func_count].name = xstrdup(name);
  functions[func_count].body = xstrdup(body);
  func_count++;
}

/* ----------------------------- path handling ----------------------------- */

static void normalize(char *path) {
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

static int resolve_path(const char *in, char *out) {
  int rc;
  if (!in || !*in) return 0;
  if (*in == '/') rc = snprintf(out, PATH_CAP, "%s", in);
  else if (!strcmp(cwd, "/")) rc = snprintf(out, PATH_CAP, "/%s", in);
  else rc = snprintf(out, PATH_CAP, "%s/%s", cwd, in);
  if (rc < 0 || rc >= PATH_CAP) return 0;
  normalize(out); return 1;
}

static int is_dir(const char *path) {
  struct stat st; return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}
static int is_reg(const char *path) {
  struct stat st; return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

static int find_command(const char *name, char *out) {
  if (strchr(name, '/')) return resolve_path(name, out) && is_reg(out);
  const char *path = getenv("PATH");
  if (!path || !*path) path = "/bin";
  char *copy = xstrdup(path);
  int found = 0;
  for (char *d = strtok(copy, ":"); d && !found; d = strtok(NULL, ":")) {
    if (*d == '/') snprintf(out, PATH_CAP, "%s/%s", d, name);
    else snprintf(out, PATH_CAP, "%s/%s/%s", cwd, d, name);
    normalize(out);
    if (is_reg(out)) found = 1;
  }
  free(copy); return found;
}

/* ------------------------- expansion and tokenizer ----------------------- */

static const char *positional(int index) {
  if (index == 0) return shell_name;
  return index > 0 && index <= shell_argc ? shell_argv[index - 1] : "";
}

static void expand_text(Buf *out, const char *text, int depth);
static char *capture_command(const char *text);

static void append_all_args(Buf *out) {
  for (int i = 0; i < shell_argc; i++) {
    if (i) bputc(out, ' ');
    bputs(out, shell_argv[i]);
  }
}

static void expand_parameter(Buf *out, const char **pp, int depth) {
  const char *p = *pp;
  char temp[64], name[128];
  const char *value = "";
  if (*p == '?') {
    snprintf(temp, sizeof temp, "%d", last_status); value = temp; p++;
  } else if (*p == '#') {
    snprintf(temp, sizeof temp, "%d", shell_argc); value = temp; p++;
  } else if (*p == '*' || *p == '@') {
    append_all_args(out); p++; *pp = p; return;
  } else if (isdigit((unsigned char)*p)) {
    int n = 0; while (isdigit((unsigned char)*p)) n = n * 10 + (*p++ - '0');
    value = positional(n);
  } else if (*p == '{') {
    p++;
    const char *start = p;
    while (*p && *p != '}' && *p != ':' && *p != '-' && *p != '+' &&
           *p != '=' && *p != '?') p++;
    size_t n = (size_t)(p - start);
    if (n >= sizeof name) n = sizeof name - 1;
    memcpy(name, start, n); name[n] = 0;
    int colon = 0; char op = 0;
    if (*p == ':') { colon = 1; p++; }
    if (strchr("-+=?", *p)) op = *p++;
    const char *alt_start = p;
    while (*p && *p != '}') p++;
    if (*p != '}') { snprintf(parse_error, sizeof parse_error, "unterminated ${...}"); *pp = p; return; }
    size_t alt_len = (size_t)(p - alt_start); p++;
    if (name[0] && strspn(name, "0123456789") == strlen(name)) value = positional(atoi(name));
    else if (!strcmp(name, "#")) { snprintf(temp, sizeof temp, "%d", shell_argc); value = temp; }
    else { const char *v = getenv(name); value = v ? v : ""; }
    int set = getenv(name) != NULL;
    if (name[0] && isdigit((unsigned char)name[0])) set = atoi(name) <= shell_argc;
    int missing = !set || (colon && !*value);
    int use_alt = (op == '-' && missing) || (op == '+' && !missing);
    if (op == '=' && missing) {
      char *alt = xmalloc(alt_len + 1); memcpy(alt, alt_start, alt_len); alt[alt_len] = 0;
      Buf expanded; binit(&expanded); expand_text(&expanded, alt, depth + 1);
      if (valid_name_n(name, strlen(name))) setenv(name, expanded.s, 1);
      value = valid_name_n(name, strlen(name)) ? getenv(name) : expanded.s;
      bputs(out, value ? value : ""); free(expanded.s); free(alt); *pp = p; return;
    }
    if (op == '?' && missing) {
      char *msg = xmalloc(alt_len + 1); memcpy(msg, alt_start, alt_len); msg[alt_len] = 0;
      snprintf(parse_error, sizeof parse_error, "%s: %s", name, *msg ? msg : "parameter not set");
      free(msg); *pp = p; return;
    }
    if (use_alt) {
      char *alt = xmalloc(alt_len + 1); memcpy(alt, alt_start, alt_len); alt[alt_len] = 0;
      expand_text(out, alt, depth + 1); free(alt);
    } else if (!(op == '+' && missing)) bputs(out, value);
    *pp = p; return;
  } else if (*p == '_' || isalpha((unsigned char)*p)) {
    size_t n = 0;
    while (*p == '_' || isalnum((unsigned char)*p)) {
      if (n + 1 < sizeof name) name[n++] = *p;
      p++;
    }
    name[n] = 0; const char *v = getenv(name); value = v ? v : "";
  } else {
    bputc(out, '$'); *pp = p; return;
  }
  bputs(out, value); *pp = p;
}

static void expand_substitution(Buf *out, const char **pp) {
  const char *p = *pp;
  if (*p != '(') return;
  const char *start = ++p; int level = 1, sq = 0, dq = 0;
  while (*p && level) {
    if (*p == '\\' && p[1]) { p += 2; continue; }
    if (*p == '\'' && !dq) sq = !sq;
    else if (*p == '"' && !sq) dq = !dq;
    else if (!sq && !dq && *p == '(') level++;
    else if (!sq && !dq && *p == ')') level--;
    if (level) p++;
  }
  if (level) { snprintf(parse_error, sizeof parse_error, "unterminated command substitution"); *pp = p; return; }
  size_t n = (size_t)(p - start); char *cmd = xmalloc(n + 1);
  memcpy(cmd, start, n); cmd[n] = 0; p++;
  char *value = capture_command(cmd);
  if (value) { bputs(out, value); free(value); }
  free(cmd); *pp = p;
}

/* ------------------------- arithmetic expansion -------------------------- */

static long eval_arith_expr(const char **pp, int depth);

static long eval_arith_atom(const char **pp, int depth) {
  const char *p = *pp;
  while (isspace((unsigned char)*p)) p++;
  long val;
  if (*p == '(') {
    p++; val = eval_arith_expr(&p, depth + 1);
    while (isspace((unsigned char)*p)) p++;
    if (*p == ')') p++;
  } else if (*p == '$') {
    p++;
    if (*p == '(' && p[1] == '(') {
      p += 2; val = eval_arith_expr(&p, depth + 1);
      while (*p == ')') p++;
    } else if (*p == '{') {
      p++; char name[128]; size_t n = 0;
      while (*p && *p != '}' && n + 1 < sizeof name) name[n++] = *p++;
      name[n] = 0; if (*p == '}') p++;
      const char *v;
      if (name[0] && isdigit((unsigned char)name[0])) v = positional(atoi(name));
      else v = getenv(name);
      val = v ? strtol(v, NULL, 0) : 0;
    } else if (isdigit((unsigned char)*p)) {
      int n = 0; while (isdigit((unsigned char)*p)) n = n * 10 + (*p++ - '0');
      const char *v = positional(n); val = v ? strtol(v, NULL, 0) : 0;
    } else {
      char name[128]; size_t n = 0;
      while ((*p == '_' || isalnum((unsigned char)*p)) && n + 1 < sizeof name) name[n++] = *p++;
      name[n] = 0;
      const char *v = getenv(name); val = v ? strtol(v, NULL, 0) : 0;
    }
  } else if (*p == '_' || isalpha((unsigned char)*p)) {
    char name[128]; size_t n = 0;
    while ((*p == '_' || isalnum((unsigned char)*p)) && n + 1 < sizeof name) name[n++] = *p++;
    name[n] = 0;
    const char *v = getenv(name); val = v ? strtol(v, NULL, 0) : 0;
  } else if (isdigit((unsigned char)*p)) {
    val = strtol(p, (char **)&p, 0);
  } else {
    val = 0;
  }
  *pp = p; return val;
}

static long eval_arith_unary(const char **pp, int depth) {
  const char *p = *pp;
  while (isspace((unsigned char)*p)) p++;
  if (*p == '-') { p++; return -eval_arith_unary(&p, depth); }
  if (*p == '+') { p++; return eval_arith_unary(&p, depth); }
  if (*p == '!' && !isalnum((unsigned char)p[1]) && p[1] != '_') { p++; return !eval_arith_unary(&p, depth); }
  if (*p == '~' && !isalnum((unsigned char)p[1]) && p[1] != '_') { p++; return ~eval_arith_unary(&p, depth); }
  long v = eval_arith_atom(&p, depth); *pp = p; return v;
}

static long eval_arith_mul(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_unary(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '*' && p[1] != '*') { p++; v *= eval_arith_unary(&p, depth); }
    else if (*p == '/') { p++; long r = eval_arith_unary(&p, depth); v = r ? v / r : 0; }
    else if (*p == '%') { p++; long r = eval_arith_unary(&p, depth); v = r ? v % r : 0; }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_add(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_mul(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '+' && p[1] != '+') { p++; v += eval_arith_mul(&p, depth); }
    else if (*p == '-' && p[1] != '-') { p++; v -= eval_arith_mul(&p, depth); }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_shift(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_add(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '<' && p[1] == '<') { p += 2; v <<= eval_arith_add(&p, depth); }
    else if (*p == '>' && p[1] == '>') { p += 2; v >>= eval_arith_add(&p, depth); }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_cmp(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_shift(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '<' && p[1] == '=') { p += 2; v = (v <= eval_arith_shift(&p, depth)); }
    else if (*p == '>' && p[1] == '=') { p += 2; v = (v >= eval_arith_shift(&p, depth)); }
    else if (*p == '<' && p[1] != '<') { p++; v = (v < eval_arith_shift(&p, depth)); }
    else if (*p == '>' && p[1] != '>') { p++; v = (v > eval_arith_shift(&p, depth)); }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_eq(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_cmp(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '=' && p[1] == '=') { p += 2; v = (v == eval_arith_cmp(&p, depth)); }
    else if (*p == '!' && p[1] == '=') { p += 2; v = (v != eval_arith_cmp(&p, depth)); }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_band(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_eq(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '&' && p[1] != '&') { p++; v &= eval_arith_eq(&p, depth); }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_bxor(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_band(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '^') { p++; v ^= eval_arith_band(&p, depth); }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_bor(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_bxor(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '|' && p[1] != '|') { p++; v |= eval_arith_bxor(&p, depth); }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_and(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_bor(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '&' && p[1] == '&') { p += 2; long r = eval_arith_bor(&p, depth); v = v && r; }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_or(const char **pp, int depth) {
  const char *p = *pp; long v = eval_arith_and(&p, depth);
  for (;;) {
    while (isspace((unsigned char)*p)) p++;
    if (*p == '|' && p[1] == '|') { p += 2; long r = eval_arith_and(&p, depth); v = v || r; }
    else break;
  }
  *pp = p; return v;
}

static long eval_arith_expr(const char **pp, int depth) {
  if (depth > 16) return 0;
  const char *p = *pp;
  while (isspace((unsigned char)*p)) p++;
  if (*p == '_' || isalpha((unsigned char)*p)) {
    const char *save = p;
    char name[128]; size_t nl = 0;
    while (*p == '_' || isalnum((unsigned char)*p)) { if (nl + 1 < sizeof name) name[nl++] = *p; p++; }
    name[nl] = 0;
    while (isspace((unsigned char)*p)) p++;
    char compound = 0;
    if (*p && p[1] == '=' && (*p == '+' || *p == '-' || *p == '*' || *p == '/' ||
         *p == '%' || *p == '&' || *p == '|' || *p == '^')) { compound = *p; p += 2; }
    else if (*p == '=' && p[1] != '=') { compound = 0; p++; }
    else { p = save; goto no_assign; }
    long rhs = eval_arith_expr(&p, depth + 1);
    long cur = 0; const char *old = getenv(name);
    if (old) cur = strtol(old, NULL, 0);
    long val;
    switch (compound) {
      case '+': val = cur + rhs; break; case '-': val = cur - rhs; break;
      case '*': val = cur * rhs; break; case '/': val = rhs ? cur / rhs : 0; break;
      case '%': val = rhs ? cur % rhs : 0; break; case '&': val = cur & rhs; break;
      case '|': val = cur | rhs; break; case '^': val = cur ^ rhs; break;
      default: val = rhs; break;
    }
    char buf[32]; snprintf(buf, sizeof buf, "%ld", val);
    if (valid_name_n(name, strlen(name))) setenv(name, buf, 1);
    *pp = p; return val;
  }
no_assign:;
  long v = eval_arith_or(&p, depth);
  while (isspace((unsigned char)*p)) p++;
  if (*p == '?') {
    p++; long a = eval_arith_expr(&p, depth + 1);
    while (isspace((unsigned char)*p)) p++;
    if (*p == ':') p++;
    long b = eval_arith_expr(&p, depth + 1);
    v = v ? a : b;
  }
  *pp = p; return v;
}

static void expand_text(Buf *out, const char *text, int depth) {
  if (depth > 32) { snprintf(parse_error, sizeof parse_error, "expansion is too deeply nested"); return; }
  const char *p = text;
  while (*p) {
    if (*p == '$') {
      p++;
      if (*p == '$') { bputc(out, '$'); p++; }
      else if (*p == '(' && p[1] == '(') {
        p += 2;
        long val = eval_arith_expr(&p, 0);
        while (*p == ')') p++;
        char buf[32]; snprintf(buf, sizeof buf, "%ld", val);
        bputs(out, buf);
      }
      else if (*p == '(') expand_substitution(out, &p);
      else expand_parameter(out, &p, depth);
    } else if (*p == '\\' && p[1]) {
      p++; bputc(out, *p++);
    } else bputc(out, *p++);
  }
}

static int is_operator_char(char c) { return c == '|' || c == '>' || c == '<'; }

static Token next_token(char **pp, int do_expand) {
  Token t = {0};
  char *p = *pp;
  while (isspace((unsigned char)*p)) p++;
  if (!*p) { *pp = p; return t; }

  /* Handle fd-prefixed redirects: 2>, 2>>, 1>, &>, 2>&1 */
  if (isdigit((unsigned char)*p) || (*p == '&' && p[1] == '>')) {
    if (*p == '&') {
      p++;
      if (*p == '>') {
        p++; int append = 0;
        if (*p == '>') { append = 1; p++; }
        char op[8]; snprintf(op, sizeof op, "&%s", append ? ">>" : ">");
        t.text = xstrdup(op); *pp = p; return t;
      }
      p = *pp + 1;
    } else {
      int fd = *p - '0'; char *peek = p + 1; int append = 0;
      if (*peek == '>' && peek[1] == '>') { append = 1; peek += 2; }
      else if (*peek == '>') { peek++; }
      else if (*peek == '<') { peek++; }
      else goto not_redirect;
      if (*peek == '&') {
        char *dup = peek + 1;
        if (isdigit((unsigned char)*dup)) {
          int target = *dup - '0';
          char op[16]; snprintf(op, sizeof op, "%d>&%d", fd, target);
          p = dup + 1; t.text = xstrdup(op); *pp = p; return t;
        }
      }
      char op[8]; snprintf(op, sizeof op, "%d%s", fd, append ? ">>" : ">");
      p = peek; t.text = xstrdup(op); *pp = p; return t;
    }
  }
not_redirect:;

  if (is_operator_char(*p)) {
    char op[3] = {*p, 0, 0};
    if (*p == '>' && p[1] == '>') { op[1] = '>'; p++; }
    p++; t.text = xstrdup(op); *pp = p; return t;
  }

  Buf b; binit(&b);
  int at_start = 1;
  while (*p && !isspace((unsigned char)*p) && !is_operator_char(*p)) {
    /* Skip $((...)) and $(...) even without expansion to handle > < | inside */
    if (*p == '$' && p[1] == '(' && p[2] == '(') {
      if (!do_expand) {
        p += 3; int dp = 1;
        while (*p && dp) {
          if (*p == '(') dp++;
          else if (*p == ')') { dp--; if (dp == 0 && p[1] == ')') { p++; break; } }
          if (*p) p++;
        }
        if (*p == ')') p++;
        continue;
      }
      p += 2;
      long val = eval_arith_expr((const char **)&p, 0);
      while (*p == ')') p++;
      char abuf[32]; snprintf(abuf, sizeof abuf, "%ld", val);
      bputs(&b, abuf);
      at_start = 0; continue;
    }
    if (*p == '$' && p[1] == '(') {
      if (!do_expand) {
        p += 2; int dp = 1;
        while (*p && dp) {
          if (*p == '\\' && p[1]) { p += 2; continue; }
          if (*p == '(') dp++;
          else if (*p == ')') { dp--; if (dp == 0) { p++; break; } }
          if (*p) p++;
        }
        continue;
      }
      const char *q = p; expand_substitution(&b, &q); p = (char *)q;
      at_start = 0; continue;
    }
    if (*p == '\'') {
      t.quoted = 1; p++;
      while (*p && *p != '\'') bputc(&b, *p++);
      if (*p == '\'') p++; else snprintf(parse_error, sizeof parse_error, "unterminated single quote");
    } else if (*p == '"') {
      t.quoted = 1; p++;
      while (*p && *p != '"') {
        if (*p == '$' && do_expand) {
          p++;
          if (*p == '$') { bputc(&b, '$'); p++; }
          else if (*p == '(' && p[1] == '(') {
            p += 2;
            long val = eval_arith_expr((const char **)&p, 0);
            while (*p == ')') p++;
            char abuf[32]; snprintf(abuf, sizeof abuf, "%ld", val);
            bputs(&b, abuf);
          }
          else if (*p == '(') { const char *q = p; expand_substitution(&b, &q); p = (char *)q; }
          else expand_parameter(&b, (const char **)&p, 0);
        }
        else if (*p == '\\' && (p[1] == '$' || p[1] == '"' || p[1] == '\\')) { p++; bputc(&b, *p++); }
        else bputc(&b, *p++);
      }
      if (*p == '"') p++; else snprintf(parse_error, sizeof parse_error, "unterminated double quote");
    } else if (*p == '\\') {
      t.quoted = 1; p++;
      if (*p) bputc(&b, *p++); else snprintf(parse_error, sizeof parse_error, "trailing backslash");
    } else if (*p == '$' && do_expand) {
      p++;
      if (*p == '$') { bputc(&b, '$'); p++; }
      else if (*p == '(' && p[1] == '(') {
        p += 2;
        long val = eval_arith_expr((const char **)&p, 0);
        while (*p == ')') p++;
        char abuf[32]; snprintf(abuf, sizeof abuf, "%ld", val);
        bputs(&b, abuf);
      }
      else if (*p == '(') { const char *q = p; expand_substitution(&b, &q); p = (char *)q; }
      else expand_parameter(&b, (const char **)&p, 0);
    } else if (*p == '~' && at_start && do_expand) {
      const char *home = getenv("HOME"); bputs(&b, home && *home ? home : "/home/web"); p++;
    } else bputc(&b, *p++);
    at_start = 0;
  }
  t.text = b.s; *pp = p; return t;
}

static void free_command(Command *c) {
  for (int i = 0; i < c->argc; i++) free(c->argv[i]);
  free(c->in_file); free(c->out_file); free(c->err_file); memset(c, 0, sizeof *c);
}

static int append_arg(Command *c, char *word) {
  if (c->argc >= MAX_ARGS - 1) { snprintf(parse_error, sizeof parse_error, "too many arguments"); free(word); return 0; }
  c->argv[c->argc++] = word; c->argv[c->argc] = NULL; return 1;
}

static int append_glob(Command *c, Token t) {
  if (t.quoted || !strpbrk(t.text, "*?[")) return append_arg(c, t.text);
  char pattern[PATH_CAP];
  if (!resolve_path(t.text, pattern)) return append_arg(c, t.text);
  glob_t g; memset(&g, 0, sizeof g);
  if (glob(pattern, 0, NULL, &g) != 0) { globfree(&g); return append_arg(c, t.text); }
  int absolute = t.text[0] == '/';
  size_t prefix = !strcmp(cwd, "/") ? 1 : strlen(cwd) + 1;
  for (size_t i = 0; i < g.gl_pathc; i++) {
    const char *name = g.gl_pathv[i];
    if (!absolute && !strncmp(name, cwd, strlen(cwd)) && name[strlen(cwd)] == '/') name += prefix;
    if (!append_arg(c, xstrdup(name))) { globfree(&g); free(t.text); return 0; }
  }
  globfree(&g); free(t.text); return 1;
}

static int parse_pipeline(char *text, Command *cmds, int expand) {
  memset(cmds, 0, MAX_CMDS * sizeof *cmds); parse_error[0] = 0;
  int n = 0; Command *cur = &cmds[0]; char *p = text;
  for (;;) {
    Token t = next_token(&p, expand);
    if (!t.text) break;
    if (!strcmp(t.text, "|")) {
      free(t.text);
      if (!cur->argc) { snprintf(parse_error, sizeof parse_error, "empty command before |"); return -1; }
      if (++n >= MAX_CMDS) { snprintf(parse_error, sizeof parse_error, "too many pipeline stages"); return -1; }
      cur = &cmds[n]; continue;
    }
    if (t.text[0] >= '0' && t.text[0] <= '9' && strstr(t.text, ">&")) {
      int fd = t.text[0] - '0'; char *amp = strstr(t.text, ">&");
      int target = amp[2] - '0'; free(t.text);
      if (fd == 2 && target == 1) cur->err_to_out = 1;
      continue;
    }
    if (t.text[0] == '&') {
      int append = strstr(t.text, ">>") != NULL; free(t.text);
      Token file = next_token(&p, expand);
      if (!file.text || is_operator_char(file.text[0])) {
        free(file.text); snprintf(parse_error, sizeof parse_error, "redirect needs a file"); return -1;
      }
      free(cur->out_file); cur->out_file = file.text; cur->append = append; cur->err_to_out = 1;
      continue;
    }
    if (t.text[0] >= '0' && t.text[0] <= '9' && (t.text[1] == '>' || t.text[1] == '<')) {
      int fd = t.text[0] - '0'; int append = strstr(t.text, ">>") != NULL;
      int input = t.text[1] == '<'; free(t.text);
      Token file = next_token(&p, expand);
      if (!file.text || is_operator_char(file.text[0])) {
        free(file.text); snprintf(parse_error, sizeof parse_error, "redirect needs a file"); return -1;
      }
      if (fd == 2 && !input) { free(cur->err_file); cur->err_file = file.text; cur->err_append = append; }
      else if (fd == 1 && !input) { free(cur->out_file); cur->out_file = file.text; cur->append = append; }
      else if (input) { free(cur->in_file); cur->in_file = file.text; }
      else free(file.text);
      continue;
    }
    if (!strcmp(t.text, ">") || !strcmp(t.text, ">>") || !strcmp(t.text, "<")) {
      int input = t.text[0] == '<', append = t.text[1] == '>'; free(t.text);
      Token file = next_token(&p, expand);
      if (!file.text || is_operator_char(file.text[0])) {
        free(file.text); snprintf(parse_error, sizeof parse_error, "redirect needs a file"); return -1;
      }
      if (input) { free(cur->in_file); cur->in_file = file.text; }
      else { free(cur->out_file); cur->out_file = file.text; cur->append = append; }
      continue;
    }
    if (expand) { if (!append_glob(cur, t)) return -1; }
    else if (!append_arg(cur, t.text)) return -1;
  }
  if (parse_error[0]) return -1;
  if (!cur->argc && n) { snprintf(parse_error, sizeof parse_error, "empty command after |"); return -1; }
  return cur->argc ? n + 1 : 0;
}

/* ---------------------------- command lists ------------------------------ */

static char *copy_trimmed(const char *a, const char *b) {
  while (a < b && isspace((unsigned char)*a)) a++;
  while (b > a && isspace((unsigned char)b[-1])) b--;
  size_t n = (size_t)(b - a); char *s = xmalloc(n + 1); memcpy(s, a, n); s[n] = 0; return s;
}

static void free_list(ListItem *items, int n) {
  for (int i = 0; i < n; i++) free(items[i].text);
}

static int parse_list(char *line, ListItem *items) {
  memset(items, 0, MAX_LISTS * sizeof *items);
  const char *start = line, *last_op = NULL; Condition next = COND_ALWAYS;
  int count = 0, sq = 0, dq = 0, escaped = 0, word_start = 1, dp_depth = 0;
  for (char *p = line;; p++) {
    char c = *p;
    int separator = !sq && !dq && !escaped && !dp_depth && (c == ';' || c == '\n' ||
      (c == '&' && p[1] == '&') || (c == '|' && p[1] == '|'));
    if (!c || separator) {
      char *piece = copy_trimmed(start, p);
      const char *op = c == '&' ? "&&" : c == '|' ? "||" : c == ';' ? ";" : c == '\n' ? "newline" : NULL;
      if (*piece) {
        if (count >= MAX_LISTS) { free(piece); snprintf(parse_error, sizeof parse_error, "too many commands"); free_list(items, count); return -1; }
        items[count].text = piece; items[count++].condition = next;
      } else {
        free(piece);
        if (c && c != '\n') {
          snprintf(parse_error, sizeof parse_error, "empty command before %s", op);
          free_list(items, count); return -1;
        }
        if (!c && last_op && strcmp(last_op, ";") && strcmp(last_op, "newline")) {
          snprintf(parse_error, sizeof parse_error, "empty command after %s", last_op);
          free_list(items, count); return -1;
        }
      }
      if (!c) break;
      last_op = op;
      if (c == '&') { next = COND_AND; p++; }
      else if (c == '|') { next = COND_OR; p++; }
      else next = COND_ALWAYS;
      start = p + 1; word_start = 1; continue;
    }
    if (!sq && !dq && !escaped && c == '&' && p[1] != '&' && p[1] != '>' && (p == line || p[-1] != '>') && !dp_depth) {
      snprintf(parse_error, sizeof parse_error, "unsupported operator &"); free_list(items, count); return -1;
    }
    if (!sq && !dq && !escaped && c == '#' && word_start) {
      char *q = p; while (*q && *q != '\n') *q++ = ' ';
      p--; continue;
    }
    if (escaped) { escaped = 0; word_start = 0; continue; }
    if (c == '\\' && !sq) { escaped = 1; continue; }
    /* Track $(( and $( nesting to avoid treating > < & | inside as operators */
    if (!sq && !dq && !escaped && c == '$' && p[1] == '(') {
      dp_depth++;
    } else if (!sq && !dq && !escaped && c == '(' && p > line && p[-1] != '$' && dp_depth > 0) {
      dp_depth++;
    } else if (!sq && !dq && !escaped && c == ')' && dp_depth > 0) {
      dp_depth--;
    }
    if (c == '\'' && !dq) { sq = !sq; word_start = 0; continue; }
    if (c == '"' && !sq) { dq = !dq; word_start = 0; continue; }
    word_start = isspace((unsigned char)c);
  }
  if (sq || dq) {
    snprintf(parse_error, sizeof parse_error, "unterminated %c quote", sq ? '\'' : '"');
    free_list(items, count); return -1;
  }
  for (int i = 0; i < count; i++) {
    Command validation[MAX_CMDS]; int n = parse_pipeline(items[i].text, validation, 0);
    if (n <= 0) {
      for (int j = 0; j < MAX_CMDS; j++) free_command(&validation[j]);
      free_list(items, count); return -1;
    }
    for (int j = 0; j < n; j++) free_command(&validation[j]);
  }
  return count;
}

/* ------------------------------- builtins -------------------------------- */

static int builtin_name(const char *s) {
  static const char *names[] = {"cd","pwd","help","echo","printf",":","true","false",
    "export","readonly","unset","set","test","[","shift","read","type","command","eval",
    ".","source","break","continue","umask","return",NULL};
  for (int i = 0; names[i]; i++) if (!strcmp(s, names[i])) return 1;
  return 0;
}

static int test_builtin(char **v, int n) {
  if (n && !strcmp(v[n - 1], "]")) n--;
  if (!n) return 1;
  if (!strcmp(v[0], "!")) return !test_builtin(v + 1, n - 1) ? 0 : 1;
  if (n == 1) return *v[0] ? 0 : 1;
  if (n == 2) {
    if (!strcmp(v[0], "-n")) return *v[1] ? 0 : 1;
    if (!strcmp(v[0], "-z")) return *v[1] ? 1 : 0;
    char path[PATH_CAP]; struct stat st;
    if (!resolve_path(v[1], path)) return 1;
    int ok = stat(path, &st) == 0;
    if (!strcmp(v[0], "-e")) return ok ? 0 : 1;
    if (!strcmp(v[0], "-f")) return ok && S_ISREG(st.st_mode) ? 0 : 1;
    if (!strcmp(v[0], "-d")) return ok && S_ISDIR(st.st_mode) ? 0 : 1;
    if (!strcmp(v[0], "-s")) return ok && st.st_size > 0 ? 0 : 1;
    if (!strcmp(v[0], "-r") || !strcmp(v[0], "-w")) return ok ? 0 : 1;
    if (!strcmp(v[0], "-x")) return ok ? 0 : 1;
    if (!strcmp(v[0], "-h") || !strcmp(v[0], "-L")) return ok && S_ISLNK(st.st_mode) ? 0 : 1;
    if (!strcmp(v[0], "-p")) return ok && S_ISFIFO(st.st_mode) ? 0 : 1;
  }
  if (n == 3) {
    if (!strcmp(v[1], "=") || !strcmp(v[1], "==")) return strcmp(v[0], v[2]) ? 1 : 0;
    if (!strcmp(v[1], "!=")) return strcmp(v[0], v[2]) ? 0 : 1;
    if (!strcmp(v[1], "-nt") || !strcmp(v[1], "-ot")) {
      char p1[PATH_CAP], p2[PATH_CAP]; struct stat s1, s2;
      if (!resolve_path(v[0], p1) || !resolve_path(v[2], p2)) return 1;
      if (stat(p1, &s1) != 0 || stat(p2, &s2) != 0) return 1;
      if (!strcmp(v[1], "-nt")) return s1.st_mtime > s2.st_mtime ? 0 : 1;
      return s1.st_mtime < s2.st_mtime ? 0 : 1;
    }
    long a = strtol(v[0], NULL, 10), b = strtol(v[2], NULL, 10);
    if (!strcmp(v[1], "-eq")) return a == b ? 0 : 1;
    if (!strcmp(v[1], "-ne")) return a != b ? 0 : 1;
    if (!strcmp(v[1], "-lt")) return a < b ? 0 : 1;
    if (!strcmp(v[1], "-le")) return a <= b ? 0 : 1;
    if (!strcmp(v[1], "-gt")) return a > b ? 0 : 1;
    if (!strcmp(v[1], "-ge")) return a >= b ? 0 : 1;
  }
  return 1;
}

static void print_escaped(FILE *out, const char *s) {
  while (*s) {
    if (*s != '\\') { fputc(*s++, out); continue; }
    s++;
    if (*s == 'n') { fputc('\n', out); s++; }
    else if (*s == 't') { fputc('\t', out); s++; }
    else if (*s == 'r') { fputc('\r', out); s++; }
    else if (*s == 'b') { fputc('\b', out); s++; }
    else if (*s == '\\') { fputc('\\', out); s++; }
    else if (*s) fputc(*s++, out);
  }
}

static int printf_builtin(char **v, int n, FILE *out) {
  if (!n) return 0;
  const char *f = v[0]; int ai = 1;
  for (size_t i = 0; f[i]; i++) {
    if (f[i] == '\\') {
      char pair[3] = {'\\', f[i + 1], 0}; print_escaped(out, pair); if (f[i + 1]) i++;
    } else if (f[i] == '%' && f[i + 1]) {
      char spec = f[++i];
      if (spec == '%') fputc('%', out);
      else if (spec == 's') fputs(ai < n ? v[ai++] : "", out);
      else if (spec == 'd' || spec == 'i') fprintf(out, "%ld", ai < n ? strtol(v[ai++], NULL, 0) : 0L);
      else if (spec == 'x') fprintf(out, "%lx", ai < n ? strtol(v[ai++], NULL, 0) : 0L);
      else if (spec == 'o') fprintf(out, "%lo", ai < n ? strtol(v[ai++], NULL, 0) : 0L);
      else if (spec == 'c') fputc(ai < n ? v[ai++][0] : ' ', out);
      else { fputc('%', out); fputc(spec, out); }
    } else fputc(f[i], out);
  }
  return 0;
}

static char *read_file(const char *name, int *length, int cap) {
  char path[PATH_CAP];
  if (!resolve_path(name, path)) { fprintf(stderr, "slop: path too long: %s\n", name); return NULL; }
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "slop: %s: %s\n", name, strerror(errno)); return NULL; }
  char *data = xmalloc((size_t)cap + 1); size_t n = fread(data, 1, (size_t)cap, f);
  if (!feof(f)) { fprintf(stderr, "slop: %s exceeds %d-byte input limit\n", name, cap); fclose(f); free(data); return NULL; }
  if (ferror(f)) { fprintf(stderr, "slop: %s: read error\n", name); fclose(f); free(data); return NULL; }
  fclose(f); data[n] = 0; *length = (int)n; return data;
}

static void print_help(FILE *out) {
  fputs("slop - build-oriented shell for piodide\n"
        "usage: slop [-c command [name [args...]]] [script [args...]]\n"
        "syntax: quotes, $var/${var:-default}, $(command), $((arith)), $?, globs\n"
        "        redirects: < > >> 2> 2>> 2>&1 &> |\n"
        "        lists: && || ;\n"
        "blocks: if/then/elif/else/fi, for/in/do/done, while/do/done, case/esac\n"
        "functions: name() { ... }\n"
        "builtins: cd pwd echo printf export unset test [ shift read type source true false\n", out);
}

static int run_builtin(Command *c, FILE *out, FILE *err, const char *input, int input_len) {
  char **a = c->argv; int n = c->argc; const char *name = a[0];
  if (!strcmp(name, ":") || !strcmp(name, "true")) return 0;
  if (!strcmp(name, "false")) return 1;
  if (!strcmp(name, "pwd")) { fprintf(out, "%s\n", cwd); return 0; }
  if (!strcmp(name, "help")) { print_help(out); return 0; }
  if (!strcmp(name, "cd")) {
    const char *dest = n > 1 ? a[1] : getenv("HOME"); char path[PATH_CAP];
    if (!dest || !resolve_path(dest, path) || !is_dir(path)) { fprintf(err, "slop: cd: %s: no such directory\n", dest ? dest : ""); return 1; }
    snprintf(cwd, sizeof cwd, "%s", path); setenv("PWD", cwd, 1); return 0;
  }
  if (!strcmp(name, "echo")) {
    int i = 1, newline = 1;
    if (i < n && !strcmp(a[i], "-n")) { newline = 0; i++; }
    for (; i < n; i++) { if (i > (newline ? 1 : 2)) fputc(' ', out); fputs(a[i], out); }
    if (newline) fputc('\n', out); return 0;
  }
  if (!strcmp(name, "printf")) return printf_builtin(a + 1, n - 1, out);
  if (!strcmp(name, "set")) {
    for (int i = 1; i < n; i++) {
      if (!strcmp(a[i], "-e")) option_errexit = 1;
      else if (!strcmp(a[i], "+e")) option_errexit = 0;
      else if (!strcmp(a[i], "-x")) option_xtrace = 1;
      else if (!strcmp(a[i], "+x")) option_xtrace = 0;
      else if (!strcmp(a[i], "-u") || !strcmp(a[i], "+u")) { }
      else if (!strcmp(a[i], "--")) break;
      else { fprintf(err, "slop: set: unsupported option: %s\n", a[i]); return 2; }
    }
    return 0;
  }
  if (!strcmp(name, "export") || !strcmp(name, "readonly")) {
    for (int i = 1; i < n; i++) {
      const char *eq;
      if (assignment_word(a[i], &eq)) {
        size_t z = (size_t)(eq - a[i]); char key[128];
        if (z >= sizeof key) return 2; memcpy(key, a[i], z); key[z] = 0; setenv(key, eq + 1, 1);
      } else if (!valid_name_n(a[i], strlen(a[i]))) { fprintf(err, "slop: export: invalid name: %s\n", a[i]); return 2; }
    }
    return 0;
  }
  if (!strcmp(name, "unset")) {
    for (int i = 1; i < n; i++)
      if (valid_name_n(a[i], strlen(a[i]))) unsetenv(a[i]);
    return 0;
  }
  if (!strcmp(name, "test") || !strcmp(name, "[")) return test_builtin(a + 1, n - 1);
  if (!strcmp(name, "shift")) {
    int by = n > 1 ? atoi(a[1]) : 1;
    if (by < 0 || by > shell_argc) return 1;
    shell_argv += by; shell_argc -= by; return 0;
  }
  if (!strcmp(name, "read")) {
    const char *var = n > 1 ? a[1] : "REPLY";
    if (!valid_name_n(var, strlen(var))) return 2;
    char line[4096]; size_t z = 0;
    if (input) { while (z + 1 < sizeof line && z < (size_t)input_len && input[z] != '\n') { line[z] = input[z]; z++; } }
    else if (fgets(line, sizeof line, stdin)) z = strcspn(line, "\r\n");
    else return 1;
    line[z] = 0; setenv(var, line, 1); return 0;
  }
  if (!strcmp(name, "command")) {
    if (n > 1 && !strcmp(a[1], "-v")) {
      int rc = 0;
      for (int i = 2; i < n; i++) { char path[PATH_CAP]; if (builtin_name(a[i])) fprintf(out, "%s\n", a[i]); else if (find_function(a[i])) fprintf(out, "%s\n", a[i]); else if (find_command(a[i], path)) fprintf(out, "%s\n", path); else rc = 1; }
      return rc;
    }
    fprintf(err, "slop: command: only 'command -v' is supported\n"); return 2;
  }
  if (!strcmp(name, "eval")) {
    Buf text; binit(&text); for (int i = 1; i < n; i++) { if (i > 1) bputc(&text, ' '); bputs(&text, a[i]); }
    int rc = execute_command_list(text.s); free(text.s); return rc;
  }
  if (!strcmp(name, "umask")) return 0;
  if (!strcmp(name, "return")) { flow_signal = 3; return n > 1 ? atoi(a[1]) : last_status; }
  if (!strcmp(name, "type")) {
    int rc = 0;
    for (int i = 1; i < n; i++) {
      char path[PATH_CAP];
      if (builtin_name(a[i])) fprintf(out, "%s is a shell builtin\n", a[i]);
      else if (find_function(a[i])) fprintf(out, "%s is a function\n", a[i]);
      else if (find_command(a[i], path)) fprintf(out, "%s is %s\n", a[i], path);
      else { fprintf(out, "%s not found\n", a[i]); rc = 1; }
    }
    return rc;
  }
  if (!strcmp(name, ".") || !strcmp(name, "source")) {
    if (n < 2) { fprintf(err, "slop: %s: filename required\n", name); return 2; }
    int z; char *script = read_file(a[1], &z, SCRIPT_CAP); (void)z;
    if (!script) return 1; int rc = execute_script(script); free(script); return rc;
  }
  if (!strcmp(name, "break")) { flow_signal = 1; return 0; }
  if (!strcmp(name, "continue")) { flow_signal = 2; return 0; }
  return 127;
}

/* ------------------------------- execution ------------------------------- */

static int wasm_program(const char *path) {
  FILE *f = fopen(path, "rb"); if (!f) return 0;
  unsigned char magic[4]; size_t n = fread(magic, 1, 4, f); fclose(f);
  return n == 4 && magic[0] == 0 && magic[1] == 'a' && magic[2] == 's' && magic[3] == 'm';
}

extern char **environ;

static int serialize_environment(void) {
  size_t used = 0;
  for (char **entry = environ; entry && *entry; entry++) {
    size_t n = strlen(*entry) + 1;
    if (used + n + 1 > ENV_CAP) { fprintf(stderr, "slop: environment exceeds %d bytes\n", ENV_CAP); return -1; }
    memcpy(spawn_env + used, *entry, n); used += n;
  }
  spawn_env[used++] = 0;
  return (int)used;
}

static int host_command(const char *s) {
  const char *base = strrchr(s, '/'); base = base ? base + 1 : s;
  return !strcmp(s, "cc") || !strcmp(s, "compile") || !strcmp(s, "ld") ||
    !strcmp(s, "link") || !strcmp(base, "python") || !strcmp(base, "python3");
}

static int append_spawn_arg(char *blob, size_t cap, size_t *off, const char *s) {
  size_t n = strlen(s) + 1;
  if (*off + n + 1 > cap) return 0;
  memcpy(blob + *off, s, n); *off += n; return 1;
}

static void restore_assignments(AssignmentScope *scope) {
  for (int i = scope->count - 1; i >= 0; i--) {
    SavedAssignment *saved = &scope->items[i];
    if (saved->was_set) setenv(saved->name, saved->value, 1);
    else unsetenv(saved->name);
    free(saved->name); free(saved->value);
  }
  scope->count = 0;
}

static int apply_assignments(Command *c, AssignmentScope *scope) {
  int first = 0;
  while (first < c->argc) {
    const char *eq;
    if (!assignment_word(c->argv[first], &eq)) break;
    first++;
  }
  int persistent = first == c->argc;
  for (int i = 0; i < first; i++) {
    const char *eq = strchr(c->argv[i], '=');
    size_t n = (size_t)(eq - c->argv[i]); char name[128];
    if (n >= sizeof name) { restore_assignments(scope); return -1; }
    memcpy(name, c->argv[i], n); name[n] = 0;
    if (!persistent) {
      const char *old = getenv(name);
      SavedAssignment *saved = &scope->items[scope->count++];
      saved->name = xstrdup(name); saved->value = old ? xstrdup(old) : NULL;
      saved->was_set = old != NULL;
    }
    if (setenv(name, eq + 1, 1)) { restore_assignments(scope); return -1; }
  }
  if (first) {
    for (int i = first; i < c->argc; i++) c->argv[i - first] = c->argv[i];
    c->argc -= first; c->argv[c->argc] = NULL;
  }
  return c->argc;
}

static int load_redirect(const char *name) {
  char path[PATH_CAP];
  if (!resolve_path(name, path)) { fprintf(stderr, "slop: %s: path too long\n", name); return -1; }
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "slop: %s: %s\n", name, strerror(errno)); return -1; }
  size_t n = fread(redirect_input, 1, PIPE_CAP, f);
  if (!feof(f)) { fprintf(stderr, "slop: %s: input exceeds %d bytes\n", name, PIPE_CAP); fclose(f); return -1; }
  fclose(f); return (int)n;
}

static int run_pipeline(Command *cmds, int ncmd) {
  static char blob[16384], resolved[PATH_CAP], out_path[PATH_CAP], err_path[PATH_CAP];
  char *cur = pipe_a, *next = pipe_b;
  const char *previous = NULL; int previous_len = 0, code = 0;
  for (int i = 0; i < ncmd; i++) {
    Command *c = &cmds[i]; int last = i + 1 == ncmd;
    AssignmentScope assignments; memset(&assignments, 0, sizeof assignments);
    if (apply_assignments(c, &assignments) < 0) return 2;
    if (!c->argc) { code = 0; continue; }

    const char *input = previous; int input_len = previous_len;
    if (c->in_file) {
      input_len = load_redirect(c->in_file);
      if (input_len < 0) { restore_assignments(&assignments); return 1; }
      input = redirect_input;
    }
    const char *out_file = NULL;
    if (c->out_file) {
      if (!resolve_path(c->out_file, out_path)) { fprintf(stderr, "slop: output path too long\n"); restore_assignments(&assignments); return 1; }
      out_file = out_path;
    }
    const char *efile = NULL;
    if (c->err_file) {
      if (!resolve_path(c->err_file, err_path)) { fprintf(stderr, "slop: error path too long\n"); restore_assignments(&assignments); return 1; }
      efile = err_path;
    }

    Function *fn = NULL;
    int is_builtin = builtin_name(c->argv[0]);
    if (!is_builtin) fn = find_function(c->argv[0]);

    if (is_builtin || fn) {
      FILE *out = stdout; int capture = 0;
      FILE *err = stderr;
      if (out_file) {
        out = fopen(out_file, c->append ? "a" : "w");
        if (!out) { fprintf(stderr, "slop: %s: %s\n", c->out_file, strerror(errno)); restore_assignments(&assignments); return 1; }
      } else if (!last || capture_active) {
        out = fmemopen(cur, PIPE_CAP, "w"); capture = 1;
        if (!out) { restore_assignments(&assignments); return 1; }
      }
      if (efile) {
        err = fopen(efile, c->err_append ? "a" : "w");
        if (!err) { fprintf(stderr, "slop: %s: %s\n", c->err_file, strerror(errno)); if (capture) fclose(out); restore_assignments(&assignments); return 1; }
      } else if (c->err_to_out) {
        if (out_file) err = out;
        else if (capture) err = out;
      }

      if (fn) {
        int saved_argc = shell_argc; char **saved_argv = shell_argv;
        const char *saved_name = shell_name;
        shell_argc = c->argc - 1; shell_argv = c->argv + 1; shell_name = c->argv[0];
        char *body = xstrdup(fn->body);
        code = execute_script(body);
        free(body);
        shell_argc = saved_argc; shell_argv = saved_argv; shell_name = saved_name;
        if (flow_signal == 3) flow_signal = 0;
      } else {
        code = run_builtin(c, out, err, input, input_len);
      }

      if (capture) {
        previous_len = (int)ftell(out); fclose(out);
        if (last && capture_active) {
          capture_length = previous_len > PIPE_CAP ? PIPE_CAP : previous_len;
          memcpy(capture_buffer, cur, (size_t)capture_length); previous = NULL; previous_len = 0;
        } else previous = cur;
      } else { if (out_file) fclose(out); previous = NULL; previous_len = 0; }
      if (efile && err != out) fclose(err);
    } else {
      int pseudo = host_command(c->argv[0]);
      if (!pseudo && !find_command(c->argv[0], resolved)) {
        fprintf(stderr, "slop: command not found: %s\n", c->argv[0]); restore_assignments(&assignments); return 127;
      }
      int script = !pseudo && !wasm_program(resolved);
      const char *spawn_path = pseudo ? c->argv[0] : script ? "/bin/slop" : resolved;
      size_t off = 0;
      if (!append_spawn_arg(blob, sizeof blob, &off, spawn_path)) { restore_assignments(&assignments); return 2; }
      if (script && !append_spawn_arg(blob, sizeof blob, &off, resolved)) { restore_assignments(&assignments); return 2; }
      for (int a = 1; a < c->argc; a++)
        if (!append_spawn_arg(blob, sizeof blob, &off, c->argv[a])) { fprintf(stderr, "slop: argument list too long\n"); restore_assignments(&assignments); return 2; }
      blob[off] = 0;
      int captured = 0;
      slop_io io; memset(&io, 0, sizeof io);
      io.stdin_data = input; io.stdin_len = input_len;
      int env_len = serialize_environment(); if (env_len < 0) { restore_assignments(&assignments); return 2; }
      io.env_data = spawn_env; io.env_len = env_len;
      if (out_file) { io.out_file = out_file; io.out_append = c->append; }
      else if (!last || capture_active) { io.capture = cur; io.capture_cap = PIPE_CAP; io.capture_len = &captured; }
      code = piodide_spawn(spawn_path, blob, cwd, &io);
      if (captured > PIPE_CAP) { fprintf(stderr, "slop: output truncated at %d bytes\n", PIPE_CAP); captured = PIPE_CAP; }
      if (out_file) { previous = NULL; previous_len = 0; }
      else if (!last) { previous = cur; previous_len = captured; }
      else if (capture_active) {
        capture_length = captured; memcpy(capture_buffer, cur, (size_t)captured);
        previous = NULL; previous_len = 0;
      } else { previous = NULL; previous_len = 0; }
    }
    restore_assignments(&assignments);
    char *swap = cur; cur = next; next = swap;
  }
  return code;
}

static int execute_command_list(char *line) {
  ListItem items[MAX_LISTS];
  int n = parse_list(line, items);
  if (n < 0) { fprintf(stderr, "slop: %s\n", parse_error); return last_status = 2; }
  for (int i = 0; i < n && !exit_requested && !flow_signal; i++) {
    int run = items[i].condition == COND_ALWAYS ||
      (items[i].condition == COND_AND && last_status == 0) ||
      (items[i].condition == COND_OR && last_status != 0);
    if (!run) continue;
    Command cmds[MAX_CMDS]; int nc = parse_pipeline(items[i].text, cmds, 1);
    if (nc <= 0) {
      fprintf(stderr, "slop: %s\n", parse_error[0] ? parse_error : "invalid command");
      for (int j = 0; j < MAX_CMDS; j++) free_command(&cmds[j]); last_status = 2; break;
    }
    if (option_xtrace) fprintf(stderr, "+ %s\n", items[i].text);
    if (nc == 1 && cmds[0].argc && !strcmp(cmds[0].argv[0], "exit")) {
      exit_status = cmds[0].argc > 1 ? atoi(cmds[0].argv[1]) : last_status;
      exit_requested = 1; last_status = exit_status;
    } else last_status = run_pipeline(cmds, nc);
    for (int j = 0; j < nc; j++) free_command(&cmds[j]);
    int guarded = i + 1 < n && (items[i + 1].condition == COND_AND || items[i + 1].condition == COND_OR);
    if (option_errexit && !suppress_errexit && last_status && !guarded) {
      exit_requested = 1; exit_status = last_status;
    }
  }
  free_list(items, n > 0 ? n : 0); return last_status;
}

static char *capture_command(const char *text) {
  if (capture_active) { snprintf(parse_error, sizeof parse_error, "nested command substitution is unsupported"); return xstrdup(""); }
  int saved_status = last_status, saved_exit = exit_requested, saved_exit_status = exit_status;
  int saved_flow = flow_signal;
  capture_active = 1; capture_length = 0; suppress_errexit++;
  char *copy = xstrdup(text); execute_command_list(copy); free(copy);
  suppress_errexit--; capture_active = 0;
  while (capture_length > 0 && (capture_buffer[capture_length - 1] == '\n' || capture_buffer[capture_length - 1] == '\r')) capture_length--;
  char *result = xmalloc((size_t)capture_length + 1);
  memcpy(result, capture_buffer, (size_t)capture_length); result[capture_length] = 0;
  last_status = saved_status; exit_requested = saved_exit; exit_status = saved_exit_status; flow_signal = saved_flow;
  return result;
}

/* -------------------------- line-oriented blocks ------------------------- */

static int starts_word(const char *s, const char *word) {
  size_t n = strlen(word); return !strncmp(s, word, n) && (!s[n] || isspace((unsigned char)s[n]));
}

static int find_if_end(char **lines, int start, int end) {
  int depth = 1;
  for (int i = start + 1; i < end; i++) {
    char *s = trim(lines[i]);
    if (starts_word(s, "if") || starts_word(s, "case")) depth++;
    else if (!strcmp(s, "fi") && --depth == 0) return i;
  }
  return -1;
}

static int find_if_clause(char **lines, int start, int finish) {
  int depth = 1;
  for (int i = start + 1; i < finish; i++) {
    char *s = trim(lines[i]);
    if (starts_word(s, "if")) depth++;
    else if (!strcmp(s, "fi")) depth--;
    else if (depth == 1 && (!strcmp(s, "else") || starts_word(s, "elif"))) return i;
  }
  return -1;
}

static int find_done(char **lines, int start, int end) {
  int depth = 1;
  for (int i = start + 1; i < end; i++) {
    char *s = trim(lines[i]);
    if (starts_word(s, "for") || starts_word(s, "while")) depth++;
    else if (!strcmp(s, "done") && --depth == 0) return i;
  }
  return -1;
}

static int find_esac(char **lines, int start, int end) {
  int depth = 1;
  for (int i = start + 1; i < end; i++) {
    char *s = trim(lines[i]);
    if (starts_word(s, "case")) depth++;
    else if (!strcmp(s, "esac") && --depth == 0) return i;
  }
  return -1;
}

static char *strip_suffix_keyword(char *s, const char *keyword) {
  s = trim(s); size_t a = strlen(s), b = strlen(keyword);
  if (a >= b && !strcmp(s + a - b, keyword)) {
    s[a - b] = 0; s = trim(s);
    a = strlen(s); if (a && s[a - 1] == ';') s[a - 1] = 0;
  }
  return trim(s);
}

static int run_condition(char *text) {
  suppress_errexit++;
  int rc = execute_command_list(text);
  suppress_errexit--;
  return rc;
}

static int pattern_match(const char *pattern, const char *str) {
  while (*pattern) {
    if (*pattern == '*') {
      while (*pattern == '*') pattern++;
      if (!*pattern) return 1;
      while (*str) { if (pattern_match(pattern, str)) return 1; str++; }
      return 0;
    } else if (*pattern == '?') {
      if (!*str) return 0;
      pattern++; str++;
    } else if (*pattern == '[') {
      if (!*str) return 0;
      pattern++; int negated = 0;
      if (*pattern == '!' || *pattern == '^') { negated = 1; pattern++; }
      int matched = 0;
      while (*pattern && *pattern != ']') {
        if (pattern[1] == '-' && pattern[2] && pattern[2] != ']') {
          if ((unsigned char)*str >= (unsigned char)pattern[0] && (unsigned char)*str <= (unsigned char)pattern[2]) matched = 1;
          pattern += 3;
        } else {
          if (*str == *pattern) matched = 1;
          pattern++;
        }
      }
      if (*pattern == ']') pattern++;
      if (negated) matched = !matched;
      if (!matched) return 0;
      str++;
    } else if (*pattern == '\\' && pattern[1]) {
      pattern++;
      if (*str != *pattern) return 0;
      pattern++; str++;
    } else {
      if (*str != *pattern) return 0;
      pattern++; str++;
    }
  }
  return !*str;
}

static int execute_range(char **lines, int start, int end) {
  for (int i = start; i < end && !exit_requested; i++) {
    char *s = trim(lines[i]);
    if (!*s || *s == '#') continue;
    /* Function definition */
    if (strstr(s, "()")) {
      char *paren = strstr(s, "()");
      if (paren > s) {
        char *name_end = paren;
        while (name_end > s && isspace((unsigned char)name_end[-1])) name_end--;
        if (name_end > s && valid_name_n(s, (size_t)(name_end - s))) {
          char fname[128]; size_t fnl = (size_t)(name_end - s);
          memcpy(fname, s, fnl); fname[fnl] = 0;
          char *brace = strchr(paren + 2, '{');
          int handled = 0;
          if (brace) {
            char *body_start = brace + 1;
            int depth = 1; char *bp = body_start;
            while (*bp && depth) {
              if (*bp == '{') depth++;
              else if (*bp == '}') { depth--; if (depth == 0) break; }
              bp++;
            }
            if (*bp == '}') {
              size_t blen = (size_t)(bp - body_start);
              char *body = xmalloc(blen + 1);
              memcpy(body, body_start, blen); body[blen] = 0;
              define_function(fname, body);
              free(body);
              handled = 1;
              bp++;
              while (*bp && (isspace((unsigned char)*bp) || *bp == ';')) bp++;
              if (*bp) execute_command_list(bp);
            }
          }
          if (!handled) {
            int body_line = i + 1;
            if (body_line < end && !strcmp(trim(lines[body_line]), "{")) body_line++;
            int finish_line = end; int depth = 1;
            for (int k = body_line; k < end; k++) {
              char *bl = trim(lines[k]);
              if (!strcmp(bl, "}")) { depth--; if (depth == 0) { finish_line = k; break; } }
            }
            Buf bodybuf; binit(&bodybuf);
            for (int k = body_line; k < finish_line; k++) {
              bputs(&bodybuf, lines[k]); bputc(&bodybuf, '\n');
            }
            define_function(fname, bodybuf.s);
            free(bodybuf.s);
            i = finish_line; continue;
          }
          continue;
        }
      }
    }
    if (starts_word(s, "if")) {
      int finish = find_if_end(lines, i, end);
      if (finish < 0) { fprintf(stderr, "slop: missing fi\n"); return last_status = 2; }
      int clause = i, handled = 0;
      while (!handled) {
        char *cs = trim(lines[clause]);
        char *cond = strip_suffix_keyword(trim(cs + (starts_word(cs, "elif") ? 4 : 2)), "then");
        int body = clause + 1;
        if (!*cond && body < finish && !strcmp(trim(lines[body]), "then")) body++;
        int next_clause = find_if_clause(lines, clause, finish);
        if (run_condition(cond) == 0) {
          execute_range(lines, body, next_clause >= 0 ? next_clause : finish); handled = 1;
        } else if (next_clause < 0) handled = 1;
        else if (!strcmp(trim(lines[next_clause]), "else")) {
          execute_range(lines, next_clause + 1, finish); handled = 1;
        } else clause = next_clause;
      }
      i = finish; continue;
    }
    if (starts_word(s, "for")) {
      int finish = find_done(lines, i, end);
      if (finish < 0) { fprintf(stderr, "slop: missing done\n"); return last_status = 2; }
      char *spec = strip_suffix_keyword(trim(s + 3), "do");
      char *p = spec; Token var = next_token(&p, 0);
      if (!var.text || !valid_name_n(var.text, strlen(var.text))) { free(var.text); fprintf(stderr, "slop: bad for variable\n"); return last_status = 2; }
      while (isspace((unsigned char)*p)) p++;
      int explicit_in = starts_word(p, "in");
      if (explicit_in) p = trim(p + 2);
      Command words; memset(&words, 0, sizeof words);
      if (!explicit_in && !*p) {
        for (int a = 0; a < shell_argc; a++) append_arg(&words, xstrdup(shell_argv[a]));
      } else while (*p) { Token w = next_token(&p, 1); if (!w.text) break; append_glob(&words, w); }
      int body = i + 1; if (body < finish && !strcmp(trim(lines[body]), "do")) body++;
      for (int w = 0; w < words.argc && !exit_requested; w++) {
        setenv(var.text, words.argv[w], 1); flow_signal = 0;
        execute_range(lines, body, finish);
        if (flow_signal == 1) { flow_signal = 0; break; }
        if (flow_signal == 2) flow_signal = 0;
      }
      free(var.text); free_command(&words); i = finish; continue;
    }
    if (starts_word(s, "while")) {
      int finish = find_done(lines, i, end);
      if (finish < 0) { fprintf(stderr, "slop: missing done\n"); return last_status = 2; }
      char *cond = strip_suffix_keyword(trim(s + 5), "do");
      int body = i + 1; if (body < finish && !strcmp(trim(lines[body]), "do")) body++;
      int loops = 0;
      while (!exit_requested && run_condition(cond) == 0) {
        if (++loops > LOOP_LIMIT) { fprintf(stderr, "slop: loop limit (%d) exceeded\n", LOOP_LIMIT); last_status = 2; break; }
        flow_signal = 0; execute_range(lines, body, finish);
        if (flow_signal == 1) { flow_signal = 0; break; }
        if (flow_signal == 2) flow_signal = 0;
      }
      i = finish; continue;
    }
    if (starts_word(s, "case")) {
      int finish = find_esac(lines, i, end);
      if (finish < 0) { fprintf(stderr, "slop: missing esac\n"); return last_status = 2; }
      char *spec = trim(s + 4);
      char *in_pos = strstr(spec, "in");
      if (in_pos) *in_pos = 0;
      spec = trim(spec);
      Buf wordbuf; binit(&wordbuf);
      expand_text(&wordbuf, spec, 0);
      const char *word = wordbuf.s;
      int j = i + 1; int matched = 0;
      while (j < finish && !matched && !exit_requested) {
        char *line = trim(lines[j]);
        if (!*line || *line == '#') { j++; continue; }
        char *close = strrchr(line, ')');
        if (!close) { j++; continue; }
        *close = 0;
        char *patterns = trim(line);
        char *psave = patterns;
        while (psave && !matched) {
          char *bar = strchr(psave, '|');
          char *pat = psave;
          if (bar) { *bar = 0; psave = bar + 1; } else psave = NULL;
          pat = trim(pat);
          if (!strcmp(pat, "*")) { matched = 1; break; }
          Buf expbuf; binit(&expbuf);
          expand_text(&expbuf, pat, 0);
          if (pattern_match(expbuf.s, word)) matched = 1;
          free(expbuf.s);
        }
        if (matched) {
          int body_start = j + 1; int body_end = finish;
          for (int k = body_start; k < finish; k++) {
            char *bl = trim(lines[k]);
            if (!strcmp(bl, ";;")) { body_end = k; break; }
            char *ds = strstr(bl, ";;");
            if (ds) { body_end = k; break; }
          }
          execute_range(lines, body_start, body_end);
        }
        j++;
        while (j < finish) {
          char *bl = trim(lines[j]);
          if (!strcmp(bl, ";;")) { j++; break; }
          j++;
        }
      }
      free(wordbuf.s);
      i = finish; continue;
    }
    if (!strcmp(s, "then") || !strcmp(s, "else") || starts_word(s, "elif") || !strcmp(s, "fi") ||
        !strcmp(s, "do") || !strcmp(s, "done") || !strcmp(s, "esac")) {
      fprintf(stderr, "slop: unexpected %s\n", s); return last_status = 2;
    }
    execute_command_list(s);
    if (flow_signal) return last_status;
  }
  return last_status;
}

static int execute_script(char *text) {
  char *r = text, *w = text;
  while (*r) {
    if (r[0] == '\\' && r[1] == '\n') { r += 2; continue; }
    *w++ = *r++;
  }
  *w = 0;
  char *lines[MAX_LINES]; int n = 0;
  char *p = text;
  while (p && *p) {
    if (n >= MAX_LINES) { fprintf(stderr, "slop: script has too many lines\n"); return 2; }
    lines[n++] = p;
    char *nl = strchr(p, '\n');
    if (!nl) break;
    *nl = 0; p = nl + 1;
  }
  return execute_range(lines, 0, n);
}

/* ---------------------------------- main --------------------------------- */

static int block_delta(const char *line) {
  char *copy = xstrdup(line), *s = trim(copy); int d = 0;
  if (starts_word(s, "if") || starts_word(s, "for") || starts_word(s, "while") || starts_word(s, "case")) d = 1;
  if (!strcmp(s, "fi") || !strcmp(s, "done") || !strcmp(s, "esac")) d = -1;
  if (strstr(s, "()") && !strchr(s, '}')) d = 1;
  else if (!strcmp(s, "}")) d = -1;
  free(copy); return d;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0); setvbuf(stderr, NULL, _IONBF, 0);
  pipe_a = xmalloc(PIPE_CAP); pipe_b = xmalloc(PIPE_CAP); redirect_input = xmalloc(PIPE_CAP);
  capture_buffer = xmalloc(PIPE_CAP); spawn_env = xmalloc(ENV_CAP);
  const char *pwd = getenv("PWD");
  if (pwd && *pwd == '/' && is_dir(pwd)) snprintf(cwd, sizeof cwd, "%s", pwd);
  else snprintf(cwd, sizeof cwd, "/home/web");
  normalize(cwd); setenv("PWD", cwd, 1);
  if (!getenv("PATH")) setenv("PATH", "/bin", 1);

  if (argc > 1 && !strcmp(argv[1], "--version")) { puts("slop 0.3 (piodide build shell)"); return 0; }
  if (argc > 1 && (!strcmp(argv[1], "-h") || !strcmp(argv[1], "--help"))) { print_help(stdout); return 0; }
  if (argc > 2 && !strcmp(argv[1], "-c")) {
    shell_name = argc > 3 ? argv[3] : argv[0];
    shell_argc = argc > 4 ? argc - 4 : 0; shell_argv = argc > 4 ? argv + 4 : NULL;
    char *script = xstrdup(argv[2]); int rc = execute_script(script); free(script);
    return exit_requested ? exit_status : rc;
  }
  if (argc > 1 && strcmp(argv[1], "-s")) {
    shell_name = argv[1]; shell_argc = argc - 2; shell_argv = argv + 2;
    int z; char *script = read_file(argv[1], &z, SCRIPT_CAP); (void)z;
    if (!script) return 2; int rc = execute_script(script); free(script);
    return exit_requested ? exit_status : rc;
  }
  int force_stdin = 0;
  if (argc > 1 && !strcmp(argv[1], "-s")) { shell_argc = argc - 2; shell_argv = argv + 2; force_stdin = 1; }

  int interactive = !force_stdin && isatty(0);
  const char *quiet_env = getenv("SLOP_QUIET");
  if (quiet_env && *quiet_env && strcmp(quiet_env, "0")) interactive = 0;
  if (!interactive) {
    Buf script; binit(&script); char chunk[8192];
    while (fgets(chunk, sizeof chunk, stdin)) {
      if (script.len + strlen(chunk) > SCRIPT_CAP) { fprintf(stderr, "slop: input script too large\n"); free(script.s); return 2; }
      bputs(&script, chunk);
    }
    int rc = execute_script(script.s); free(script.s); return exit_requested ? exit_status : rc;
  }

  printf("slop -- build shell, type 'help'\n");
  char line[LINE_CAP]; Buf block; binit(&block); int depth = 0;
  while (!exit_requested) {
    printf("%s> ", cwd);
    if (!fgets(line, sizeof line, stdin)) { putchar('\n'); break; }
    bputs(&block, line); depth += block_delta(line);
    if (depth > 0) continue;
    if (depth < 0) { fprintf(stderr, "slop: unexpected block terminator\n"); depth = 0; block.len = 0; block.s[0] = 0; continue; }
    execute_script(block.s); block.len = 0; block.s[0] = 0;
    if (!exit_requested && last_status) printf("[exit %d]\n", last_status);
  }
  free(block.s); return exit_requested ? exit_status : last_status;
}
