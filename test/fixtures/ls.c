#include <stdio.h>
#include <dirent.h>
#include <errno.h>
#include <string.h>
int main(int argc, char **argv) {
  const char *path = argc > 1 ? argv[1] : ".";
  DIR *d = opendir(path);
  if (!d) { printf("ls: %s: %s\n", path, strerror(errno)); return 1; }
  struct dirent *e;
  while ((e = readdir(d))) printf("%s %d\n", e->d_name, e->d_type);
  closedir(d);
  return 0;
}
