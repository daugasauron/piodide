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
#include <errno.h>

static int cmpstr(const void *a, const void *b) {
  return strcmp(*(char *const *)a, *(char *const *)b);
}

static void print_entry(const char *name, const struct stat *st, int long_fmt) {
  int is_dir = S_ISDIR(st->st_mode);
  if (long_fmt) {
    printf("%8lld %s%s\n", (long long)st->st_size, name, is_dir ? "/" : "");
  } else {
    printf("%s%s\n", name, is_dir ? "/" : "");
  }
}

int main(int argc, char **argv) {
  int long_fmt = 0, all = 0;
  const char *paths[64];
  int npaths = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--help")) { puts("usage: ls [-la] [--] [PATH...]"); return 0; }
    if (!strcmp(argv[i], "--version")) { puts("ls 0.4-piodide"); return 0; }
    if (!strcmp(argv[i], "--")) {
      for (i++; i < argc && npaths < 64; i++) paths[npaths++] = argv[i];
      break;
    }
    if (argv[i][0] == '-' && argv[i][1] != '\0') {
      for (const char *f = argv[i] + 1; *f; f++) {
        if (*f == 'l') long_fmt = 1;
        else if (*f == 'a') all = 1;
        else if (*f == '1') { }
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
    struct stat operand;
    if (stat(path, &operand) != 0) {
      fprintf(stderr, "ls: %s: %s\n", path, strerror(errno));
      rc = 1;
      continue;
    }
    if (!S_ISDIR(operand.st_mode)) {
      print_entry(path, &operand, long_fmt);
      continue;
    }

    if (npaths > 1) printf("%s:\n", path);
    DIR *d = opendir(path);
    if (!d) {
      fprintf(stderr, "ls: %s: %s\n", path, strerror(errno));
      rc = 1;
      continue;
    }
    char *names[4096];
    int n = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      if (!all && e->d_name[0] == '.') continue;
      if (n >= 4096) {
        fprintf(stderr, "ls: %s: entry limit reached\n", path);
        rc = 1;
        break;
      }
      names[n] = strdup(e->d_name);
      if (!names[n]) {
        fprintf(stderr, "ls: %s: out of memory\n", path);
        rc = 1;
        break;
      }
      n++;
    }
    closedir(d);
    qsort(names, n, sizeof(char *), cmpstr);
    for (int i = 0; i < n; i++) {
      char full[4096];
      if (snprintf(full, sizeof full, "%s/%s", path, names[i]) >= (int)sizeof full) {
        fprintf(stderr, "ls: %s/%s: path too long\n", path, names[i]);
        free(names[i]);
        rc = 1;
        continue;
      }
      struct stat st;
      if (stat(full, &st) == 0) {
        print_entry(names[i], &st, long_fmt);
      } else {
        fprintf(stderr, "ls: %s: %s\n", full, strerror(errno));
        rc = 1;
      }
      free(names[i]);
    }
  }
  return rc;
}
