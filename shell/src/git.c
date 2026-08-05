#define _GNU_SOURCE
/*
 * git — compiled Slop entrypoint for the browser's libgit2 WebAssembly engine.
 *
 * Repository data stays in the shared /home/web filesystem.  The host command
 * only supplies libgit2 and browser networking; this executable preserves the
 * normal shell/PATH/redirection behavior of /bin/git.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ARG_BYTES (64 * 1024)
#define ENV_BYTES (64 * 1024)
#define STDIN_BYTES (1024 * 1024)
#define OUTPUT_BYTES (1024 * 1024)
#define PATH_BYTES 4096

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
} slop_io;

extern int piodide_spawn(const char *path, const char *argv_blob, const char *cwd,
                         slop_io *io);
extern char **environ;

int main(int argc, char **argv) {
  char cwd[PATH_BYTES];
  const char *pwd = getenv("PIODIDE_CWD");
  if (!pwd) pwd = getenv("PWD");
  if (!pwd || snprintf(cwd, sizeof cwd, "%s", pwd) >= (int)sizeof cwd) {
    fprintf(stderr, "git: invalid working directory\n");
    return 1;
  }

  char *arguments = malloc(ARG_BYTES);
  char *environment = malloc(ENV_BYTES);
  char *input = NULL;
  char *output = malloc(OUTPUT_BYTES);
  if (!arguments || !environment || !output) {
    fprintf(stderr, "git: out of memory\n");
    free(arguments);
    free(environment);
    free(output);
    return 1;
  }

  size_t used = 0;
  const char *engine = "git-engine";
  size_t length = strlen(engine) + 1;
  memcpy(arguments + used, engine, length);
  used += length;
  for (int index = 1; index < argc; index++) {
    length = strlen(argv[index]) + 1;
    if (used + length + 1 > ARG_BYTES) {
      fprintf(stderr, "git: argument list is too long\n");
      free(arguments);
      free(environment);
      free(output);
      return 2;
    }
    memcpy(arguments + used, argv[index], length);
    used += length;
  }
  arguments[used] = 0;

  size_t env_used = 0;
  for (char **entry = environ; entry && *entry; entry++) {
    length = strlen(*entry) + 1;
    if (env_used + length + 1 > ENV_BYTES) {
      fprintf(stderr, "git: environment is too large\n");
      free(arguments);
      free(environment);
      free(output);
      return 2;
    }
    memcpy(environment + env_used, *entry, length);
    env_used += length;
  }
  environment[env_used++] = 0;

  size_t input_used = 0;
  if (getenv("PIODIDE_STDIN")) {
    input = malloc(STDIN_BYTES + 1);
    if (!input) {
      fprintf(stderr, "git: out of memory\n");
      free(arguments); free(environment); free(output);
      return 1;
    }
    input_used = fread(input, 1, STDIN_BYTES + 1, stdin);
    if (input_used > STDIN_BYTES) {
      fprintf(stderr, "git: stdin exceeds %d bytes\n", STDIN_BYTES);
      free(arguments); free(environment); free(input); free(output);
      return 2;
    }
  }

  int captured = 0;
  slop_io io;
  memset(&io, 0, sizeof io);
  io.capture = output;
  io.capture_cap = OUTPUT_BYTES;
  io.capture_len = &captured;
  io.env_data = environment;
  io.env_len = (int)env_used;
  io.stdin_data = input;
  io.stdin_len = (int)input_used;
  int result = piodide_spawn(engine, arguments, cwd, &io);
  if (captured > OUTPUT_BYTES) {
    fprintf(stderr, "git: output exceeds %d bytes; narrow the command or write smaller output\n",
            OUTPUT_BYTES);
    result = 23;
    captured = 0;
  }
  if (captured > 0 && fwrite(output, 1, (size_t)captured, stdout) != (size_t)captured) {
    fprintf(stderr, "git: failed to write output\n");
    result = 23;
  }
  free(arguments);
  free(environment);
  free(input);
  free(output);
  return result;
}
