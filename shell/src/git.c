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
#define OUTPUT_BYTES (1024 * 1024)
#define PATH_BYTES 4096
static const char OUTPUT_TRUNCATED[] = "\n[git: output truncated at 1 MiB]\n";

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

int main(int argc, char **argv) {
  char cwd[PATH_BYTES];
  const char *pwd = getenv("PWD");
  if (!pwd || snprintf(cwd, sizeof cwd, "%s", pwd) >= (int)sizeof cwd) {
    fprintf(stderr, "git: invalid working directory\n");
    return 1;
  }

  char *arguments = malloc(ARG_BYTES);
  char *output = malloc(OUTPUT_BYTES);
  if (!arguments || !output) {
    fprintf(stderr, "git: out of memory\n");
    free(arguments);
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
      free(output);
      return 2;
    }
    memcpy(arguments + used, argv[index], length);
    used += length;
  }
  arguments[used] = 0;

  int captured = 0;
  slop_io io;
  memset(&io, 0, sizeof io);
  io.capture = output;
  io.capture_cap = OUTPUT_BYTES;
  io.capture_len = &captured;
  int result = piodide_spawn(engine, arguments, cwd, &io);
  if (captured > OUTPUT_BYTES) {
    size_t marker = sizeof OUTPUT_TRUNCATED - 1;
    captured = OUTPUT_BYTES - (int)marker;
    memcpy(output + captured, OUTPUT_TRUNCATED, marker);
    captured += (int)marker;
  }
  fwrite(output, 1, (size_t)captured, result == 0 ? stdout : stderr);
  free(arguments);
  free(output);
  return result;
}
