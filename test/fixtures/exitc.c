#include <stdio.h>
int main(int argc, char **argv) {
  fprintf(stderr, "to-stderr\n");
  (void)argv;
  return argc;
}
