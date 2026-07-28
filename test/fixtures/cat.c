#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
int main(int argc, char **argv) {
  char buf[256];
  if (argc == 1) {
    ssize_t n;
    while ((n = read(0, buf, sizeof buf)) > 0) write(1, buf, n);
    return 0;
  }
  int rc = 0;
  for (int i = 1; i < argc; i++) {
    int fd = open(argv[i], O_RDONLY);
    if (fd < 0) { printf("cat: %s: %s\n", argv[i], strerror(errno)); rc = 1; continue; }
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf)) > 0) write(1, buf, n);
    close(fd);
  }
  return rc;
}
