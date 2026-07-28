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

static const char *pattern = "";

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

static void walk(const char *path, const char *display) {
  DIR *d = opendir(path);
  if (!d) return;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
    if (strcmp(e->d_name, ".git") == 0) continue;
    char child[4096];
    char child_display[4096];
    snprintf(child, sizeof child, "%s/%s", path, e->d_name);
    snprintf(child_display, sizeof child_display, "%s/%s", display, e->d_name);
    struct stat st;
    int is_dir = stat(child, &st) == 0 && S_ISDIR(st.st_mode);
    if (match_ci(e->d_name)) {
      const char *shown = child_display;
      if (shown[0] == '.' && shown[1] == '/') shown += 2;
      printf("%s%s\n", shown, is_dir ? "/" : "");
    }
    if (is_dir) walk(child, child_display);
  }
  closedir(d);
}

int main(int argc, char **argv) {
  /* slop passes its cwd as PWD: adopt it so relative paths work. */
  const char *pwd = getenv("PWD");
  if (pwd) chdir(pwd);

  const char *root = ".";
  if (argc > 1) pattern = argv[1];
  if (argc > 2) root = argv[2];
  walk(root, root);
  return 0;
}
