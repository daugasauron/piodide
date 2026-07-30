/*
 * slop — the piodide shell.
 *
 * A minimal bash-ish REPL running as a WASI program against the live
 * Pyodide filesystem. External commands are other programs found on $PATH
 * (/bin only); they are started through the host's "piodide" spawn import,
 * which runs them as siblings and reports the exit code.
 *
 *   builtins:  cd, pwd, exit, help
 *   pipes:     cat file.txt | grep something | grep -v noise
 *   lists:     cmd && next, cmd || fallback, cmd ; next
 *   redirects: cmd > file (truncate), cmd >> file (append)
 *   expansion: $VAR, ${VAR}, $?, \$ (single quotes inhibit)
 *   pseudo:    cc/compile, ld/link (routed to the in-browser clang toolchain)
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Spawn ABI v2: stdio routing for the child. Fields are read by the host. */
typedef struct {
  const char *stdin_data; /* NULL = shared session input (the tty) */
  int stdin_len;
  char *capture;          /* NULL = stdout goes to the terminal or out_file */
  int capture_cap;
  int *capture_len;       /* out: total stdout bytes (pre-truncation) */
  const char *out_file;   /* NULL or absolute path for stdout */
  int out_append;
} slop_io;

__attribute__((import_module("piodide"), import_name("spawn")))
extern int piodide_spawn(const char *path, const char *argv_blob, const char *cwd,
                         slop_io *io);

#define SLOP_MAX_ARGS 64
#define SLOP_MAX_CMDS 16
#define SLOP_MAX_LISTS 32
#define SLOP_LINE 4096
#define SLOP_PATH 4096
#define PIPE_CAP (1024 * 1024)

static char cwd[SLOP_PATH] = "/home/web";
static int last_exit = 0;
static char pipe_a[PIPE_CAP];
static char pipe_b[PIPE_CAP];

static void print_help(FILE *out) {
  fprintf(out, "slop — the piodide shell\n");
  fprintf(out, "  builtins:  cd [dir]   pwd   exit   help\n");
  fprintf(out, "  commands:  ls cat grep echo env fd-find (exact name, first hit on $PATH=/bin)\n");
  fprintf(out, "  pipes:     cat f.txt | grep x | grep -v y      redirects: cmd > f  cmd >> f\n");
  fprintf(out, "  lists:     cmd && next   cmd || fallback   cmd ; next\n");
  fprintf(out, "  expansion: $VAR ${VAR} $? \\$ ('...' inhibits)\n");
  fprintf(out, "  toolchain: cc -c [flags] file.c -o file.o   ld [flags] file.o -o app.wasm\n");
  fprintf(out, "             aliases: compile = cc, link = ld; run `cc --help` / `ld --help`\n");
  fprintf(out, "  keys:      Ctrl+C kill child / cancel line · Ctrl+D exit shell / EOF\n");
  fprintf(out, "files are the live Pyodide filesystem: Python, the agent and Neovim\n");
  fprintf(out, "see everything you create immediately. Spawned programs inherit this cwd.\n");
}

/* ------------------------------ path utils ------------------------------ */

static void normalize(char *path) {
  char *copy = strdup(path);
  char *parts[512];
  int n = 0;
  for (char *tok = strtok(copy, "/"); tok && n < 512; tok = strtok(NULL, "/")) {
    if (strcmp(tok, ".") == 0) continue;
    if (strcmp(tok, "..") == 0) {
      if (n > 0) n--;
      continue;
    }
    parts[n++] = tok;
  }
  char *out = path;
  *out++ = '/';
  for (int i = 0; i < n; i++) {
    size_t len = strlen(parts[i]);
    memcpy(out, parts[i], len);
    out += len;
    if (i < n - 1) *out++ = '/';
  }
  *out = '\0';
  free(copy);
}

static void resolve(const char *in, char *out) {
  if (in[0] == '/') snprintf(out, SLOP_PATH, "%s", in);
  else if (strcmp(cwd, "/") == 0) snprintf(out, SLOP_PATH, "/%s", in);
  else snprintf(out, SLOP_PATH, "%s/%s", cwd, in);
  normalize(out);
}

static int is_dir(const char *path) {
  struct stat st;
  return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

static int is_reg(const char *path) {
  struct stat st;
  return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

/* ------------------------------ tokenizer ------------------------------- */

/*
 * Produces malloc'd tokens. Operators |, >, >> become their own tokens even
 * when glued to words. $VAR, ${VAR} and $? expand outside single quotes;
 * \$ is a literal $. Unterminated quotes are an error (tok_err).
 */
static char tok_err[128];

static void buf_putc(char **buf, size_t *len, size_t *cap, char c) {
  if (*len + 1 >= *cap) {
    *cap *= 2;
    *buf = realloc(*buf, *cap);
  }
  (*buf)[(*len)++] = c;
}

static void buf_puts(char **buf, size_t *len, size_t *cap, const char *s) {
  while (*s) buf_putc(buf, len, cap, *s++);
}

static void expand_var(char **buf, size_t *len, size_t *cap, char **pp, int expand) {
  char name[128];
  size_t n = 0;
  char *p = *pp;
  if (*p == '?') {
    p++;
    if (expand) {
      char tmp[16];
      snprintf(tmp, sizeof tmp, "%d", last_exit);
      buf_puts(buf, len, cap, tmp);
    } else {
      buf_putc(buf, len, cap, 'x');
    }
  } else if (*p == '{') {
    p++;
    while (*p && *p != '}' && n + 1 < sizeof name) name[n++] = *p++;
    if (*p != '}') {
      snprintf(tok_err, sizeof tok_err, "unterminated ${...}");
    } else {
      p++;
    }
  } else {
    if (!(*p == '_' || (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z'))) {
      buf_putc(buf, len, cap, '$'); /* lone $ */
      *pp = p;
      return;
    }
    while (*p == '_' || (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
           (*p >= '0' && *p <= '9')) {
      if (n + 1 < sizeof name) name[n++] = *p;
      p++;
    }
  }
  name[n] = '\0';
  if (expand) {
    const char *value = getenv(name);
    if (value) buf_puts(buf, len, cap, value);
  } else {
    buf_putc(buf, len, cap, 'x');
  }
  *pp = p;
}

static char *next_token(char **pp, int expand) {
  char *p = *pp;
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
  if (!*p) {
    *pp = p;
    return NULL;
  }
  if (*p == '|' || *p == '>') {
    char op[3] = {*p, 0, 0};
    if (*p == '>' && p[1] == '>') {
      op[1] = '>';
      p++;
    }
    p++;
    *pp = p;
    return strdup(op);
  }

  size_t cap = 64, len = 0;
  char *buf = malloc(cap);
  int done = 0;
  while (*p && !done) {
    char c = *p;
    if (c == '\'') {
      p++;
      while (*p && *p != '\'') buf_putc(&buf, &len, &cap, *p++);
      if (*p) p++;
      else snprintf(tok_err, sizeof tok_err, "unterminated ' quote");
    } else if (c == '"') {
      p++;
      while (*p && *p != '"') {
        if (*p == '$') {
          if (p[1] == '$') {
            buf_putc(&buf, &len, &cap, '$');
            p += 2;
          } else {
            p++;
            expand_var(&buf, &len, &cap, &p, expand);
          }
        } else if (*p == '\\' && p[1] == '$') {
          buf_putc(&buf, &len, &cap, '$');
          p += 2;
        } else {
          buf_putc(&buf, &len, &cap, *p++);
        }
      }
      if (*p) p++;
      else snprintf(tok_err, sizeof tok_err, "unterminated \" quote");
    } else if (c == '$') {
      p++;
      expand_var(&buf, &len, &cap, &p, expand);
    } else if (c == '\\' && p[1] == '$') {
      buf_putc(&buf, &len, &cap, '$');
      p += 2;
    } else if (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '|' || c == '>') {
      done = 1;
    } else {
      buf_putc(&buf, &len, &cap, *p++);
    }
  }
  buf_putc(&buf, &len, &cap, '\0');
  *pp = p;
  return buf;
}

/* ------------------------------ pipeline -------------------------------- */

typedef struct {
  char *argv[SLOP_MAX_ARGS];
  int argc;
  char *out_file; /* malloc'd, NULL otherwise */
  int append;
} Command;

static int parse_pipeline(char *line, Command *cmds, int expand) {
  char *p = line;
  int ncmd = 0;
  memset(cmds, 0, SLOP_MAX_CMDS * sizeof *cmds);
  Command *cur = &cmds[ncmd];
  char *tok;
  tok_err[0] = '\0';
  while ((tok = next_token(&p, expand)) != NULL) {
    if (strcmp(tok, "|") == 0) {
      free(tok);
      if (cur->argc == 0) {
        snprintf(tok_err, sizeof tok_err, "empty command before |");
        return -1;
      }
      if (ncmd + 1 >= SLOP_MAX_CMDS) {
        snprintf(tok_err, sizeof tok_err, "too many commands in pipeline");
        return -1;
      }
      ncmd++;
      cur = &cmds[ncmd];
      continue;
    }
    if (strcmp(tok, ">") == 0 || strcmp(tok, ">>") == 0) {
      int append = tok[1] == '>';
      free(tok);
      char *target = next_token(&p, expand);
      if (!target) {
        snprintf(tok_err, sizeof tok_err, "redirect needs a file");
        return -1;
      }
      if (strcmp(target, "|") == 0 || strcmp(target, ">") == 0 ||
          strcmp(target, ">>") == 0) {
        snprintf(tok_err, sizeof tok_err, "redirect needs a file");
        free(target);
        return -1;
      }
      if (cur->argc == 0) {
        snprintf(tok_err, sizeof tok_err, "redirect needs a command");
        free(target);
        return -1;
      }
      free(cur->out_file);
      cur->out_file = target;
      cur->append = append;
      continue;
    }
    if (cur->argc >= SLOP_MAX_ARGS - 1) {
      snprintf(tok_err, sizeof tok_err, "too many arguments");
      free(tok);
      return -1;
    }
    cur->argv[cur->argc++] = tok;
  }
  if (tok_err[0] != '\0') return -1;
  if (cur->argc == 0 && ncmd > 0) {
    snprintf(tok_err, sizeof tok_err, "empty command after |");
    return -1;
  }
  return cur->argc > 0 ? ncmd + 1 : 0;
}

static void free_pipeline(Command *cmds, int ncmd) {
  for (int i = 0; i < ncmd; i++) {
    for (int a = 0; a < cmds[i].argc; a++) free(cmds[i].argv[a]);
    free(cmds[i].out_file);
  }
}

/* ---------------------------- command lists ----------------------------- */

typedef enum {
  LIST_ALWAYS,
  LIST_AND,
  LIST_OR,
} ListCondition;

typedef struct {
  char *text;
  ListCondition condition;
} ListItem;

static void free_command_list(ListItem *items, int count) {
  for (int i = 0; i < count; i++) free(items[i].text);
}

static char *copy_trimmed(const char *start, const char *end) {
  while (start < end && (*start == ' ' || *start == '\t' || *start == '\r' || *start == '\n')) {
    start++;
  }
  while (end > start && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' || end[-1] == '\n')) {
    end--;
  }
  size_t length = (size_t)(end - start);
  char *text = malloc(length + 1);
  if (!text) return NULL;
  memcpy(text, start, length);
  text[length] = '\0';
  return text;
}

/*
 * Split a raw line before expansion so each selected pipeline expands with
 * the status of the previously executed pipeline. Operators inside quotes
 * remain ordinary text. The complete list is validated before execution.
 */
static int parse_command_list(char *line, ListItem *items) {
  memset(items, 0, SLOP_MAX_LISTS * sizeof *items);
  const char *start = line;
  const char *last_operator = NULL;
  ListCondition next_condition = LIST_ALWAYS;
  char quote = '\0';
  int count = 0;

  for (char *p = line; *p; p++) {
    if (quote) {
      if (*p == quote) quote = '\0';
      continue;
    }
    if (*p == '\'' || *p == '"') {
      quote = *p;
      continue;
    }

    const char *op = NULL;
    int op_length = 0;
    ListCondition following = LIST_ALWAYS;
    if (*p == '&') {
      if (p[1] != '&') {
        snprintf(tok_err, sizeof tok_err, "unsupported operator &");
        free_command_list(items, count);
        return -1;
      }
      op = "&&";
      op_length = 2;
      following = LIST_AND;
    } else if (*p == '|' && p[1] == '|') {
      op = "||";
      op_length = 2;
      following = LIST_OR;
    } else if (*p == ';') {
      op = ";";
      op_length = 1;
      following = LIST_ALWAYS;
    } else {
      continue;
    }

    char *text = copy_trimmed(start, p);
    if (!text) {
      snprintf(tok_err, sizeof tok_err, "out of memory");
      free_command_list(items, count);
      return -1;
    }
    if (!*text) {
      snprintf(tok_err, sizeof tok_err, "empty command before %s", op);
      free(text);
      free_command_list(items, count);
      return -1;
    }
    if (count >= SLOP_MAX_LISTS) {
      snprintf(tok_err, sizeof tok_err, "too many pipelines in command list");
      free(text);
      free_command_list(items, count);
      return -1;
    }
    items[count].text = text;
    items[count].condition = next_condition;
    count++;
    next_condition = following;
    last_operator = op;
    p += op_length - 1;
    start = p + 1;
  }

  if (quote) {
    snprintf(tok_err, sizeof tok_err, "unterminated %c quote", quote);
    free_command_list(items, count);
    return -1;
  }

  const char *end = line + strlen(line);
  char *text = copy_trimmed(start, end);
  if (!text) {
    snprintf(tok_err, sizeof tok_err, "out of memory");
    free_command_list(items, count);
    return -1;
  }
  if (*text) {
    if (count >= SLOP_MAX_LISTS) {
      snprintf(tok_err, sizeof tok_err, "too many pipelines in command list");
      free(text);
      free_command_list(items, count);
      return -1;
    }
    items[count].text = text;
    items[count].condition = next_condition;
    count++;
  } else {
    free(text);
    if (count == 0) return 0;
    if (!last_operator || strcmp(last_operator, ";") != 0) {
      snprintf(tok_err, sizeof tok_err, "empty command after %s", last_operator);
      free_command_list(items, count);
      return -1;
    }
  }

  /* Validate every pipeline before any command can cause side effects. */
  for (int i = 0; i < count; i++) {
    Command validation[SLOP_MAX_CMDS];
    int ncmd = parse_pipeline(items[i].text, validation, 0);
    if (ncmd <= 0) {
      if (tok_err[0] == '\0') snprintf(tok_err, sizeof tok_err, "empty pipeline");
      free_pipeline(validation, SLOP_MAX_CMDS);
      free_command_list(items, count);
      return -1;
    }
    free_pipeline(validation, ncmd);
  }
  return count;
}

/* ------------------------------ builtins -------------------------------- */

static int find_command(const char *cmd, char *out) {
  if (strchr(cmd, '/') != NULL) {
    resolve(cmd, out);
    return is_reg(out);
  }
  const char *path_env = getenv("PATH");
  if (path_env == NULL || *path_env == '\0') path_env = "/bin";
  char *copy = strdup(path_env);
  int found = 0;
  for (char *dir = strtok(copy, ":"); dir && !found; dir = strtok(NULL, ":")) {
    snprintf(out, SLOP_PATH, "%s/%s", dir, cmd);
    if (is_reg(out)) found = 1;
  }
  free(copy);
  return found;
}

static int is_builtin(const char *name) {
  return strcmp(name, "cd") == 0 || strcmp(name, "pwd") == 0 || strcmp(name, "help") == 0;
}

static int is_toolchain_command(const char *name) {
  return strcmp(name, "cc") == 0 || strcmp(name, "ld") == 0 ||
         strcmp(name, "compile") == 0 || strcmp(name, "link") == 0;
}

static int append_spawn_arg(char *blob, size_t cap, size_t *offset, const char *arg) {
  size_t length = strlen(arg) + 1;
  /* Reserve one final NUL after the last argument. */
  if (*offset >= cap || length >= cap - *offset) return 0;
  memcpy(blob + *offset, arg, length);
  *offset += length;
  return 1;
}

/* Runs a builtin; output goes to `out`. Returns the exit code. */
static int run_builtin(const char *name, char **args, int argc, FILE *out) {
  if (strcmp(name, "pwd") == 0) {
    fprintf(out, "%s\n", cwd);
    return 0;
  }
  if (strcmp(name, "help") == 0) {
    print_help(out);
    return 0;
  }
  /* cd */
  char resolved[SLOP_PATH];
  resolve(argc > 1 ? args[1] : "/home/web", resolved);
  if (!is_dir(resolved)) {
    fprintf(out, "cd: no such directory: %s\n", argc > 1 ? args[1] : resolved);
    return 1;
  }
  if (chdir(resolved) != 0) {
    fprintf(out, "cd: %s: %s\n", args[1], strerror(errno));
    return 1;
  }
  snprintf(cwd, sizeof cwd, "%s", resolved);
  if (setenv("PWD", cwd, 1) != 0) {
    fprintf(stderr, "slop: could not update PWD: %s\n", strerror(errno));
  }
  return 0;
}

/* ------------------------------ execution ------------------------------- */

static int run_pipeline(Command *cmds, int ncmd) {
  static char blob[8192];
  static char resolved[SLOP_PATH];
  static char out_path[SLOP_PATH];
  int capture_len = 0;
  const char *prev_buf = NULL;
  int prev_len = 0;
  char *cur_buf = pipe_a;
  char *nxt_buf = pipe_b;
  int code = 0;

  for (int i = 0; i < ncmd; i++) {
    Command *c = &cmds[i];
    int is_last = i == ncmd - 1;
    int pseudo = is_toolchain_command(c->argv[0]);

    /* Where does this command's stdout go? (redirect beats pipe, like bash.) */
    const char *out_file = NULL;
    if (c->out_file) {
      resolve(c->out_file, out_path);
      out_file = out_path;
    }

    /* Builtins run in-process. */
    if (!pseudo && is_builtin(c->argv[0])) {
      int rc;
      if (!out_file && is_last) {
        rc = run_builtin(c->argv[0], c->argv, c->argc, stdout);
        prev_buf = NULL;
        prev_len = 0;
      } else if (out_file) {
        FILE *out = fopen(out_file, c->append ? "a" : "w");
        if (!out) {
          fprintf(stderr, "slop: %s: %s\n", out_file, strerror(errno));
          code = 1;
          break;
        }
        rc = run_builtin(c->argv[0], c->argv, c->argc, out);
        fclose(out);
        prev_buf = NULL;
        prev_len = 0; /* redirected: the pipe gets nothing */
      } else {
        FILE *mem = fmemopen(cur_buf, PIPE_CAP, "w");
        rc = run_builtin(c->argv[0], c->argv, c->argc, mem);
        capture_len = (int)ftell(mem);
        fclose(mem);
        prev_buf = cur_buf;
        prev_len = capture_len;
      }
      code = rc;
      goto next;
    }

    /* External or pseudo-command. */
    const char *prog = c->argv[0];
    if (!pseudo && !find_command(prog, resolved)) {
      fprintf(stderr, "slop: command not found: %s\n", prog);
      code = 127;
      break;
    }
    size_t off = 0;
    int args_ok = 1;
    if (!append_spawn_arg(blob, sizeof blob, &off, pseudo ? prog : resolved)) {
      fprintf(stderr, "slop: serialized arguments exceed %zu bytes\n", sizeof blob);
      args_ok = 0;
    }
    for (int a = 1; args_ok && a < c->argc; a++) {
      if (!append_spawn_arg(blob, sizeof blob, &off, c->argv[a])) {
        fprintf(stderr, "slop: serialized arguments exceed %zu bytes\n", sizeof blob);
        args_ok = 0;
      }
    }
    if (!args_ok) {
      code = 2;
      break;
    }
    blob[off] = '\0';

    slop_io io;
    memset(&io, 0, sizeof io);
    io.stdin_data = prev_buf;
    io.stdin_len = prev_len;
    if (out_file) {
      io.out_file = out_file;
      io.out_append = c->append;
    } else if (!is_last) {
      io.capture = cur_buf;
      io.capture_cap = PIPE_CAP;
      io.capture_len = &capture_len;
    }
    code = piodide_spawn(pseudo ? prog : resolved, blob, cwd, &io);

    if (out_file) {
      prev_buf = NULL;
      prev_len = 0;
    } else if (!is_last) {
      if (capture_len > PIPE_CAP) {
        fprintf(stderr, "\x1b[2mslop: pipe truncated at %d bytes\x1b[0m\n", PIPE_CAP);
        capture_len = PIPE_CAP;
      }
      prev_buf = cur_buf;
      prev_len = capture_len;
    } else {
      prev_buf = NULL;
      prev_len = 0;
    }

  next:;
    char *swap = cur_buf;
    cur_buf = nxt_buf;
    nxt_buf = swap;
  }

  return code;
}

/* --------------------------------- REPL ---------------------------------- */

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  const char *quiet_env = getenv("SLOP_QUIET");
  int quiet = quiet_env && *quiet_env && strcmp(quiet_env, "0") != 0;

  const char *pwd = getenv("PWD");
  if (pwd && is_dir(pwd)) chdir(pwd);
  else chdir("/home/web");
  if (getcwd(cwd, sizeof cwd) == NULL) snprintf(cwd, sizeof cwd, "/home/web");
  normalize(cwd);
  if (setenv("PWD", cwd, 1) != 0) {
    fprintf(stderr, "slop: could not initialize PWD: %s\n", strerror(errno));
  }

  if (!quiet) printf("\x1b[1mslop\x1b[0m — the piodide shell · type 'help'\n");

  static char line[SLOP_LINE];
  static ListItem items[SLOP_MAX_LISTS];

  int exit_requested = 0;
  while (!exit_requested) {
    if (!quiet) printf("\x1b[35mslop\x1b[0m \x1b[36m%s\x1b[0m ❯ ", cwd);
    if (fgets(line, sizeof line, stdin) == NULL) {
      if (!quiet) printf("\n");
      break;
    }
    int nitems = parse_command_list(line, items);
    if (nitems < 0) {
      last_exit = 2;
      fprintf(stderr, "slop: %s\n", tok_err);
      continue;
    }
    if (nitems == 0) continue;

    for (int i = 0; i < nitems; i++) {
      int should_run = items[i].condition == LIST_ALWAYS ||
                       (items[i].condition == LIST_AND && last_exit == 0) ||
                       (items[i].condition == LIST_OR && last_exit != 0);
      if (!should_run) continue;

      Command cmds[SLOP_MAX_CMDS];
      int ncmd = parse_pipeline(items[i].text, cmds, 1);
      if (ncmd <= 0) {
        last_exit = 2;
        fprintf(stderr, "slop: %s\n", tok_err[0] ? tok_err : "invalid pipeline");
        free_pipeline(cmds, SLOP_MAX_CMDS);
        break;
      }
      if (ncmd == 1 && cmds[0].out_file == NULL && strcmp(cmds[0].argv[0], "exit") == 0) {
        free_pipeline(cmds, ncmd);
        exit_requested = 1;
        break;
      }

      last_exit = run_pipeline(cmds, ncmd);
      free_pipeline(cmds, ncmd);
    }

    free_command_list(items, nitems);
    if (!quiet && !exit_requested && last_exit != 0) {
      printf("\x1b[2m↳ exit %d\x1b[0m\n", last_exit);
    }
  }
  return last_exit;
}
