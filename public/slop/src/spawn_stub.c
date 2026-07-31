typedef struct {
  const char *stdin_data; int stdin_len; char *capture; int capture_cap;
  int *capture_len; const char *out_file; int out_append;
  const char *env_data; int env_len;
} slop_io;
__attribute__((noinline, used))
int piodide_spawn(const char *path, const char *argv_blob, const char *cwd, slop_io *io) {
  (void)path; (void)argv_blob; (void)cwd; (void)io; return 127;
}
