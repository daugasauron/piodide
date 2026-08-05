/*
 * env — print the environment, one KEY=VALUE per line.
 */
#include <stdio.h>
#include <string.h>

extern char **environ;

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--help")) {
    puts("usage: env  # print the environment; use NAME=value command in Slop"); return 0;
  }
  if (argc != 1) {
    fputs("env: command execution and options are unsupported; use NAME=value command\n", stderr);
    return 2;
  }
  for (char **entry = environ; entry && *entry; entry++) {
    printf("%s\n", *entry);
  }
  return 0;
}
