/* env — print the environment or launch one child with a sanitized snapshot. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define REMOVE_LIMIT 60
#define COMMAND_ARG_LIMIT 64
#define INVOCATION_WORD_LIMIT 126
#define WORD_BYTES 4096
#define WORD_TOTAL_BYTES 65536
#define NAME_BYTES 255
#define ENV_ENTRY_LIMIT 1024
#define ENV_ENTRY_BYTES 65535
#define ENV_TOTAL_BYTES (1024 * 1024)
#define STDIN_BYTES (1024 * 1024)
#define PATH_BYTES 4096
#define ARG_BLOB_BYTES (WORD_TOTAL_BYTES + PATH_BYTES * 2 + 8)

/* Spawn ABI v8: v7's counted argv plus an exact-environment launch boundary. */
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
extern char **environ;

static void usage(FILE *stream) {
  fputs("usage: env\n"
        "       env [-i] [-u NAME]... [--] COMMAND [ARG...]  # exact child environment; "
        "60 removals, 64 child args, 4096 bytes/word, 65536 argument bytes\n", stream);
}

static int ascii_name_n(const char *name, size_t length) {
  if (!length || length > NAME_BYTES ||
      !((name[0] >= 'A' && name[0] <= 'Z') ||
        (name[0] >= 'a' && name[0] <= 'z') || name[0] == '_')) return 0;
  for (size_t index = 1; index < length; index++) {
    unsigned char byte = (unsigned char)name[index];
    if (!((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
          (byte >= '0' && byte <= '9') || byte == '_')) return 0;
  }
  return 1;
}

static int ascii_name(const char *name) { return ascii_name_n(name, strlen(name)); }

static int assignment_operand(const char *word) {
  const char *equals = strchr(word, '=');
  return equals && ascii_name_n(word, (size_t)(equals - word));
}

static int removed_name(const char *entry, char **removed, int removed_count) {
  const char *equals = strchr(entry, '=');
  if (!equals) return 0;
  size_t name_length = (size_t)(equals - entry);
  for (int index = 0; index < removed_count; index++) {
    if (strlen(removed[index]) == name_length &&
        !memcmp(entry, removed[index], name_length)) return 1;
  }
  return 0;
}

static const char *environment_value(char *environment, const char *name) {
  size_t name_length = strlen(name); const char *result = NULL;
  for (char *entry = environment; *entry; entry += strlen(entry) + 1) {
    if (!strncmp(entry, name, name_length) && entry[name_length] == '=')
      result = entry + name_length + 1;
  }
  return result;
}

static const char *current_directory(void) {
  const char *cwd = getenv("PIODIDE_CWD");
  if (!cwd || cwd[0] != '/') cwd = getenv("PWD");
  return cwd && cwd[0] == '/' && strlen(cwd) <= PATH_BYTES ? cwd : "/home/web";
}

static int candidate_path(char *output, const char *cwd,
                          const char *directory, size_t directory_length,
                          const char *command) {
  int length;
  if (!directory_length)
    length = snprintf(output, PATH_BYTES + 1, "%s/%s", cwd, command);
  else if (directory[0] == '/')
    length = snprintf(output, PATH_BYTES + 1, "%.*s/%s",
                      (int)directory_length, directory, command);
  else
    length = snprintf(output, PATH_BYTES + 1, "%s/%.*s/%s", cwd,
                      (int)directory_length, directory, command);
  return length >= 0 && length <= PATH_BYTES;
}

/* Return 1 for a regular candidate, 0 for missing, and -1 for an existing
 * entry that cannot be launched. */
static int inspect_candidate(const char *path) {
  struct stat status;
  if (!stat(path, &status)) return S_ISREG(status.st_mode) ? 1 : -1;
  return errno == ENOENT || errno == ENOTDIR ? 0 : -1;
}

static int resolve_command(const char *command, const char *path, const char *cwd,
                           char *resolved) {
  int unavailable = 0;
  if (strchr(command, '/')) {
    int length = command[0] == '/'
      ? snprintf(resolved, PATH_BYTES + 1, "%s", command)
      : snprintf(resolved, PATH_BYTES + 1, "%s/%s", cwd, command);
    if (length < 0 || length > PATH_BYTES) return 126;
    int state = inspect_candidate(resolved);
    return state > 0 ? 0 : state < 0 ? 126 : 127;
  }
  if (!path) return 127;
  const char *start = path;
  for (;;) {
    const char *end = strchr(start, ':');
    size_t length = end ? (size_t)(end - start) : strlen(start);
    if (candidate_path(resolved, cwd, start, length, command)) {
      int state = inspect_candidate(resolved);
      if (state > 0) return 0;
      if (state < 0) unavailable = 1;
    }
    if (!end) break;
    start = end + 1;
  }
  return unavailable ? 126 : 127;
}

static int host_marker(const char *path) {
  return !strcmp(path, "/bin/cc") || !strcmp(path, "/bin/compile") ||
         !strcmp(path, "/bin/ld") || !strcmp(path, "/bin/link") ||
         !strcmp(path, "/bin/python") || !strcmp(path, "/bin/python3") ||
         !strcmp(path, "/bin/curl");
}

static int wasm_program(const char *path) {
  FILE *file = fopen(path, "rb");
  if (!file) return 0;
  unsigned char magic[4]; size_t count = fread(magic, 1, sizeof magic, file);
  fclose(file);
  return count == 4 && magic[0] == 0 && magic[1] == 'a' &&
         magic[2] == 's' && magic[3] == 'm';
}

static int append_argument(char *blob, size_t *used, const char *argument) {
  size_t length = strlen(argument) + 1;
  if (*used + length > ARG_BLOB_BYTES) return 0;
  memcpy(blob + *used, argument, length); *used += length; return 1;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--help")) { usage(stdout); return 0; }
  if (argc == 1) {
    for (char **entry = environ; entry && *entry; entry++)
      if (printf("%s\n", *entry) < 0) return 1;
    return fflush(stdout) == EOF ? 1 : 0;
  }
  if (argc - 1 > INVOCATION_WORD_LIMIT) {
    fputs("env: too many words (max 126 after env)\n", stderr); return 2;
  }
  size_t word_total = 0;
  for (int index = 1; index < argc; index++) {
    size_t length = strlen(argv[index]);
    if (length > WORD_BYTES) {
      fputs("env: argument exceeds 4096 bytes\n", stderr); return 2;
    }
    if (word_total > WORD_TOTAL_BYTES - length) {
      fputs("env: arguments exceed 65536 bytes\n", stderr); return 2;
    }
    word_total += length;
  }

  int ignore = 0, remove_count = 0, delimited = 0, index = 1;
  char *removed[REMOVE_LIMIT];
  while (index < argc && argv[index][0] == '-' && argv[index][1]) {
    if (!strcmp(argv[index], "--")) { delimited = 1; index++; break; }
    if (!strcmp(argv[index], "-i")) {
      if (ignore) { fputs("env: -i may be specified only once\n", stderr); return 2; }
      ignore = 1; index++; continue;
    }
    if (!strcmp(argv[index], "-u")) {
      if (remove_count == REMOVE_LIMIT) {
        fputs("env: too many -u removals (max 60)\n", stderr); return 2;
      }
      if (index + 1 >= argc || !ascii_name(argv[index + 1])) {
        fputs("env: -u NAME requires an ASCII variable name of at most 255 bytes\n", stderr);
        return 2;
      }
      removed[remove_count++] = argv[index + 1]; index += 2; continue;
    }
    fputs("env: unsupported option\n", stderr); return 2;
  }
  if (index >= argc) { fputs("env: launcher mode requires COMMAND\n", stderr); return 2; }
  if (!delimited && argv[index][0] == '-' && argv[index][1]) {
    fputs("env: dash-leading COMMAND requires --\n", stderr); return 2;
  }
  if (assignment_operand(argv[index])) {
    fputs("env: assignment operands are unsupported; use shell prefix assignments\n", stderr);
    return 2;
  }
  int command_argc = argc - index;
  if (command_argc > COMMAND_ARG_LIMIT) {
    fputs("env: child argument vector exceeds 64 entries\n", stderr); return 2;
  }

  char *environment = malloc(ENV_TOTAL_BYTES);
  if (!environment) { fputs("env: memory unavailable\n", stderr); return 1; }
  size_t environment_used = 0; int environment_count = 0;
  if (!ignore) {
    for (char **entry = environ; entry && *entry; entry++) {
      size_t length = strlen(*entry);
      if (++environment_count > ENV_ENTRY_LIMIT || length > ENV_ENTRY_BYTES ||
          environment_used > ENV_TOTAL_BYTES - length - 2) {
        fputs("env: inherited environment exceeds bounded launcher limits\n", stderr);
        free(environment); return 2;
      }
      if (removed_name(*entry, removed, remove_count)) continue;
      memcpy(environment + environment_used, *entry, length + 1);
      environment_used += length + 1;
    }
  }
  environment[environment_used++] = 0;

  const char *cwd = current_directory();
  char resolved[PATH_BYTES + 1];
  int lookup = resolve_command(argv[index], environment_value(environment, "PATH"), cwd, resolved);
  if (lookup) {
    fputs(lookup == 127 ? "env: command not found\n" : "env: command cannot launch\n", stderr);
    free(environment); return lookup;
  }

  int script = !host_marker(resolved) && !wasm_program(resolved);
  const char *spawn_path = script ? "/bin/slop" : resolved;
  if (script && inspect_candidate(spawn_path) != 1) {
    fputs("env: script interpreter cannot launch\n", stderr);
    free(environment); return 126;
  }
  char *arguments = malloc(ARG_BLOB_BYTES);
  if (!arguments) { fputs("env: memory unavailable\n", stderr); free(environment); return 1; }
  size_t argument_used = 0; int spawned_argc = 0;
  if (!append_argument(arguments, &argument_used, spawn_path)) goto argument_error;
  spawned_argc++;
  if (script) {
    if (!append_argument(arguments, &argument_used, resolved)) goto argument_error;
    spawned_argc++;
  }
  for (int argument = index + 1; argument < argc; argument++) {
    if (!append_argument(arguments, &argument_used, argv[argument])) goto argument_error;
    spawned_argc++;
  }

  char *input = NULL; size_t input_used = 0;
  if (getenv("PIODIDE_STDIN")) {
    input = malloc(STDIN_BYTES + 1);
    if (!input) { fputs("env: memory unavailable\n", stderr); free(arguments); free(environment); return 1; }
    input_used = fread(input, 1, STDIN_BYTES + 1, stdin);
    if (input_used > STDIN_BYTES) {
      fputs("env: stdin exceeds 1048576 bytes\n", stderr);
      free(input); free(arguments); free(environment); return 2;
    }
    if (ferror(stdin)) {
      fputs("env: cannot read stdin\n", stderr);
      free(input); free(arguments); free(environment); return 1;
    }
  }

  slop_io io; memset(&io, 0, sizeof io);
  io.stdin_data = input; io.stdin_len = (int)input_used;
  io.env_data = environment; io.env_len = (int)environment_used;
  io.argc = spawned_argc;
  int result = piodide_spawn(spawn_path, arguments, cwd, &io);
  free(input); free(arguments); free(environment); return result;

argument_error:
  fputs("env: child argument serialization exceeds bounded limits\n", stderr);
  free(arguments); free(environment); return 2;
}
