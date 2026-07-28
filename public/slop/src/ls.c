/*
 * ls — minimal directory lister for slop.
 * Usage: ls [-l] [-a] [path...]
 *   default: skip dotfiles, sorted, directories marked with /
 *   -l: long format (size + name)
 *   -a: show dotfiles
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <sys/stat.h>

static int cmpstr(const void *a, const void *b) {
  return strcmp(*(char *const *)a, *(char *const *)b);
}

int main(int argc, char **argv) {
  int long_fmt = 0, all = 0;
  const char *paths[64];
  int npaths = 0;
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] == '-' && argv[i][1] != '\0') {
      for (const char *f = argv[i] + 1; *f; f++) {
        if (*f == 'l') long_fmt = 1;
        else if (*f == 'a') all = 1;
        else {
          fprintf(stderr, "ls: unknown option -%c\n", *f);
          return 2;
        }
      }
    } else if (npaths < 64) {
      paths[npaths++] = argv[i];
    }
  }
  if (npaths == 0) paths[npaths++] = ".";

  int rc = 0;
  for (int p = 0; p < npaths; p++) {
    const char *path = paths[p];
    if (npaths > 1) printf("%s:\n", path);
    DIR *d = opendir(path);
    if (!d) {
      fprintf(stderr, "ls: %s: ", path);
      perror(NULL);
      rc = 1;
      continue;
    }
    char *names[4096];
    int n = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL && n < 4096) {
      if (!all && e->d_name[0] == '.') continue;
      names[n++] = strdup(e->d_name);
    }
    closedir(d);
    qsort(names, n, sizeof(char *), cmpstr);
    for (int i = 0; i < n; i++) {
      char full[4096];
      snprintf(full, sizeof full, "%s/%s", path, names[i]);
      struct stat st;
      int has_stat = stat(full, &st) == 0;
      int is_dir = has_stat && S_ISDIR(st.st_mode);
      if (long_fmt) {
        if (has_stat) printf("%8lld %s%s\n", (long long)st.st_size, names[i], is_dir ? "/" : "");
        else printf("%8s %s\n", "?", names[i]);
      } else {
        printf("%s%s\n", names[i], is_dir ? "/" : "");
      }
      free(names[i]);
    }
  }
  return rc;
}
