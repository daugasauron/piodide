/*
 * cat — concatenate files (or stdin with no args / "-") to stdout.
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>

static int pump(int fd) {
  char buf[4096];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf)) > 0) {
    ssize_t off = 0;
    while (off < n) {
      ssize_t w = write(STDOUT_FILENO, buf + off, (size_t)(n - off));
      if (w < 0) return -1;
      off += w;
    }
  }
  return n < 0 ? -1 : 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--help") == 0) {
    puts("usage: cat [--] [FILE...]"); return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("cat 0.4-piodide"); return 0;
  }
  int first = 1;
  if (first < argc && strcmp(argv[first], "--") == 0) first++;
  if (first == argc) return pump(STDIN_FILENO) < 0 ? 1 : 0;
  int rc = 0;
  for (int i = first; i < argc; i++) {
    if (strcmp(argv[i], "-") == 0) {
      if (pump(STDIN_FILENO) < 0) rc = 1;
      continue;
    }
    int fd = open(argv[i], O_RDONLY);
    if (fd < 0) {
      fprintf(stderr, "cat: %s: %s\n", argv[i], strerror(errno));
      rc = 1;
      continue;
    }
    if (pump(fd) < 0) {
      fprintf(stderr, "cat: %s: %s\n", argv[i], strerror(errno));
      rc = 1;
    }
    close(fd);
  }
  return rc;
}
