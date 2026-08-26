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
#include <dirent.h>
#include <errno.h>
#include <glob.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Spawn ABI v7, implemented by the browser host. */
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
  const char *err_file;
  int err_append;
  int err_to_out;
  int out_to_err;
  int err_to_inherited_out;
  int out_to_inherited_err;
  int argc;
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
#define LARGE_REDIRECT_CAP (16 * 1024 * 1024)
#define SPAWN_ARG_CAP (1024 * 1024)
#define SCRIPT_CAP (2 * 1024 * 1024)
#define LOOP_LIMIT 10000
#define ENV_CAP 65536
#define MAX_FUNCS 64
#define MAX_FUNCTION_DEPTH 32
#define MAX_SOURCE_DEPTH 8
#define MAX_EVAL_DEPTH 8
#define READ_VALUE_CAP 4096
#define POSITIONAL_ARGS 100
#define POSITIONAL_ARG_CAP 4096
#define POSITIONAL_TOTAL_CAP 65536

typedef struct { char *s; size_t len, cap; } Buf;
typedef struct {
  char *text;
  int quoted;
  /* Exact standalone "$@" is a vector expansion, not a scalar token. */
  int positional_vector;
} Token;
typedef struct { char *name, *value; int was_set; } SavedAssignment;
typedef struct { SavedAssignment items[MAX_ARGS]; int count; } AssignmentScope;
typedef struct {
  char *argv[MAX_ARGS];
  int argc;
  int command_bypass;
  char *in_file;
  char *out_file;
  int append;
  char *err_file;
  int err_append;
  int err_to_out;
  int out_to_err;
} Command;
typedef enum { COND_ALWAYS, COND_AND, COND_OR } Condition;
typedef struct { char *text; Condition condition; } ListItem;
typedef struct { char *name; char *body; } Function;

static char cwd[PATH_CAP] = "/home/web";
static int last_status;
static int shell_argc;
static char **shell_argv;
/* NULL for borrowed script/function/source argv; otherwise owns the complete
 * replacement vector even when shift has advanced shell_argv into it. */
static char **owned_shell_argv;
static const char *shell_name = "slop";
static int exit_requested;
static int exit_status;
static int flow_signal;
static int option_errexit, option_xtrace, option_nounset, option_pipefail;
static int suppress_errexit;
static int substitution_status;
static int expansion_fatal;
static int capture_active, capture_length;
static char *capture_buffer;
static char parse_error[256];
static char *pipe_a, *pipe_b, *redirect_input, *spawn_env;
static Function functions[MAX_FUNCS];
static int func_count, function_depth, source_depth, eval_depth, loop_depth;
static AssignmentScope function_locals[MAX_FUNCTION_DEPTH];

typedef struct {
  FILE *out;
  FILE *err;
  const char *out_file;
  const char *err_file;
} RedirectContext;

static RedirectContext redirect_context;

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

static void free_owned_positionals(void) {
  if (!owned_shell_argv) return;
  for (char **item = owned_shell_argv; *item; item++) free(*item);
  free(owned_shell_argv); owned_shell_argv = NULL;
}

static int replace_positionals(char **values, int count, FILE *err) {
  if (count > POSITIONAL_ARGS) {
    fprintf(err, "slop: set: too many positional parameters (limit %d)\n", POSITIONAL_ARGS);
    return 2;
  }
  size_t total = 0;
  for (int i = 0; i < count; i++) {
    size_t length = strlen(values[i]);
    if (length > POSITIONAL_ARG_CAP) {
      fprintf(err, "slop: set: positional parameter %d exceeds %d-byte limit\n",
              i + 1, POSITIONAL_ARG_CAP);
      return 2;
    }
    if (length > POSITIONAL_TOTAL_CAP - total) {
      fprintf(err, "slop: set: positional parameters exceed %d-byte aggregate limit\n",
              POSITIONAL_TOTAL_CAP);
      return 2;
    }
    total += length;
  }

  char **replacement = NULL;
  if (count) {
    replacement = xmalloc(((size_t)count + 1) * sizeof *replacement);
    for (int i = 0; i < count; i++) replacement[i] = xstrdup(values[i]);
    replacement[count] = NULL;
  }
  free_owned_positionals();
  owned_shell_argv = replacement; shell_argv = replacement; shell_argc = count;
  return 0;
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

static int decimal_in_range(const char *s, int maximum, int *parsed) {
  if (!s || !*s) return 0;
  int value = 0;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (!isdigit(*p)) return 0;
    int digit = *p - '0';
    if (value > (maximum - digit) / 10) return 0;
    value = value * 10 + digit;
  }
  *parsed = value; return 1;
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
    if (option_nounset && n > shell_argc)
      expansion_fatal = 1, snprintf(parse_error, sizeof parse_error, "%d: unbound positional parameter", n);
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
    if (!op && !set && option_nounset)
      expansion_fatal = 1, snprintf(parse_error, sizeof parse_error, "%s: unbound variable", name);
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
      expansion_fatal = 1;
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
    if (!v && option_nounset)
      expansion_fatal = 1, snprintf(parse_error, sizeof parse_error, "%s: unbound variable", name);
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

  /* Normalize the shorthand >&2 to the explicit stdout duplication. */
  if (*p == '>' && p[1] == '&' && isdigit((unsigned char)p[2])) {
    char op[16]; snprintf(op, sizeof op, "1>&%c", p[2]);
    p += 3; t.text = xstrdup(op); *pp = p; return t;
  }

  /* Handle fd-prefixed redirects: 2>, 2>>, 1>, &>, 2>&1, 1>&2 */
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

  /*
   * Keep the one shell expansion that cannot be represented by a string out
   * of the scalar Buf path.  A standalone quoted "$@" becomes zero or more
   * argv entries later, preserving empty parameters and word boundaries.
   * Concatenated forms are rejected below instead of being flattened.
   */
  if (
    do_expand && p[0] == '"' && p[1] == '$' && p[2] == '@' && p[3] == '"' &&
    (!p[4] || isspace((unsigned char)p[4]) || is_operator_char(p[4]))
  ) {
    p += 4;
    t.text = xstrdup("");
    t.quoted = 1;
    t.positional_vector = 1;
    *pp = p;
    return t;
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
      const char *q = p + 1; expand_substitution(&b, &q); p = (char *)q;
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
          else if (*p == '@') {
            snprintf(parse_error, sizeof parse_error, "quoted $@ must be a separate shell word");
            p++;
          }
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
  if (t.positional_vector) {
    free(t.text);
    for (int i = 0; i < shell_argc; i++)
      if (!append_arg(c, xstrdup(shell_argv[i]))) return 0;
    return 1;
  }
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

static int require_scalar_token(Token *token, const char *context) {
  if (!token->positional_vector) return token->text != NULL;
  free(token->text); token->text = NULL; token->positional_vector = 0;
  if (shell_argc != 1) {
    snprintf(
      parse_error,
      sizeof parse_error,
      "%s requires exactly one word after quoted $@ expansion",
      context
    );
    return 0;
  }
  token->text = xstrdup(shell_argv[0]);
  return 1;
}

static int parse_pipeline(char *text, Command *cmds, int expand) {
  memset(cmds, 0, MAX_CMDS * sizeof *cmds); parse_error[0] = 0;
  int n = 0, empty_vector = 0; Command *cur = &cmds[0]; char *p = text;
  for (;;) {
    Token t = next_token(&p, expand);
    if (!t.text) break;
    if (!t.quoted && !strcmp(t.text, "|")) {
      free(t.text);
      if (!cur->argc) { snprintf(parse_error, sizeof parse_error, "empty command before |"); return -1; }
      if (++n >= MAX_CMDS) { snprintf(parse_error, sizeof parse_error, "too many pipeline stages"); return -1; }
      cur = &cmds[n]; continue;
    }
    if (!t.quoted && t.text[0] >= '0' && t.text[0] <= '9' && strstr(t.text, ">&")) {
      int fd = t.text[0] - '0'; char *amp = strstr(t.text, ">&");
      int target = amp[2] - '0'; free(t.text);
      if (fd == 2 && target == 1) {
        free(cur->err_file); cur->err_file = NULL; cur->err_to_out = 0;
        if (cur->out_file) {
          cur->err_file = xstrdup(cur->out_file);
          cur->err_append = 1;
        } else if (!cur->out_to_err) {
          /* Snapshot the stdout descriptor before any later redirect. */
          cur->err_to_out = 1;
        }
      } else if (fd == 1 && target == 2) {
        free(cur->out_file); cur->out_file = NULL; cur->out_to_err = 0;
        if (cur->err_file) {
          cur->out_file = xstrdup(cur->err_file);
          cur->append = cur->err_append;
          cur->err_append = 1;
        } else if (!cur->err_to_out) {
          /* Snapshot the stderr descriptor before any later redirect. */
          cur->out_to_err = 1;
        }
      } else {
        snprintf(parse_error, sizeof parse_error, "unsupported descriptor duplication %d>&%d", fd, target); return -1;
      }
      continue;
    }
    if (!t.quoted && (!strcmp(t.text, "&>") || !strcmp(t.text, "&>>"))) {
      int append = strstr(t.text, ">>") != NULL; free(t.text);
      Token file = next_token(&p, expand);
      if (!require_scalar_token(&file, "redirect") || (!file.quoted && is_operator_char(file.text[0]))) {
        free(file.text);
        if (!parse_error[0]) snprintf(parse_error, sizeof parse_error, "redirect needs a file");
        return -1;
      }
      free(cur->out_file); cur->out_file = file.text; cur->append = append; cur->out_to_err = 0;
      free(cur->err_file); cur->err_file = xstrdup(cur->out_file); cur->err_append = 1; cur->err_to_out = 0;
      continue;
    }
    if (!t.quoted && t.text[0] >= '0' && t.text[0] <= '9' && (t.text[1] == '>' || t.text[1] == '<')) {
      int fd = t.text[0] - '0'; int append = strstr(t.text, ">>") != NULL;
      int input = t.text[1] == '<'; free(t.text);
      Token file = next_token(&p, expand);
      if (!require_scalar_token(&file, "redirect") || (!file.quoted && is_operator_char(file.text[0]))) {
        free(file.text);
        if (!parse_error[0]) snprintf(parse_error, sizeof parse_error, "redirect needs a file");
        return -1;
      }
      if (fd == 2 && !input) {
        free(cur->err_file); cur->err_file = file.text;
        cur->err_append = append; cur->err_to_out = 0;
      }
      else if (fd == 1 && !input) { free(cur->out_file); cur->out_file = file.text; cur->append = append; cur->out_to_err = 0; }
      else if (input) { free(cur->in_file); cur->in_file = file.text; }
      else free(file.text);
      continue;
    }
    if (!t.quoted && (!strcmp(t.text, ">") || !strcmp(t.text, ">>") || !strcmp(t.text, "<"))) {
      int input = t.text[0] == '<', append = t.text[1] == '>'; free(t.text);
      Token file = next_token(&p, expand);
      if (!require_scalar_token(&file, "redirect") || (!file.quoted && is_operator_char(file.text[0]))) {
        free(file.text);
        if (!parse_error[0]) snprintf(parse_error, sizeof parse_error, "redirect needs a file");
        return -1;
      }
      if (input) { free(cur->in_file); cur->in_file = file.text; }
      else { free(cur->out_file); cur->out_file = file.text; cur->append = append; cur->out_to_err = 0; }
      continue;
    }
    if (expand) {
      if (t.positional_vector && shell_argc == 0) empty_vector = 1;
      if (!append_glob(cur, t)) return -1;
    }
    else if (!append_arg(cur, t.text)) return -1;
  }
  if (parse_error[0]) return -1;
  if (!cur->argc && n) { snprintf(parse_error, sizeof parse_error, "empty command after |"); return -1; }
  return cur->argc ? n + 1 : empty_vector && n == 0 ? -2 : 0;
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
    ".","source","break","continue","umask","return","exit","which","local",NULL};
  for (int i = 0; names[i]; i++) if (!strcmp(s, names[i])) return 1;
  return 0;
}

static int test_integer(const char *value, long *parsed, FILE *err) {
  char *end = NULL; errno = 0;
  long number = strtol(value, &end, 10);
  if (errno || end == value || *end) {
    fprintf(err, "slop: test: %s: integer expression expected\n", value); return 0;
  }
  *parsed = number; return 1;
}

/* This pinned WASI libc's stat() does not dereference the final link. Open the
 * target and use fstat() when lstat() reports one, preserving normal test(1)
 * behavior for -e/-f/-d/-s while leaving -h/-L to inspect the link itself. */
static int test_stat_follow(const char *path, struct stat *status) {
  if (lstat(path, status) != 0) return -1;
  if (!S_ISLNK(status->st_mode)) return 0;
  FILE *file = fopen(path, "rb");
  if (file) {
    int result = fstat(fileno(file), status); fclose(file); return result;
  }
  DIR *directory = opendir(path);
  if (directory) {
    memset(status, 0, sizeof *status); status->st_mode = S_IFDIR;
    closedir(directory); return 0;
  }
  return -1;
}

static int test_builtin(char **v, int n, FILE *err) {
  if (!n) return 1;
  if (!strcmp(v[0], "!")) {
    int nested = test_builtin(v + 1, n - 1, err);
    return nested == 2 ? 2 : nested == 0 ? 1 : 0;
  }
  if (n == 1) return *v[0] ? 0 : 1;
  if (n == 2) {
    if (!strcmp(v[0], "-n")) return *v[1] ? 0 : 1;
    if (!strcmp(v[0], "-z")) return *v[1] ? 1 : 0;
    if (!strcmp(v[0], "-r") || !strcmp(v[0], "-w") || !strcmp(v[0], "-x")) {
      fprintf(err, "slop: test: %s permission predicate unavailable; WASI exposes no permission modes\n", v[0]);
      return 2;
    }
    char path[PATH_CAP]; struct stat st;
    if (!resolve_path(v[1], path)) return 1;
    int symlink = !strcmp(v[0], "-h") || !strcmp(v[0], "-L");
    int ok = (symlink ? lstat(path, &st) : test_stat_follow(path, &st)) == 0;
    if (!strcmp(v[0], "-e")) return ok ? 0 : 1;
    if (!strcmp(v[0], "-f")) return ok && S_ISREG(st.st_mode) ? 0 : 1;
    if (!strcmp(v[0], "-d")) return ok && S_ISDIR(st.st_mode) ? 0 : 1;
    if (!strcmp(v[0], "-s")) return ok && st.st_size > 0 ? 0 : 1;
    if (!strcmp(v[0], "-h") || !strcmp(v[0], "-L")) return ok && S_ISLNK(st.st_mode) ? 0 : 1;
    if (!strcmp(v[0], "-p")) return ok && S_ISFIFO(st.st_mode) ? 0 : 1;
    fprintf(err, "slop: test: unsupported unary operator: %s\n", v[0]); return 2;
  }
  if (n == 3) {
    if (!strcmp(v[1], "=") || !strcmp(v[1], "==")) return strcmp(v[0], v[2]) ? 1 : 0;
    if (!strcmp(v[1], "!=")) return strcmp(v[0], v[2]) ? 0 : 1;
    if (!strcmp(v[1], "-nt") || !strcmp(v[1], "-ot")) {
      char p1[PATH_CAP], p2[PATH_CAP]; struct stat s1, s2;
      int first = resolve_path(v[0], p1) && test_stat_follow(p1, &s1) == 0;
      int second = resolve_path(v[2], p2) && test_stat_follow(p2, &s2) == 0;
      if (!strcmp(v[1], "-nt"))
        return first && (!second || s1.st_mtime > s2.st_mtime) ? 0 : 1;
      return second && (!first || s1.st_mtime < s2.st_mtime) ? 0 : 1;
    }
    if (!strcmp(v[1], "-eq") || !strcmp(v[1], "-ne") || !strcmp(v[1], "-lt") ||
        !strcmp(v[1], "-le") || !strcmp(v[1], "-gt") || !strcmp(v[1], "-ge")) {
      long a, b;
      if (!test_integer(v[0], &a, err) || !test_integer(v[2], &b, err)) return 2;
      if (!strcmp(v[1], "-eq")) return a == b ? 0 : 1;
      if (!strcmp(v[1], "-ne")) return a != b ? 0 : 1;
      if (!strcmp(v[1], "-lt")) return a < b ? 0 : 1;
      if (!strcmp(v[1], "-le")) return a <= b ? 0 : 1;
      if (!strcmp(v[1], "-gt")) return a > b ? 0 : 1;
      return a >= b ? 0 : 1;
    }
  }
  fprintf(err, "slop: test: unsupported expression\n"); return 2;
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

static void print_test_help(FILE *out) {
  fputs("usage: test EXPRESSION\n"
        "strings: STRING | -n STRING | -z STRING | STRING = STRING | STRING != STRING\n"
        "integers: INTEGER -eq|-ne|-lt|-le|-gt|-ge INTEGER  # strict decimal\n"
        "files: -e|-f|-d|-s|-h|-L PATH | PATH -nt|-ot PATH\n"
        "status: 0 true, 1 false, 2 malformed/unsupported; -r/-w/-x unavailable (no WASI modes)\n", out);
}

static void print_control_help(FILE *out, const char *name) {
  if (!strcmp(name, "shift"))
    fputs("usage: shift [COUNT]  # decimal 0..128; status 1 when COUNT exceeds $#\n", out);
  else if (!strcmp(name, "return"))
    fputs("usage: return [STATUS]  # decimal 0..255; functions and sourced scripts only\n", out);
  else
    fprintf(out, "usage: %s [STATUS]  # decimal status 0..255\n", name);
}

static void print_set_state(FILE *out) {
  fprintf(out, "errexit %s\nnounset %s\nxtrace %s\npipefail %s\n",
          option_errexit ? "on" : "off", option_nounset ? "on" : "off",
          option_xtrace ? "on" : "off", option_pipefail ? "on" : "off");
}

static int printf_format_valid(const char *format, FILE *err) {
  for (size_t i = 0; format[i]; i++) {
    if (format[i] == '\\') {
      if (!format[i + 1]) {
        fputs("slop: printf: trailing backslash in format\n", err); return 0;
      }
      if (!strchr("ntrb\\", format[i + 1])) {
        fprintf(err, "slop: printf: unsupported escape: \\%c\n", format[i + 1]); return 0;
      }
      i++;
    } else if (format[i] == '%') {
      if (!format[i + 1]) {
        fputs("slop: printf: dangling % in format\n", err); return 0;
      }
      if (!strchr("%scdiuoxX", format[i + 1])) {
        fprintf(err, "slop: printf: unsupported conversion: %%%c\n", format[i + 1]); return 0;
      }
      i++;
    }
  }
  return 1;
}

static int printf_number_valid(const char *value, char spec, FILE *err) {
  char *end = NULL;
  int signed_value = spec == 'd' || spec == 'i';
  errno = 0;
  if (!*value || isspace((unsigned char)*value) || (!signed_value && *value == '-')) goto invalid;
  if (signed_value) {
    long parsed = strtol(value, &end, 0);
    if (errno == ERANGE || end == value || *end || parsed < INT32_MIN || parsed > INT32_MAX) goto invalid;
  } else {
    unsigned long parsed = strtoul(value, &end, 0);
    if (errno == ERANGE || end == value || *end || parsed > UINT32_MAX) goto invalid;
  }
  return 1;
invalid:
  fprintf(err, "slop: printf: %%%c: invalid 32-bit %s integer: %s\n",
          spec, signed_value ? "signed" : "unsigned", value);
  return 0;
}

static int printf_arguments_valid(const char *format, char **v, int n, FILE *err) {
  int ai = 1;
  for (;;) {
    int before = ai;
    for (size_t i = 0; format[i]; i++) {
      if (format[i] == '\\') { i++; continue; }
      if (format[i] != '%') continue;
      char spec = format[++i];
      if (spec == '%') continue;
      if (ai < n) {
        if (strchr("diuoxX", spec) && !printf_number_valid(v[ai], spec, err)) return 0;
        ai++;
      }
    }
    if (ai == before || ai >= n) break;
  }
  return 1;
}

static int printf_builtin(char **v, int n, FILE *out, FILE *err) {
  int first = n > 0 && !strcmp(v[0], "--") ? 1 : 0;
  if (first >= n) {
    fputs("slop: printf: format required\n", err); return 2;
  }
  v += first; n -= first;
  const char *f = v[0];
  if (!printf_format_valid(f, err) || !printf_arguments_valid(f, v, n, err)) return 2;
  int ai = 1;
  for (;;) {
    int before = ai;
    for (size_t i = 0; f[i]; i++) {
      if (f[i] == '\\') {
        char pair[3] = {'\\', f[i + 1], 0}; print_escaped(out, pair); if (f[i + 1]) i++;
      } else if (f[i] == '%' && f[i + 1]) {
        char spec = f[++i];
        if (spec == '%') fputc('%', out);
        else if (spec == 's') fputs(ai < n ? v[ai++] : "", out);
        else if (spec == 'd' || spec == 'i') fprintf(out, "%ld", ai < n ? strtol(v[ai++], NULL, 0) : 0L);
        else if (spec == 'u') fprintf(out, "%lu", ai < n ? strtoul(v[ai++], NULL, 0) : 0UL);
        else if (spec == 'x' || spec == 'X') {
          unsigned long value = ai < n ? strtoul(v[ai++], NULL, 0) : 0UL;
          fprintf(out, spec == 'x' ? "%lx" : "%lX", value);
        }
        else if (spec == 'o') fprintf(out, "%lo", ai < n ? strtoul(v[ai++], NULL, 0) : 0UL);
        else if (spec == 'c') fputc(ai < n ? v[ai++][0] : 0, out);
      } else fputc(f[i], out);
    }
    if (ai == before || ai >= n) break;
  }
  return 0;
}

static char *read_file(const char *name, int *length, int cap, FILE *err) {
  char path[PATH_CAP];
  if (!resolve_path(name, path)) { fprintf(err, "slop: path too long: %s\n", name); return NULL; }
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(err, "slop: %s: %s\n", name, strerror(errno)); return NULL; }
  char *data = xmalloc((size_t)cap + 1); size_t n = fread(data, 1, (size_t)cap, f);
  if (!feof(f)) { fprintf(err, "slop: %s exceeds %d-byte input limit\n", name, cap); fclose(f); free(data); return NULL; }
  if (ferror(f)) { fprintf(err, "slop: %s: read error\n", name); fclose(f); free(data); return NULL; }
  fclose(f); data[n] = 0; *length = (int)n; return data;
}

static void print_help(FILE *out) {
  fputs("slop - build-oriented shell for piodide\n"
        "usage: slop [-c command [name [args...]]] [script [args...]]\n"
        "syntax: quotes, $var/${var:-default}, $(command), $((arith)), $?, standalone quoted \"$@\", globs\n"
        "        redirects: < > >> 2> 2>> 2>&1 >&2 1>&2 &> |\n"
        "        redirects/pipelines preserve bytes; command substitution rejects NUL with status 2\n"
        "        /dev/null is an exact virtual EOF source and output sink; other /dev redirects fail\n"
        "        lists: && || ;\n"
        "blocks: if/then/elif/else/fi, for/in/do/done, while/do/done, case/esac\n"
        "functions: name() { ... }\n"
        "options: set -e, set -u, set -x, set -o pipefail (combined -euo works)\n"
        "help: help [BUILTIN] prints the bounded builtin contract\n"
        "builtins: help cd pwd echo printf set export local unset test [ shift read type which command source eval return exit break continue true false\n"
        "unavailable: readonly and umask fail with status 2; WASI exposes no permission modes\n"
        "search: rg PATTERN [PATH...] or rg --files; use python for JSON, tables, and archives\n", out);
}

static int print_builtin_help(const char *name, FILE *out) {
  if (!strcmp(name, "help")) { print_help(out); return 1; }
  if (!strcmp(name, "pwd")) fputs("usage: pwd [-L|--logical] [--]  # logical cwd; -P is unavailable\n", out);
  else if (!strcmp(name, "cd")) fputs("usage: cd [-L] [--] [DIR|-]  # logical cwd; -P is unavailable\n", out);
  else if (!strcmp(name, "echo"))
    fputs("usage: echo [-n] [ARG...]  # only the first exact -n is special; no escapes or option terminator\n", out);
  else if (!strcmp(name, "printf"))
    fputs("usage: printf [--] FORMAT [ARG...]\n"
          "formats: %% %s %c %d %i %u %o %x %X; escapes: \\n \\t \\r \\b \\\\\n"
          "numbers: fully consumed 32-bit base-0 integers; formats repeat for remaining arguments\n"
          "missing args: %s is empty, integers are zero, and %c emits NUL; %c uses the first byte\n", out);
  else if (!strcmp(name, "set"))
    fputs("usage: set [-/+eux] [-/+o pipefail]\n"
          "       set -- [ARG...]  # replace this scope's positional parameters atomically\n"
          "       set  # prints bounded option state\n"
          "limits: 100 arguments, 4096 bytes each, 65536 bytes total; option and positional forms cannot be combined\n", out);
  else if (!strcmp(name, "export")) fputs("usage: export [--] NAME[=VALUE]...  # all shell variables are exported\n", out);
  else if (!strcmp(name, "readonly")) fputs("usage: readonly NAME[=VALUE]...  # unavailable; variables remain mutable\n", out);
  else if (!strcmp(name, "unset")) fputs("usage: unset [--] NAME...  # validates every name before changing the environment\n", out);
  else if (!strcmp(name, "local")) fputs("usage: local [--] NAME[=VALUE]...  # functions only; validates all names first\n", out);
  else if (!strcmp(name, "test")) print_test_help(out);
  else if (!strcmp(name, "[")) fputs("usage: [ EXPRESSION ]  # same bounded predicates and statuses as test\n", out);
  else if (!strcmp(name, "shift")) print_control_help(out, "shift");
  else if (!strcmp(name, "read"))
    fputs("usage: read [-r] [--] [NAME]  # one raw line, max 4095 bytes; default NAME is REPLY\n", out);
  else if (!strcmp(name, "command"))
    fputs("usage: command -v [--] NAME... | command [--] NAME [ARG...]  # invocation bypasses functions\n", out);
  else if (!strcmp(name, "type")) fputs("usage: type [--] NAME...\n", out);
  else if (!strcmp(name, "which")) fputs("usage: which [--] NAME...  # includes builtins and functions\n", out);
  else if (!strcmp(name, "source") || !strcmp(name, "."))
    fputs("usage: source [--] FILE [ARG...]  # arguments are scoped; return exits the sourced file\n", out);
  else if (!strcmp(name, "eval")) fputs("usage: eval [ARG...]  # joined command text; at most 8 nested evals\n", out);
  else if (!strcmp(name, "return")) print_control_help(out, "return");
  else if (!strcmp(name, "exit")) print_control_help(out, "exit");
  else if (!strcmp(name, "break") || !strcmp(name, "continue"))
    fprintf(out, "usage: %s [1]  # current loop only\n", name);
  else if (!strcmp(name, "umask")) fputs("usage: umask [MODE]  # unavailable; WASI exposes no permission modes\n", out);
  else if (!strcmp(name, ":") || !strcmp(name, "true") || !strcmp(name, "false"))
    fprintf(out, "usage: %s [ARG...]\n", name);
  else return 0;
  return 1;
}

static int run_builtin(Command *c, FILE *out, FILE *err, const char *input, int input_len) {
  char **a = c->argv; int n = c->argc; const char *name = a[0];
  if (!strcmp(name, ":") || !strcmp(name, "true")) return 0;
  if (!strcmp(name, "false")) return 1;
  if (!strcmp(name, "pwd")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_builtin_help(name, out); return 0; }
    int index = 1;
    while (index < n) {
      if (!strcmp(a[index], "--")) { index++; break; }
      if (!strcmp(a[index], "-L") || !strcmp(a[index], "--logical")) { index++; continue; }
      if (!strcmp(a[index], "-P") || !strcmp(a[index], "--physical")) {
        fputs("slop: pwd: physical cwd resolution is unavailable\n", err); return 2;
      }
      if (a[index][0] == '-' && a[index][1]) {
        fprintf(err, "slop: pwd: unsupported option: %s\n", a[index]); return 2;
      }
      break;
    }
    if (index < n) { fprintf(err, "slop: pwd: unsupported operand: %s\n", a[index]); return 2; }
    fprintf(out, "%s\n", cwd); return 0;
  }
  if (!strcmp(name, "help")) {
    if (n == 1) { print_help(out); return 0; }
    if (n > 2) { fputs("slop: help: expected at most one builtin name\n", err); return 2; }
    if (print_builtin_help(a[1], out)) return 0;
    fprintf(err, "slop: help: no help for %s\n", a[1]); return 1;
  }
  if (!strcmp(name, "cd")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_builtin_help(name, out); return 0; }
    int index = 1;
    while (index < n && strcmp(a[index], "-")) {
      if (!strcmp(a[index], "--")) { index++; break; }
      if (!strcmp(a[index], "-L") || !strcmp(a[index], "--logical")) { index++; continue; }
      if (!strcmp(a[index], "-P") || !strcmp(a[index], "--physical")) {
        fputs("slop: cd: physical cwd resolution is unavailable\n", err); return 2;
      }
      if (a[index][0] == '-' && a[index][1]) {
        fprintf(err, "slop: cd: unsupported option: %s\n", a[index]); return 2;
      }
      break;
    }
    if (n > index + 1) { fprintf(err, "slop: cd: too many arguments\n"); return 2; }
    int previous = n > index && !strcmp(a[index], "-");
    const char *dest = n > index ? (previous ? getenv("OLDPWD") : a[index]) : getenv("HOME");
    char path[PATH_CAP];
    if (!dest || !resolve_path(dest, path) || !is_dir(path)) { fprintf(err, "slop: cd: %s: no such directory\n", dest ? dest : ""); return 1; }
    char old[PATH_CAP]; snprintf(old, sizeof old, "%s", cwd);
    snprintf(cwd, sizeof cwd, "%s", path); setenv("OLDPWD", old, 1); setenv("PWD", cwd, 1);
    if (previous) fprintf(out, "%s\n", cwd);
    return 0;
  }
  if (!strcmp(name, "echo")) {
    int i = 1, newline = 1;
    if (i < n && !strcmp(a[i], "-n")) { newline = 0; i++; }
    for (; i < n; i++) { if (i > (newline ? 1 : 2)) fputc(' ', out); fputs(a[i], out); }
    if (newline) fputc('\n', out); return 0;
  }
  if (!strcmp(name, "printf")) return printf_builtin(a + 1, n - 1, out, err);
  if (!strcmp(name, "set")) {
    if (n == 1) { print_set_state(out); return 0; }
    if (n == 2 && !strcmp(a[1], "--help")) {
      print_builtin_help(name, out);
      return 0;
    }
    if (!strcmp(a[1], "--")) return replace_positionals(a + 2, n - 2, err);
    int errexit = option_errexit, nounset = option_nounset;
    int xtrace = option_xtrace, pipefail = option_pipefail;
    for (int i = 1; i < n; i++) {
      if (!strcmp(a[i], "--")) {
        fputs("slop: set: -- must be the first operand for positional replacement\n", err); return 2;
      }
      else if ((!strcmp(a[i], "-o") || !strcmp(a[i], "+o")) && i + 1 < n) {
        int enabled = a[i][0] == '-';
        if (strcmp(a[++i], "pipefail")) { fprintf(err, "slop: set: unsupported option: %s\n", a[i]); return 2; }
        pipefail = enabled;
      }
      else if ((a[i][0] == '-' || a[i][0] == '+') && a[i][1]) {
        int enabled = a[i][0] == '-';
        for (const char *flag = a[i] + 1; *flag; flag++) {
          if (*flag == 'e') errexit = enabled;
          else if (*flag == 'u') nounset = enabled;
          else if (*flag == 'x') xtrace = enabled;
          else if (*flag == 'o') {
            if (flag[1] || i + 1 >= n || strcmp(a[i + 1], "pipefail")) {
              fprintf(err, "slop: set: -o requires supported option 'pipefail'\n"); return 2;
            }
            pipefail = enabled; i++;
          } else { fprintf(err, "slop: set: unsupported flag: %c\n", *flag); return 2; }
        }
      }
      else { fprintf(err, "slop: set: unsupported option: %s\n", a[i]); return 2; }
    }
    option_errexit = errexit; option_nounset = nounset;
    option_xtrace = xtrace; option_pipefail = pipefail;
    return 0;
  }
  if (!strcmp(name, "readonly")) {
    if (n == 2 && !strcmp(a[1], "--help")) {
      fputs("usage: readonly NAME[=VALUE]...  # unavailable; variables remain mutable\n", out);
      return 0;
    }
    fputs("slop: readonly is unavailable; variables are mutable in this bounded shell\n", err);
    return 2;
  }
  if (!strcmp(name, "export")) {
    if (n == 2 && !strcmp(a[1], "--help")) {
      fputs("usage: export [--] NAME[=VALUE]...  # all shell variables are exported\n", out);
      return 0;
    }
    int first = n > 1 && !strcmp(a[1], "--") ? 2 : 1;
    for (int i = first; i < n; i++) {
      const char *eq;
      if (assignment_word(a[i], &eq)) {
        if ((size_t)(eq - a[i]) >= 128) { fputs("slop: export: name too long\n", err); return 2; }
      } else if (!valid_name_n(a[i], strlen(a[i]))) {
        fprintf(err, "slop: export: invalid name: %s\n", a[i]); return 2;
      }
    }
    for (int i = first; i < n; i++) {
      const char *eq;
      if (assignment_word(a[i], &eq)) {
        size_t z = (size_t)(eq - a[i]); char key[128];
        memcpy(key, a[i], z); key[z] = 0;
        if (setenv(key, eq + 1, 1)) { fprintf(err, "slop: export: %s\n", strerror(errno)); return 2; }
      }
    }
    return 0;
  }
  if (!strcmp(name, "unset")) {
    if (n == 2 && !strcmp(a[1], "--help")) {
      fputs("usage: unset [--] NAME...  # validates every name before changing the environment\n", out);
      return 0;
    }
    int first = n > 1 && !strcmp(a[1], "--") ? 2 : 1;
    for (int i = first; i < n; i++)
      if (!valid_name_n(a[i], strlen(a[i]))) {
        fprintf(err, "slop: unset: invalid name: %s\n", a[i]); return 2;
      }
    for (int i = first; i < n; i++)
      if (unsetenv(a[i])) { fprintf(err, "slop: unset: %s\n", strerror(errno)); return 2; }
    return 0;
  }
  if (!strcmp(name, "local")) {
    if (n == 2 && !strcmp(a[1], "--help")) {
      fputs("usage: local [--] NAME[=VALUE]...  # functions only; validates all names first\n", out);
      return 0;
    }
    if (!function_depth) { fprintf(err, "slop: local: not in a function\n"); return 2; }
    AssignmentScope *scope = &function_locals[function_depth - 1];
    int first = n > 1 && !strcmp(a[1], "--") ? 2 : 1;
    int needed = 0;
    for (int i = first; i < n; i++) {
      const char *eq = NULL;
      size_t length = strlen(a[i]);
      if (assignment_word(a[i], &eq)) length = (size_t)(eq - a[i]);
      if (!valid_name_n(a[i], length)) { fprintf(err, "slop: local: invalid name: %s\n", a[i]); return 2; }
      if (length >= 128) { fprintf(err, "slop: local: name too long\n"); return 2; }
      int already_saved = 0;
      for (int item = 0; item < scope->count; item++)
        if (strlen(scope->items[item].name) == length && !strncmp(scope->items[item].name, a[i], length)) already_saved = 1;
      for (int previous = first; previous < i && !already_saved; previous++) {
        const char *previous_eq = strchr(a[previous], '=');
        size_t previous_length = previous_eq ? (size_t)(previous_eq - a[previous]) : strlen(a[previous]);
        if (previous_length == length && !strncmp(a[previous], a[i], length)) already_saved = 1;
      }
      if (!already_saved) needed++;
    }
    if (scope->count + needed > MAX_ARGS) { fprintf(err, "slop: local: too many variables\n"); return 2; }
    for (int i = first; i < n; i++) {
      const char *eq = NULL;
      size_t length = strlen(a[i]);
      if (assignment_word(a[i], &eq)) length = (size_t)(eq - a[i]);
      char namebuf[128];
      memcpy(namebuf, a[i], length); namebuf[length] = 0;
      int already_saved = 0;
      for (int item = 0; item < scope->count; item++)
        if (!strcmp(scope->items[item].name, namebuf)) already_saved = 1;
      if (!already_saved) {
        const char *old = getenv(namebuf);
        SavedAssignment *saved = &scope->items[scope->count++];
        saved->name = xstrdup(namebuf); saved->value = old ? xstrdup(old) : NULL;
        saved->was_set = old != NULL;
      }
      if (setenv(namebuf, eq ? eq + 1 : "", 1)) return 2;
    }
    return 0;
  }
  if (!strcmp(name, "test")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_test_help(out); return 0; }
    return test_builtin(a + 1, n - 1, err);
  }
  if (!strcmp(name, "[")) {
    if (n < 2 || strcmp(a[n - 1], "]")) {
      fputs("slop: [: missing ']'\n", err); return 2;
    }
    return test_builtin(a + 1, n - 2, err);
  }
  if (!strcmp(name, "shift")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_control_help(out, name); return 0; }
    int by = 1;
    if (n > 2 || (n == 2 && !decimal_in_range(a[1], MAX_ARGS, &by))) {
      fputs("slop: shift: expected at most one decimal count from 0 to 128\n", err); return 2;
    }
    if (by > shell_argc) {
      fprintf(err, "slop: shift: %d exceeds %d positional parameters\n", by, shell_argc); return 1;
    }
    shell_argv += by; shell_argc -= by; return 0;
  }
  if (!strcmp(name, "read")) {
    if (n > 1 && !strcmp(a[1], "--help")) {
      print_builtin_help(name, out);
      return 0;
    }
    int index = 1, raw = 0;
    while (index < n && a[index][0] == '-' && a[index][1]) {
      if (!strcmp(a[index], "--")) { index++; break; }
      if (strspn(a[index] + 1, "r") == strlen(a[index] + 1)) { raw = 1; index++; continue; }
      fprintf(err, "slop: read: unsupported option: %s\n", a[index]); return 2;
    }
    if (n - index > 1) { fprintf(err, "slop: read: only one variable is supported\n"); return 2; }
    const char *var = index < n ? a[index] : "REPLY";
    if (!valid_name_n(var, strlen(var))) { fprintf(err, "slop: read: invalid name: %s\n", var); return 2; }
    char line[READ_VALUE_CAP]; size_t z = 0;
    if (input && input_len <= 0) return 1;
    if (input) {
      while (z < (size_t)input_len && input[z] != '\n') z++;
      if (z >= sizeof line) {
        fprintf(err, "slop: read: line too long (max %d bytes)\n", READ_VALUE_CAP - 1); return 2;
      }
      memcpy(line, input, z);
    } else {
      if (!fgets(line, sizeof line, stdin)) {
        if (ferror(stdin)) { fputs("slop: read: input error\n", err); return 2; }
        return 1;
      }
      size_t got = strlen(line);
      if (got && line[got - 1] == '\n') z = got - 1;
      else if (got == sizeof line - 1) {
        int next = fgetc(stdin);
        if (next != '\n' && next != EOF) {
          do next = fgetc(stdin); while (next != '\n' && next != EOF);
          fprintf(err, "slop: read: line too long (max %d bytes)\n", READ_VALUE_CAP - 1); return 2;
        }
        z = got;
      } else z = got;
    }
    if (z && line[z - 1] == '\r') z--;
    line[z] = 0;
    if (setenv(var, line, 1)) { fprintf(err, "slop: read: %s\n", strerror(errno)); return 2; }
    (void)raw; return 0;
  }
  if (!strcmp(name, "command")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_builtin_help(name, out); return 0; }
    if (n > 1 && !strcmp(a[1], "-v")) {
      int terminated = n > 2 && !strcmp(a[2], "--");
      int first = terminated ? 3 : 2;
      if (first >= n) { fputs("slop: command -v: name required\n", err); return 2; }
      if (!terminated)
        for (int i = first; i < n; i++) if (a[i][0] == '-' && a[i][1]) {
          fprintf(err, "slop: command: unsupported option: %s\n", a[i]); return 2;
        }
      int rc = 0;
      for (int i = first; i < n; i++) { char path[PATH_CAP]; if (builtin_name(a[i])) fprintf(out, "%s\n", a[i]); else if (find_function(a[i])) fprintf(out, "%s\n", a[i]); else if (find_command(a[i], path)) fprintf(out, "%s\n", path); else rc = 1; }
      return rc;
    }
    if (n == 1 || (n == 2 && !strcmp(a[1], "--"))) {
      fputs("slop: command: target required\n", err); return 2;
    }
    fprintf(err, "slop: command: unsupported option: %s\n", a[1]); return 2;
  }
  if (!strcmp(name, "which")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_builtin_help(name, out); return 0; }
    int first = n > 1 && !strcmp(a[1], "--") ? 2 : 1;
    if (first >= n) { fputs("slop: which: name required\n", err); return 2; }
    if (first == 1)
      for (int i = first; i < n; i++) if (a[i][0] == '-' && a[i][1]) {
        fprintf(err, "slop: which: unsupported option: %s\n", a[i]); return 2;
      }
    int rc = 0;
    for (int i = first; i < n; i++) {
      char path[PATH_CAP];
      if (builtin_name(a[i])) fprintf(out, "%s\n", a[i]);
      else if (find_function(a[i])) fprintf(out, "%s\n", a[i]);
      else if (find_command(a[i], path)) fprintf(out, "%s\n", path);
      else rc = 1;
    }
    return rc;
  }
  if (!strcmp(name, "eval")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_builtin_help(name, out); return 0; }
    if (eval_depth >= MAX_EVAL_DEPTH) {
      fprintf(err, "slop: eval: recursion limit (%d) exceeded\n", MAX_EVAL_DEPTH); return 2;
    }
    Buf text; binit(&text); for (int i = 1; i < n; i++) { if (i > 1) bputc(&text, ' '); bputs(&text, a[i]); }
    eval_depth++; int rc = execute_command_list(text.s); eval_depth--;
    free(text.s); return rc;
  }
  if (!strcmp(name, "umask")) {
    if (n == 2 && !strcmp(a[1], "--help")) {
      fputs("usage: umask [MODE]  # unavailable; WASI exposes no permission modes\n", out);
      return 0;
    }
    fputs("slop: umask is unavailable; WASI exposes no permission modes\n", err);
    return 2;
  }
  if (!strcmp(name, "return")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_control_help(out, name); return 0; }
    if (!function_depth && !source_depth) {
      fprintf(err, "slop: return: not in a function or sourced script\n"); return 2;
    }
    int status = last_status;
    if (n > 2 || (n == 2 && !decimal_in_range(a[1], 255, &status))) {
      fputs("slop: return: expected at most one decimal status from 0 to 255\n", err);
      flow_signal = 3; return 2;
    }
    flow_signal = 3; return status;
  }
  if (!strcmp(name, "exit")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_control_help(out, name); return 0; }
    int status = last_status;
    if (n > 2 || (n == 2 && !decimal_in_range(a[1], 255, &status))) {
      fputs("slop: exit: expected at most one decimal status from 0 to 255\n", err);
      status = 2;
    }
    exit_status = status; exit_requested = 1; return status;
  }
  if (!strcmp(name, "type")) {
    if (n == 2 && !strcmp(a[1], "--help")) { print_builtin_help(name, out); return 0; }
    int first = n > 1 && !strcmp(a[1], "--") ? 2 : 1;
    if (first >= n) { fputs("slop: type: name required\n", err); return 2; }
    if (first == 1)
      for (int i = first; i < n; i++) if (a[i][0] == '-' && a[i][1]) {
        fprintf(err, "slop: type: unsupported option: %s\n", a[i]); return 2;
      }
    int rc = 0;
    for (int i = first; i < n; i++) {
      char path[PATH_CAP];
      if (builtin_name(a[i])) fprintf(out, "%s is a shell builtin\n", a[i]);
      else if (find_function(a[i])) fprintf(out, "%s is a function\n", a[i]);
      else if (find_command(a[i], path)) fprintf(out, "%s is %s\n", a[i], path);
      else { fprintf(err, "slop: type: %s: not found\n", a[i]); rc = 1; }
    }
    return rc;
  }
  if (!strcmp(name, ".") || !strcmp(name, "source")) {
    if (n == 2 && !strcmp(a[1], "--help")) {
      fputs("usage: source [--] FILE [ARG...]  # arguments are scoped; return exits the sourced file\n", out);
      return 0;
    }
    int file = n > 1 && !strcmp(a[1], "--") ? 2 : 1;
    if (file >= n) { fprintf(err, "slop: %s: filename required\n", name); return 2; }
    if (source_depth >= MAX_SOURCE_DEPTH) {
      fprintf(err, "slop: source: recursion limit (%d) exceeded\n", MAX_SOURCE_DEPTH); return 2;
    }
    int z; char *script = read_file(a[file], &z, SCRIPT_CAP, err); (void)z;
    if (!script) return 1;
    int saved_argc = shell_argc; char **saved_argv = shell_argv;
    char **saved_owned_argv = owned_shell_argv; owned_shell_argv = NULL;
    if (file + 1 < n) { shell_argc = n - file - 1; shell_argv = a + file + 1; }
    source_depth++;
    int rc = execute_script(script);
    source_depth--;
    if (flow_signal == 3) flow_signal = 0;
    free_owned_positionals();
    shell_argc = saved_argc; shell_argv = saved_argv; owned_shell_argv = saved_owned_argv;
    free(script); return rc;
  }
  if (!strcmp(name, "break") || !strcmp(name, "continue")) {
    if (n == 2 && !strcmp(a[1], "--help")) {
      fprintf(out, "usage: %s [1]  # current loop only\n", name); return 0;
    }
    if (n > 2 || (n == 2 && strcmp(a[1], "1"))) {
      fprintf(err, "slop: %s: only level 1 is supported\n", name); return 2;
    }
    if (!loop_depth) { fprintf(err, "slop: %s: not in a loop\n", name); return 2; }
    flow_signal = !strcmp(name, "break") ? 1 : 2; return 0;
  }
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
  return !strcmp(s, "cc") || !strcmp(s, "compile") || !strcmp(s, "ld") ||
    !strcmp(s, "link") || !strcmp(s, "/bin/cc") || !strcmp(s, "/bin/compile") ||
    !strcmp(s, "/bin/ld") || !strcmp(s, "/bin/link") ||
    !strcmp(s, "python") || !strcmp(s, "python3") ||
    !strcmp(s, "/bin/python") || !strcmp(s, "/bin/python3") ||
    !strcmp(s, "curl") || !strcmp(s, "/bin/curl");
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

static int command_dispatch_prefix(const Command *c, int index) {
  if (index >= c->argc || strcmp(c->argv[index], "command") || index + 1 >= c->argc) return 0;
  const char *next = c->argv[index + 1];
  if (!strcmp(next, "-v") || !strcmp(next, "--help")) return 0;
  if (!strcmp(next, "--")) return index + 2 < c->argc ? 2 : 0;
  return next[0] == '-' && next[1] ? 0 : 1;
}

static void normalize_command_dispatch(Command *c) {
  int remove;
  while ((remove = command_dispatch_prefix(c, 0)) != 0) {
    for (int i = 0; i < remove; i++) free(c->argv[i]);
    for (int i = remove; i < c->argc; i++) c->argv[i - remove] = c->argv[i];
    c->argc -= remove; c->argv[c->argc] = NULL;
    c->command_bypass = 1;
  }
}

static int unsupported_redirect_device(const char *path) {
  return !strncmp(path, "/dev/", 5) && strcmp(path, "/dev/null");
}

static int load_redirect(const char *name, size_t limit) {
  char path[PATH_CAP];
  if (!resolve_path(name, path)) { fprintf(stderr, "slop: %s: path too long\n", name); return -1; }
  if (!strcmp(path, "/dev/null")) return 0;
  if (unsupported_redirect_device(path)) {
    fprintf(stderr, "slop: %s: unsupported redirect device\n", name); return -1;
  }
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "slop: %s: %s\n", name, strerror(errno)); return -1; }
  size_t n = fread(redirect_input, 1, limit, f);
  if (ferror(f)) { fprintf(stderr, "slop: %s: cannot read\n", name); fclose(f); return -1; }
  if (n == limit) {
    int extra = fgetc(f);
    if (extra != EOF) {
      fprintf(stderr, "slop: %s: input exceeds %zu bytes\n", name, limit);
      fclose(f); return -2;
    }
    if (ferror(f)) { fprintf(stderr, "slop: %s: cannot read\n", name); fclose(f); return -1; }
  }
  fclose(f); return (int)n;
}

static ssize_t discard_null_output(void *cookie, const char *data, size_t size) {
  (void)cookie; (void)data; return (ssize_t)size;
}

static FILE *open_builtin_redirect(const char *path, int append) {
  if (!strcmp(path, "/dev/null")) {
    cookie_io_functions_t io = { .write = discard_null_output };
    FILE *sink = fopencookie(NULL, "w", io);
    if (sink) setvbuf(sink, NULL, _IONBF, 0);
    return sink;
  }
  if (!append) {
    FILE *truncate = fopen(path, "w");
    if (!truncate) return NULL;
    fclose(truncate);
  }
  return fopen(path, "a");
}

static int append_command_substitution(const char *data, int length) {
  if (length < 0 || length > PIPE_CAP - capture_length) {
    fprintf(stderr, "slop: command substitution output exceeds %d bytes; write it to a file instead\n", PIPE_CAP);
    return 0;
  }
  if (memchr(data, '\0', (size_t)length)) {
    snprintf(parse_error, sizeof parse_error,
             "command substitution output contains NUL; use a file or pipeline instead");
    return -1;
  }
  memcpy(capture_buffer + capture_length, data, (size_t)length);
  capture_length += length;
  return 1;
}

static int run_pipeline(Command *cmds, int ncmd) {
  static char blob[SPAWN_ARG_CAP];
  char resolved[PATH_CAP], out_path[PATH_CAP], err_path[PATH_CAP];
  char *cur = pipe_a, *next = pipe_b;
  const char *previous = NULL; int previous_len = 0, code = 0, pipeline_failure = 0;
  if (ncmd > 1) {
    for (int i = 0; i < ncmd; i++) {
      int command = 0; const char *eq;
      while (command < cmds[i].argc && assignment_word(cmds[i].argv[command], &eq)) command++;
      int remove;
      while ((remove = command_dispatch_prefix(&cmds[i], command)) != 0) command += remove;
      if (command < cmds[i].argc && !strcmp(cmds[i].argv[command], "exit")) {
        fputs("slop: exit: pipelines are unsupported\n", stderr); return 2;
      }
    }
  }
  for (int i = 0; i < ncmd; i++) {
    Command *c = &cmds[i]; int last = i + 1 == ncmd;
    AssignmentScope assignments; memset(&assignments, 0, sizeof assignments);
    if (apply_assignments(c, &assignments) < 0) return 2;
    if (!c->argc) { code = substitution_status; if (code) pipeline_failure = code; continue; }
    normalize_command_dispatch(c);

    const char *input = previous; int input_len = previous_len;
    if (c->in_file) {
      int base64_redirect = !strcmp(c->argv[0], "base64") ||
                            !strcmp(c->argv[0], "/bin/base64");
      int large_redirect = base64_redirect || !strcmp(c->argv[0], "strings") ||
                           !strcmp(c->argv[0], "/bin/strings");
      size_t redirect_limit = large_redirect ? LARGE_REDIRECT_CAP : PIPE_CAP;
      input_len = load_redirect(c->in_file, redirect_limit);
      if (input_len < 0) {
        restore_assignments(&assignments);
        return input_len == -2 && base64_redirect ? 4 : 1;
      }
      input = redirect_input;
    }
    const char *out_file = redirect_context.out_file;
    int out_append = out_file ? 1 : 0;
    if (c->out_file) {
      if (!resolve_path(c->out_file, out_path)) { fprintf(stderr, "slop: output path too long\n"); restore_assignments(&assignments); return 1; }
      if (unsupported_redirect_device(out_path)) {
        fprintf(stderr, "slop: %s: unsupported redirect device\n", c->out_file);
        restore_assignments(&assignments); return 1;
      }
      out_file = out_path;
      out_append = c->append;
    }
    const char *efile = redirect_context.err_file;
    int err_append = efile ? 1 : 0;
    if (c->err_file) {
      if (!resolve_path(c->err_file, err_path)) { fprintf(stderr, "slop: error path too long\n"); restore_assignments(&assignments); return 1; }
      if (unsupported_redirect_device(err_path)) {
        fprintf(stderr, "slop: %s: unsupported redirect device\n", c->err_file);
        restore_assignments(&assignments); return 1;
      }
      efile = err_path;
      err_append = c->err_append;
    }
    int err_to_out = 0, err_to_inherited_out = 0, out_to_inherited_err = 0;
    if (c->err_to_out) {
      if (redirect_context.out_file) { efile = redirect_context.out_file; err_append = 1; }
      else if ((!last || capture_active) && !c->out_to_err) {
        /* A pipeline/substitution capture is the command's stdout descriptor.
         * Keep 2>&1 in that byte-preserving route instead of leaking it to the
         * shell's inherited stdout. */
        efile = NULL; err_to_out = 1;
      } else { efile = NULL; err_to_inherited_out = 1; }
    }
    if (c->out_to_err) {
      if (redirect_context.err_file) { out_file = redirect_context.err_file; out_append = 1; }
      else { out_file = NULL; out_to_inherited_err = 1; }
    }

    Function *fn = NULL;
    int is_builtin = builtin_name(c->argv[0]);
    if (!is_builtin && !c->command_bypass) fn = find_function(c->argv[0]);

    if (fn && (input || c->in_file || c->out_file || c->err_file || c->err_to_out || c->out_to_err || !last || capture_active)) {
      fprintf(stderr, "slop: function redirection, pipelines, and substitution are unsupported\n");
      restore_assignments(&assignments); return 2;
    }

    if (is_builtin || fn) {
      FILE *out = redirect_context.out ? redirect_context.out : stdout; int capture = 0;
      FILE *err = redirect_context.err ? redirect_context.err : stderr;
      int close_out = 0, close_err = 0;
      if (c->out_file) {
        out = open_builtin_redirect(out_file, c->append);
        if (!out) { fprintf(stderr, "slop: %s: %s\n", c->out_file, strerror(errno)); restore_assignments(&assignments); return 1; }
        close_out = 1;
      } else if ((!last || capture_active) && !c->out_to_err && !redirect_context.out) {
        out = fmemopen(cur, PIPE_CAP, "w"); capture = 1;
        if (!out) { restore_assignments(&assignments); return 1; }
      }
      if (c->err_file) {
        if (c->out_file && !strcmp(out_file, efile)) err = out;
        else {
          err = open_builtin_redirect(efile, c->err_append);
          close_err = 1;
        }
        if (!err) { fprintf(stderr, "slop: %s: %s\n", c->err_file, strerror(errno)); if (capture || close_out) fclose(out); restore_assignments(&assignments); return 1; }
      } else if (c->err_to_out) {
        err = err_to_out ? out : redirect_context.out ? redirect_context.out : stdout;
      }
      if (c->out_to_err) out = redirect_context.err ? redirect_context.err : stderr;

      RedirectContext saved_redirect = redirect_context;
      redirect_context.out = out;
      redirect_context.err = err;
      redirect_context.out_file = c->out_to_err ? saved_redirect.err_file : out_file;
      redirect_context.err_file = c->err_to_out ? saved_redirect.out_file : efile;

      if (fn) {
        if (function_depth >= MAX_FUNCTION_DEPTH) {
          fprintf(stderr, "slop: function recursion limit (%d) exceeded\n", MAX_FUNCTION_DEPTH);
          code = 2;
          if (capture || close_out) fclose(out);
          if (close_err) fclose(err);
          redirect_context = saved_redirect;
          restore_assignments(&assignments);
          return code;
        }
        int saved_argc = shell_argc; char **saved_argv = shell_argv;
        char **saved_owned_argv = owned_shell_argv; owned_shell_argv = NULL;
        const char *saved_name = shell_name;
        shell_argc = c->argc - 1; shell_argv = c->argv + 1; shell_name = c->argv[0];
        char *body = xstrdup(fn->body);
        memset(&function_locals[function_depth], 0, sizeof function_locals[function_depth]);
        function_depth++;
        code = execute_script(body);
        restore_assignments(&function_locals[function_depth - 1]);
        function_depth--;
        free(body);
        free_owned_positionals();
        shell_argc = saved_argc; shell_argv = saved_argv;
        owned_shell_argv = saved_owned_argv; shell_name = saved_name;
        if (flow_signal == 3) flow_signal = 0;
      } else {
        code = run_builtin(c, out, err, input, input_len);
      }
      redirect_context = saved_redirect;

      if (capture) {
        int overflow = fflush(out) == EOF || ferror(out);
        previous_len = (int)ftell(out);
        if (fclose(out) == EOF) overflow = 1;
        if (overflow || previous_len > PIPE_CAP) {
          fprintf(stderr, "slop: command output exceeds %d bytes; write it to a file instead\n", PIPE_CAP);
          if (close_err) fclose(err);
          restore_assignments(&assignments);
          return 23;
        }
        if (last && capture_active) {
          int appended = append_command_substitution(cur, previous_len);
          if (appended <= 0) {
            if (close_err) fclose(err);
            restore_assignments(&assignments);
            return appended < 0 ? 2 : 23;
          }
          previous = NULL; previous_len = 0;
        } else previous = cur;
      } else { if (close_out) fclose(out); previous = NULL; previous_len = 0; }
      if (close_err) fclose(err);
    } else {
      int pseudo = host_command(c->argv[0]);
      if (!pseudo && !find_command(c->argv[0], resolved)) {
        fprintf(stderr, "slop: command not found: %s\n", c->argv[0]); restore_assignments(&assignments); return 127;
      }
      int script = !pseudo && !wasm_program(resolved);
      const char *spawn_path = pseudo ? c->argv[0] : script ? "/bin/slop" : resolved;
      size_t off = 0; int spawn_argc = 0;
      if (!append_spawn_arg(blob, sizeof blob, &off, spawn_path)) { restore_assignments(&assignments); return 2; }
      spawn_argc++;
      if (script && !append_spawn_arg(blob, sizeof blob, &off, resolved)) { restore_assignments(&assignments); return 2; }
      if (script) spawn_argc++;
      for (int a = 1; a < c->argc; a++)
        if (!append_spawn_arg(blob, sizeof blob, &off, c->argv[a])) { fprintf(stderr, "slop: argument list too long\n"); restore_assignments(&assignments); return 2; }
        else spawn_argc++;
      blob[off] = 0;
      int captured = 0;
      slop_io io; memset(&io, 0, sizeof io);
      io.stdin_data = input; io.stdin_len = input_len;
      int env_len = serialize_environment(); if (env_len < 0) { restore_assignments(&assignments); return 2; }
      io.env_data = spawn_env; io.env_len = env_len;
      if (out_file) { io.out_file = out_file; io.out_append = out_append; }
      else if ((!last || capture_active) && !c->out_to_err) { io.capture = cur; io.capture_cap = PIPE_CAP; io.capture_len = &captured; }
      io.err_file = efile; io.err_append = err_append;
      io.err_to_out = err_to_out;
      io.err_to_inherited_out = err_to_inherited_out;
      io.out_to_inherited_err = out_to_inherited_err;
      io.argc = spawn_argc;
      code = piodide_spawn(spawn_path, blob, cwd, &io);
      if (captured > PIPE_CAP) {
        fprintf(stderr, "slop: command output exceeds %d bytes; write it to a file instead\n", PIPE_CAP);
        restore_assignments(&assignments);
        return 23;
      }
      if (out_file) { previous = NULL; previous_len = 0; }
      else if (!last) { previous = cur; previous_len = captured; }
      else if (capture_active) {
        int appended = append_command_substitution(cur, captured);
        if (appended <= 0) {
          restore_assignments(&assignments);
          return appended < 0 ? 2 : 23;
        }
        previous = NULL; previous_len = 0;
      } else { previous = NULL; previous_len = 0; }
    }
    restore_assignments(&assignments);
    if (code) pipeline_failure = code;
    char *swap = cur; cur = next; next = swap;
  }
  return option_pipefail && pipeline_failure ? pipeline_failure : code;
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
    substitution_status = 0;
    expansion_fatal = 0;
    Command cmds[MAX_CMDS]; int nc = parse_pipeline(items[i].text, cmds, 1);
    if (nc == -2) {
      for (int j = 0; j < MAX_CMDS; j++) free_command(&cmds[j]);
      last_status = 0;
      continue;
    }
    if (nc <= 0) {
      fprintf(stderr, "slop: %s\n", parse_error[0] ? parse_error : "invalid command");
      for (int j = 0; j < MAX_CMDS; j++) free_command(&cmds[j]);
      last_status = 2;
      if (expansion_fatal && !suppress_errexit) {
        exit_requested = 1;
        exit_status = last_status;
      }
      break;
    }
    if (option_xtrace) fprintf(stderr, "+ %s\n", items[i].text);
    last_status = run_pipeline(cmds, nc);
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
  int saved_flow = flow_signal, saved_loop_depth = loop_depth;
  int saved_source_depth = source_depth;
  loop_depth = 0; source_depth = 0;
  capture_active = 1; capture_length = 0; suppress_errexit++;
  char *copy = xstrdup(text); execute_command_list(copy); free(copy);
  int command_status = last_status;
  suppress_errexit--; capture_active = 0;
  while (capture_length > 0 && (capture_buffer[capture_length - 1] == '\n' || capture_buffer[capture_length - 1] == '\r')) capture_length--;
  char *result = xmalloc((size_t)capture_length + 1);
  memcpy(result, capture_buffer, (size_t)capture_length); result[capture_length] = 0;
  last_status = saved_status; exit_requested = saved_exit; exit_status = saved_exit_status;
  flow_signal = saved_flow; loop_depth = saved_loop_depth; source_depth = saved_source_depth;
  substitution_status = command_status;
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
    if (starts_word(s, "if")) depth++;
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
  if (a >= b && !strcmp(s + a - b, keyword) &&
      (a == b || isspace((unsigned char)s[a - b - 1]) || s[a - b - 1] == ';')) {
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
        loop_depth++;
        execute_range(lines, body, finish);
        loop_depth--;
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
      int loops = 0, loop_status = 0, loop_failed = 0;
      while (!exit_requested && run_condition(cond) == 0) {
        if (++loops > LOOP_LIMIT) {
          fprintf(stderr, "slop: loop limit (%d) exceeded\n", LOOP_LIMIT);
          last_status = loop_status = 2; loop_failed = 1; break;
        }
        flow_signal = 0; loop_depth++; execute_range(lines, body, finish); loop_depth--;
        loop_status = last_status;
        if (flow_signal == 1) { flow_signal = 0; break; }
        if (flow_signal == 2) flow_signal = 0;
      }
      if (!exit_requested && !loop_failed) last_status = loop_status;
      i = finish; continue;
    }
    if (starts_word(s, "case")) {
      int finish = find_esac(lines, i, end);
      if (finish < 0) { fprintf(stderr, "slop: missing esac\n"); return last_status = 2; }
      char *spec = trim(s + 4); size_t spec_len = strlen(spec);
      if (spec_len < 2 || strcmp(spec + spec_len - 2, "in") ||
          (spec_len > 2 && !isspace((unsigned char)spec[spec_len - 3]) && spec[spec_len - 3] != ';')) {
        fprintf(stderr, "slop: case requires 'in'\n"); return last_status = 2;
      }
      spec = strip_suffix_keyword(spec, "in");
      char *word_cursor = spec; Token word_token = next_token(&word_cursor, 1);
      while (isspace((unsigned char)*word_cursor)) word_cursor++;
      if (!require_scalar_token(&word_token, "case word") || *word_cursor) {
        free(word_token.text); fprintf(stderr, "slop: case requires one word\n");
        return last_status = 2;
      }
      const char *word = word_token.text;
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
          char *pat_cursor = pat; Token pat_token = next_token(&pat_cursor, 1);
          while (isspace((unsigned char)*pat_cursor)) pat_cursor++;
          if (!require_scalar_token(&pat_token, "case pattern")) {
            free(pat_token.text); free(word_token.text);
            fprintf(stderr, "slop: case pattern requires one word\n");
            return last_status = 2;
          }
          if (!*pat_cursor && pattern_match(pat_token.text, word)) matched = 1;
          free(pat_token.text);
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
      free(word_token.text);
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

static int control_keyword_at(const char *text, size_t offset, const char *word) {
  size_t length = strlen(word), before = offset;
  if (strncmp(text + offset, word, length) ||
      (text[offset + length] && !isspace((unsigned char)text[offset + length]) &&
       text[offset + length] != ';')) return 0;
  while (before && (text[before - 1] == ' ' || text[before - 1] == '\t' || text[before - 1] == '\r')) before--;
  return !before || text[before - 1] == '\n' || text[before - 1] == ';';
}

static int line_starts_inline_block(const char *line) {
  while (*line == ' ' || *line == '\t' || *line == '\r') line++;
  const char *words[] = {"if", "elif", "else", "for", "while", "then", "do", "fi", "done"};
  for (size_t i = 0; i < sizeof words / sizeof words[0]; i++) {
    size_t length = strlen(words[i]);
    if (!strncmp(line, words[i], length) &&
        (!line[length] || isspace((unsigned char)line[length]) || line[length] == ';')) return 1;
  }
  const char *equals = strchr(line, '=');
  if (!equals || !valid_name_n(line, (size_t)(equals - line))) return 0;
  int quote = 0, parens = 0;
  for (const char *cursor = equals + 1; *cursor; cursor++) {
    if (quote == '\'') { if (*cursor == '\'') quote = 0; continue; }
    if (quote == '"') {
      if (*cursor == '\\' && cursor[1]) cursor++;
      else if (*cursor == '"') quote = 0;
      continue;
    }
    if (*cursor == '\\' && cursor[1]) { cursor++; continue; }
    if (*cursor == '\'' || *cursor == '"') { quote = *cursor; continue; }
    if (*cursor == '(') { parens++; continue; }
    if (*cursor == ')' && parens) { parens--; continue; }
    if (*cursor != ';' || parens) continue;
    cursor++;
    while (*cursor == ' ' || *cursor == '\t' || *cursor == '\r') cursor++;
    return starts_word(cursor, "if") || starts_word(cursor, "for") || starts_word(cursor, "while");
  }
  return 0;
}

/* The block executor is line-oriented, but common shell snippets place block
 * keywords and bodies on one physical line. Turn unquoted command separators
 * into virtual newlines while retaining `; then`/`; do` on the condition line.
 * Inline function bodies and command substitutions are normalized when they
 * execute recursively, so their separators remain intact at definition/use. */
static void normalize_script_separators(char *text) {
  int quote = 0, comment = 0, parens = 0, braces = 0;
  int block_line = line_starts_inline_block(text);
  for (size_t i = 0; text[i]; i++) {
    unsigned char c = (unsigned char)text[i];
    if (comment) {
      if (c == '\n') { comment = 0; block_line = line_starts_inline_block(text + i + 1); }
      else continue;
    }
    if (quote == '\'') { if (c == '\'') quote = 0; continue; }
    if (quote == '"') {
      if (c == '\\' && text[i + 1]) i++;
      else if (c == '"') quote = 0;
      continue;
    }
    if (c == '\\' && text[i + 1]) { i++; continue; }
    if (c == '\'' || c == '"') { quote = c; continue; }
    if (c == '#' && (!i || isspace((unsigned char)text[i - 1]) || text[i - 1] == ';')) {
      comment = 1; continue;
    }
    if (c == '\n') { block_line = line_starts_inline_block(text + i + 1); continue; }
    if (c == '(') { parens++; continue; }
    if (c == ')' && parens) { parens--; continue; }
    if (c == '{') { braces++; continue; }
    if (c == '}' && braces) { braces--; continue; }
    if (parens || braces) continue;
    if (!block_line) continue;
    if (c == ';' && text[i + 1] != ';' && (!i || text[i - 1] != ';')) {
      size_t next = i + 1;
      while (text[next] == ' ' || text[next] == '\t' || text[next] == '\r') next++;
      if (!control_keyword_at(text, next, "then") && !control_keyword_at(text, next, "do")) {
        text[i] = '\n';
      }
      continue;
    }
    const char *keyword = control_keyword_at(text, i, "then") ? "then" :
                          control_keyword_at(text, i, "else") ? "else" :
                          control_keyword_at(text, i, "do") ? "do" : NULL;
    if (keyword) {
      size_t after = i + strlen(keyword);
      if (text[after] == ' ' || text[after] == '\t' || text[after] == '\r') text[after] = ';';
    }
  }
}

static int execute_script(char *text) {
  char *r = text, *w = text;
  while (*r) {
    if (r[0] == '\\' && r[1] == '\n') { r += 2; continue; }
    *w++ = *r++;
  }
  *w = 0;
  normalize_script_separators(text);
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
  char *copy = xstrdup(line); normalize_script_separators(copy); int d = 0;
  for (char *part = copy; part && *part;) {
    char *next = strchr(part, '\n'); if (next) *next++ = 0;
    char *s = trim(part);
    if (starts_word(s, "if") || starts_word(s, "for") || starts_word(s, "while") || starts_word(s, "case")) d++;
    if (!strcmp(s, "fi") || !strcmp(s, "done") || !strcmp(s, "esac")) d--;
    if (strstr(s, "()") && !strchr(s, '}')) d++;
    else if (!strcmp(s, "}")) d--;
    part = next;
  }
  free(copy); return d;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0); setvbuf(stderr, NULL, _IONBF, 0);
  pipe_a = xmalloc(PIPE_CAP); pipe_b = xmalloc(PIPE_CAP);
  redirect_input = xmalloc(LARGE_REDIRECT_CAP);
  capture_buffer = xmalloc(PIPE_CAP); spawn_env = xmalloc(ENV_CAP);
  const char *pwd = getenv("PWD");
  if (pwd && *pwd == '/' && is_dir(pwd)) snprintf(cwd, sizeof cwd, "%s", pwd);
  else snprintf(cwd, sizeof cwd, "/home/web");
  normalize(cwd); setenv("PWD", cwd, 1);
  if (!getenv("PATH")) setenv("PATH", "/bin", 1);

  if (argc > 1 && !strcmp(argv[1], "--version")) { puts("slop 0.4 (piodide build shell)"); return 0; }
  if (argc > 1 && (!strcmp(argv[1], "-h") || !strcmp(argv[1], "--help"))) { print_help(stdout); return 0; }
  if (argc > 2 && !strcmp(argv[1], "-c")) {
    shell_name = argc > 3 ? argv[3] : argv[0];
    shell_argc = argc > 4 ? argc - 4 : 0; shell_argv = argc > 4 ? argv + 4 : NULL;
    char *script = xstrdup(argv[2]); int rc = execute_script(script); free(script);
    return exit_requested ? exit_status : rc;
  }
  if (argc > 1 && strcmp(argv[1], "-s")) {
    shell_name = argv[1]; shell_argc = argc - 2; shell_argv = argv + 2;
    int z; char *script = read_file(argv[1], &z, SCRIPT_CAP, stderr); (void)z;
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

  printf("\033[1mslop\033[0m — build shell · type 'help'\n");
  char line[LINE_CAP]; Buf block; binit(&block); int depth = 0;
  while (!exit_requested) {
    printf(depth ? "\033[2m> \033[0m" : "\033[35mslop\033[0m \033[36m%s\033[0m ❯ ", cwd);
    if (!fgets(line, sizeof line, stdin)) { putchar('\n'); break; }
    bputs(&block, line); depth += block_delta(line);
    if (depth > 0) continue;
    if (depth < 0) { fprintf(stderr, "slop: unexpected block terminator\n"); depth = 0; block.len = 0; block.s[0] = 0; continue; }
    execute_script(block.s); block.len = 0; block.s[0] = 0;
    if (!exit_requested && last_status) printf("\033[2m↳ exit %d\033[0m\n", last_status);
  }
  free(block.s); return exit_requested ? exit_status : last_status;
}
