/*
 * slop — the piodide shell.
 *
 * A minimal bash-ish REPL running as a WASI program against the live
 * Pyodide filesystem. External commands are other .wasm programs found on
 * $PATH (/bin only); they are started through the host's "piodide" spawn
 * import, which runs them as siblings and reports the exit code.
 *
 * Builtins: cd, pwd, exit, help.
 * Host-provided pseudo-commands: compile, link (route to the in-browser
 * clang toolchain).
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

__attribute__((import_module("piodide"), import_name("spawn")))
extern int piodide_spawn(const char *path, const char *argv_blob, const char *cwd);

#define SLOP_MAX_ARGS 64
#define SLOP_LINE 4096
#define SLOP_PATH 4096

static char cwd[SLOP_PATH] = "/home/web";

static void print_help(void) {
  printf("slop — the piodide shell\n");
  printf("  builtins:  cd [dir]   pwd   exit   help\n");
  printf("  commands:  ls cat grep echo env fd-find (any program on $PATH, which\n");
  printf("             is exactly /bin; lookup matches the exact name, first hit)\n");
  printf("  toolchain: compile <file.c> [-o out.o]   link <a.o b.o...> -o <out.wasm>\n");
  printf("  keys:      Ctrl+C kill child / cancel line · Ctrl+D exit shell / EOF\n");
  printf("files are the live Pyodide filesystem: Python, the agent and Neovim\n");
  printf("see everything you create, immediately. Programs that chdir(getenv(\"PWD\"))\n");
  printf("at startup inherit the shell's cwd for relative paths.\n");
}

/* Collapse "//", "/./", "/../" in place. */
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

/* Split on whitespace with single/double quote grouping, in place. */
static int parse(char *line, char **argv) {
  int argc = 0;
  char *p = line;
  while (*p && argc < SLOP_MAX_ARGS - 1) {
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (!*p) break;
    if (*p == '"' || *p == '\'') {
      char quote = *p++;
      argv[argc++] = p;
      while (*p && *p != quote) p++;
      if (*p) *p++ = '\0';
    } else {
      argv[argc++] = p;
      while (*p && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') p++;
      if (*p) *p++ = '\0';
    }
  }
  argv[argc] = NULL;
  return argc;
}

/*
 * Command lookup: search each $PATH directory in order for a file named
 * exactly `cmd` (no implicit extensions) and run the first hit.
 */
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

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);

  const char *pwd = getenv("PWD");
  if (pwd && is_dir(pwd)) chdir(pwd);
  else chdir("/home/web");
  if (getcwd(cwd, sizeof cwd) == NULL) snprintf(cwd, sizeof cwd, "/home/web");
  normalize(cwd);

  printf("\x1b[1mslop\x1b[0m — the piodide shell · type 'help'\n");

  static char line[SLOP_LINE];
  static char resolved[SLOP_PATH];
  static char blob[8192];
  char *args[SLOP_MAX_ARGS];

  for (;;) {
    printf("\x1b[35mslop\x1b[0m \x1b[36m%s\x1b[0m ❯ ", cwd);
    if (fgets(line, sizeof line, stdin) == NULL) {
      printf("\n");
      break;
    }
    int argc = parse(line, args);
    if (argc == 0) continue;

    if (strcmp(args[0], "exit") == 0) break;
    if (strcmp(args[0], "pwd") == 0) {
      printf("%s\n", cwd);
      continue;
    }
    if (strcmp(args[0], "help") == 0) {
      print_help();
      continue;
    }
    if (strcmp(args[0], "cd") == 0) {
      resolve(argc > 1 ? args[1] : "/home/web", resolved);
      if (!is_dir(resolved)) {
        printf("cd: no such directory: %s\n", argc > 1 ? args[1] : resolved);
        continue;
      }
      if (chdir(resolved) != 0) {
        printf("cd: %s: %s\n", args[1], strerror(errno));
        continue;
      }
      snprintf(cwd, sizeof cwd, "%s", resolved);
      continue;
    }

    /* compile/link are provided by the host toolchain (no binary on PATH). */
    int pseudo = strcmp(args[0], "compile") == 0 || strcmp(args[0], "link") == 0;
    if (!pseudo && !find_command(args[0], resolved)) {
      printf("slop: command not found: %s\n", args[0]);
      continue;
    }

    /* Pack argv as NUL-separated strings terminated by an empty string. */
    const char *prog = pseudo ? args[0] : resolved;
    size_t off = 0;
    off += snprintf(blob + off, sizeof blob - off, "%s", prog) + 1;
    for (int i = 1; i < argc; i++) {
      off += snprintf(blob + off, sizeof blob - off, "%s", args[i]) + 1;
    }
    blob[off] = '\0';

    int code = piodide_spawn(prog, blob, cwd);
    if (code != 0) printf("\x1b[2m↳ exit %d\x1b[0m\n", code);
  }
  return 0;
}
