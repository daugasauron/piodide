#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  for (int i = 0; i < argc; i++) printf("argv[%d]=%s\n", i, argv[i]);
  const char *v = getenv("TEST_VAR");
  printf("TEST_VAR=%s\n", v ? v : "(null)");
  const char *missing = getenv("DEFINITELY_MISSING");
  printf("MISSING=%s\n", missing ? missing : "(null)");
  return 0;
}
