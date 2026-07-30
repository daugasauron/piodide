/*
 * fd-find — a tiny fd(1)-style file finder for slop.
 * Usage: fd-find [pattern] [path]
 *   Recursively walks path (default: cwd) printing entries whose name
 *   contains pattern (case-insensitive substring; default: everything).
 *   Skips .git; directories are marked with a trailing /.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>

static const char *pattern = "";
#define MAX_DEPTH 128

static int match_ci(const char *name) {
  if (*pattern == '\0') return 1;
  size_t plen = strlen(pattern);
  for (const char *p = name; *p; p++) {
    size_t i = 0;
    while (i < plen && p[i] &&
           tolower((unsigned char)p[i]) == tolower((unsigned char)pattern[i])) {
      i++;
    }
    if (i == plen) return 1;
  }
  return 0;
}

static int walk(const char *path, const char *display, int depth) {
  if (depth > MAX_DEPTH) {
    fprintf(stderr, "fd-find: %s: traversal depth limit reached\n", display);
    return 1;
  }
  DIR *d = opendir(path);
  if (!d) {
    fprintf(stderr, "fd-find: %s: %s\n", display, strerror(errno));
    return 1;
  }
  int rc = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    if (strcmp(e->d_name, ".git") == 0) continue;
    char child[4096];
    char child_display[4096];
    if (snprintf(child, sizeof child, "%s/%s", path, e->d_name) >= (int)sizeof child ||
        snprintf(child_display, sizeof child_display, "%s/%s", display, e->d_name) >=
          (int)sizeof child_display) {
      fprintf(stderr, "fd-find: %s/%s: path too long\n", display, e->d_name);
      rc = 1;
      continue;
    }
    struct stat st;
    if (lstat(child, &st) != 0) {
      fprintf(stderr, "fd-find: %s: %s\n", child_display, strerror(errno));
      rc = 1;
      continue;
    }
    int is_dir = S_ISDIR(st.st_mode);
    if (match_ci(e->d_name)) {
      const char *shown = child_display;
      if (shown[0] == '.' && shown[1] == '/') shown += 2;
      printf("%s%s\n", shown, is_dir ? "/" : "");
    }
    if (is_dir && walk(child, child_display, depth + 1) != 0) rc = 1;
  }
  closedir(d);
  return rc;
}

int main(int argc, char **argv) {
  /* slop passes its cwd as PWD: adopt it so relative paths work. */
  const char *pwd = getenv("PWD");
  if (pwd) chdir(pwd);

  const char *root = ".";
  if (argc > 1) pattern = argv[1];
  if (argc > 2) root = argv[2];
  return walk(root, root, 0);
}
