#include <stdio.h>
#include <poll.h>
#include <time.h>
#include <unistd.h>
int main(void) {
  struct pollfd pfd = { .fd = 0, .events = POLLIN };
  int rc = poll(&pfd, 1, 0);
  printf("poll-stdin: rc=%d revents=%d\n", rc, pfd.revents);
  struct timespec ts = { .tv_sec = 0, .tv_nsec = 40 * 1000 * 1000 };
  long start = (long)time(NULL);
  nanosleep(&ts, NULL);
  printf("nanosleep-done %ld\n", start);
  return 0;
}
