/*
 * env — print the environment, one KEY=VALUE per line.
 */
#include <stdio.h>

extern char **environ;

int main(void) {
  for (char **entry = environ; entry && *entry; entry++) {
    printf("%s\n", *entry);
  }
  return 0;
}
