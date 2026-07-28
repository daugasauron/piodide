#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>

static void report(const char *what, int rc) {
  printf("%s: %s\n", what, rc == 0 ? "ok" : strerror(errno));
}

int main(void) {
  const char *base = "/home/web/fops";
  report("mkdir", mkdir(base, 0755));

  int fd = open("/home/web/fops/data.bin", O_RDWR | O_CREAT | O_TRUNC, 0644);
  report("open-write", fd < 0 ? -1 : 0);
  report("write", write(fd, "0123456789", 10) == 10 ? 0 : -1);

  /* pwrite at offset 2, then pread it back */
  report("pwrite", pwrite(fd, "XX", 2, 2) == 2 ? 0 : -1);
  off_t pos = lseek(fd, 0, SEEK_CUR);
  printf("tell-after-writes: %lld\n", (long long)pos);
  char buf[16] = {0};
  report("pread", pread(fd, buf, 4, 2) == 4 ? 0 : -1);
  printf("pread-got: %.4s\n", buf);

  /* seek + tell */
  report("lseek-set", lseek(fd, 3, SEEK_SET) == 3 ? 0 : -1);
  memset(buf, 0, sizeof buf);
  report("read-at-3", read(fd, buf, 2) == 2 ? 0 : -1);
  printf("read-got: %.2s\n", buf);
  close(fd);

  /* append mode */
  fd = open("/home/web/fops/data.bin", O_WRONLY | O_APPEND);
  report("open-append", fd < 0 ? -1 : 0);
  report("append", write(fd, "END", 3) == 3 ? 0 : -1);
  close(fd);

  struct stat st;
  report("stat", stat("/home/web/fops/data.bin", &st));
  printf("size: %lld\n", (long long)st.st_size);
  printf("is-reg: %d\n", S_ISREG(st.st_mode));

  report("rename", rename("/home/web/fops/data.bin", "/home/web/fops/moved.bin"));
  report("symlink", symlink("moved.bin", "/home/web/fops/link"));
  char target[64] = {0};
  ssize_t tl = readlink("/home/web/fops/link", target, sizeof target - 1);
  report("readlink", tl < 0 ? -1 : 0);
  printf("target: %s\n", target);
  report("stat-via-link", stat("/home/web/fops/link", &st));
  report("lstat-link", lstat("/home/web/fops/link", &st));
  printf("lstat-is-lnk: %d\n", S_ISLNK(st.st_mode));

  report("link", link("/home/web/fops/moved.bin", "/home/web/fops/hard.bin"));
  report("stat-hard", stat("/home/web/fops/hard.bin", &st));
  printf("nlink: %llu\n", (unsigned long long)st.st_nlink);

  report("truncate", truncate("/home/web/fops/moved.bin", 5));
  report("stat-trunc", stat("/home/web/fops/moved.bin", &st));
  printf("trunc-size: %lld\n", (long long)st.st_size);

  report("unlink-hard", unlink("/home/web/fops/hard.bin"));
  report("unlink-link", unlink("/home/web/fops/link"));
  report("unlink-moved", unlink("/home/web/fops/moved.bin"));
  report("rmdir", rmdir(base));
  report("rmdir-missing", rmdir(base));
  return 0;
}
