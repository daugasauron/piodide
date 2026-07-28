/*
 * grep — simple substring grep for slop (not regex).
 * Usage: grep [-i] [-v] [-n] [-c] pattern [file...]
 *   -i  case-insensitive
 *   -v  invert: print non-matching lines
 *   -n  prefix line numbers
 *   -c  print match counts only
 * Reads stdin when no files are given.
 * Exit: 0 if any line selected, 1 if none, 2 on error.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <unistd.h>

static int icase = 0, invert = 0, numbers = 0, count_only = 0;
static const char *pattern;

static int match_line(const char *line) {
  if (!icase) return strstr(line, pattern) != NULL;
  size_t plen = strlen(pattern);
  for (const char *p = line; *p; p++) {
    size_t i = 0;
    while (i < plen && p[i] &&
           tolower((unsigned char)p[i]) == tolower((unsigned char)pattern[i])) {
      i++;
    }
    if (i == plen) return 1;
  }
  return 0;
}

static int grep_stream(FILE *f, const char *name, int multi) {
  char *line = NULL;
  size_t cap = 0;
  ssize_t n;
  long lineno = 0, count = 0;
  while ((n = getline(&line, &cap, f)) >= 0) {
    lineno++;
    if (match_line(line) == invert) continue;
    count++;
    if (count_only) continue;
    if (multi) printf("%s:", name);
    if (numbers) printf("%ld:", lineno);
    fwrite(line, 1, (size_t)n, stdout);
    if (n > 0 && line[n - 1] != '\n') putchar('\n');
  }
  free(line);
  if (count_only) {
    if (multi) printf("%s:", name);
    printf("%ld\n", count);
  }
  return count > 0 ? 0 : 1;
}

int main(int argc, char **argv) {
  /* slop passes its cwd as PWD: adopt it so relative paths work. */
  const char *pwd = getenv("PWD");
  if (pwd) chdir(pwd);

  int i = 1;
  for (; i < argc && argv[i][0] == '-' && argv[i][1] != '\0'; i++) {
    for (const char *f = argv[i] + 1; *f; f++) {
      if (*f == 'i') icase = 1;
      else if (*f == 'v') invert = 1;
      else if (*f == 'n') numbers = 1;
      else if (*f == 'c') count_only = 1;
      else {
        fprintf(stderr, "grep: unknown option -%c\n", *f);
        return 2;
      }
    }
  }
  if (i >= argc) {
    fprintf(stderr, "usage: grep [-ivnc] pattern [file...]\n");
    return 2;
  }
  pattern = argv[i++];

  if (i >= argc) return grep_stream(stdin, "(standard input)", 0);

  int rc = 1;
  int multi = (argc - i) > 1;
  for (; i < argc; i++) {
    FILE *f = fopen(argv[i], "r");
    if (!f) {
      fprintf(stderr, "grep: %s: %s\n", argv[i], strerror(errno));
      rc = 2;
      continue;
    }
    if (grep_stream(f, argv[i], multi) == 0) rc = 0;
    fclose(f);
  }
  return rc;
}
