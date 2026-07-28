/*
 * echo — print arguments joined by spaces. -n suppresses the newline.
 */
#include <stdio.h>

int main(int argc, char **argv) {
  int newline = 1;
  int i = 1;
  if (i < argc && argv[i][0] == '-' && argv[i][1] == 'n' && argv[i][2] == '\0') {
    newline = 0;
    i++;
  }
  for (; i < argc; i++) {
    if (i > 1 + (newline == 0)) putchar(' ');
    fputs(argv[i], stdout);
  }
  if (newline) putchar('\n');
  return 0;
}
