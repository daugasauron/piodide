/* Small multicall utilities for slop's WASI workspace. */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fnmatch.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define COPY_BUF 65536
#define DATA_LIMIT (16 * 1024 * 1024)
#define SORT_LINES 100000

static const char *prog;
static int errorf(const char *path) { fprintf(stderr, "%s: %s: %s\n", prog, path, strerror(errno)); return 1; }
static const char *base(const char *p) { const char *s = strrchr(p, '/'); return s ? s + 1 : p; }

static int copy_stream(FILE *in, FILE *out) {
  char *buf = malloc(COPY_BUF); if (!buf) return 1;
  size_t n; int rc = 0;
  while ((n = fread(buf, 1, COPY_BUF, in)) != 0)
    if (fwrite(buf, 1, n, out) != n) { rc = 1; break; }
  if (ferror(in)) rc = 1; free(buf); return rc;
}

static int copy_file(const char *src, const char *dst) {
  FILE *in = fopen(src, "rb"); if (!in) return errorf(src);
  FILE *out = fopen(dst, "wb"); if (!out) { fclose(in); return errorf(dst); }
  int rc = copy_stream(in, out); fclose(in);
  if (fclose(out) || rc) { if (!rc) errorf(dst); return 1; }
  return 0;
}

static int mkdir_parents(const char *path) {
  char *s = strdup(path); if (!s) return 1;
  for (char *p = s + (s[0] == '/');; p++) {
    if (*p == '/' || *p == 0) {
      char save = *p; *p = 0;
      if (*s && mkdir(s, 0777) && errno != EEXIST) { free(s); return errorf(path); }
      *p = save; if (!save) break;
    }
  }
  free(s); return 0;
}

static int remove_path(const char *path, int recursive, int force, int depth) {
  if (depth > 128) { fprintf(stderr, "%s: recursion too deep: %s\n", prog, path); return 1; }
  struct stat st;
  if (lstat(path, &st)) return force && errno == ENOENT ? 0 : errorf(path);
  if (S_ISDIR(st.st_mode)) {
    if (!recursive) { errno = EISDIR; return errorf(path); }
    DIR *d = opendir(path); if (!d) return errorf(path);
    struct dirent *e; int rc = 0;
    while ((e = readdir(d))) {
      if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
      size_t n = strlen(path) + strlen(e->d_name) + 2; char *child = malloc(n);
      if (!child) { rc = 1; break; }
      snprintf(child, n, "%s/%s", path, e->d_name);
      if (remove_path(child, recursive, force, depth + 1)) rc = 1;
      free(child);
    }
    closedir(d); if (rmdir(path)) rc = errorf(path); return rc;
  }
  if (unlink(path)) return errorf(path); return 0;
}

static int copy_path(const char *src, const char *dst, int recursive, int depth) {
  if (depth > 128) return 1;
  struct stat st; if (stat(src, &st)) return errorf(src);
  char *actual = NULL;
  struct stat ds;
  if (stat(dst, &ds) == 0 && S_ISDIR(ds.st_mode)) {
    size_t n = strlen(dst) + strlen(base(src)) + 2; actual = malloc(n);
    if (!actual) return 1; snprintf(actual, n, "%s/%s", dst, base(src)); dst = actual;
  }
  struct stat target;
  if (stat(dst, &target) == 0 && target.st_dev == st.st_dev && target.st_ino == st.st_ino) {
    fprintf(stderr, "%s: '%s' and '%s' are the same file\n", prog, src, dst);
    free(actual); return 1;
  }
  int rc = 0;
  if (S_ISDIR(st.st_mode)) {
    if (!recursive) { fprintf(stderr, "%s: omitting directory '%s'\n", prog, src); free(actual); return 1; }
    if (mkdir(dst, 0777) && errno != EEXIST) { rc = errorf(dst); free(actual); return rc; }
    DIR *d = opendir(src); if (!d) { free(actual); return errorf(src); }
    struct dirent *e;
    while ((e = readdir(d))) {
      if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
      size_t a = strlen(src) + strlen(e->d_name) + 2, b = strlen(dst) + strlen(e->d_name) + 2;
      char *ss = malloc(a), *dd = malloc(b);
      if (!ss || !dd) { free(ss); free(dd); rc = 1; break; }
      snprintf(ss, a, "%s/%s", src, e->d_name); snprintf(dd, b, "%s/%s", dst, e->d_name);
      if (copy_path(ss, dd, recursive, depth + 1)) rc = 1;
      free(ss); free(dd);
    }
    closedir(d);
  } else rc = copy_file(src, dst);
  free(actual); return rc;
}

static int cmd_rm(int ac, char **av) {
  int recursive = 0, force = 0, i = 1;
  for (; i < ac && av[i][0] == '-'; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (strchr(av[i], 'r') || strchr(av[i], 'R')) recursive = 1;
    if (strchr(av[i], 'f')) force = 1;
  }
  if (i == ac && !force) { fprintf(stderr, "rm: missing operand\n"); return 1; }
  int rc = 0; for (; i < ac; i++) if (remove_path(av[i], recursive, force, 0)) rc = 1; return rc;
}

static int cmd_cp(int ac, char **av) {
  int recursive = 0, i = 1;
  for (; i < ac && av[i][0] == '-'; i++) { if (strchr(av[i], 'r') || strchr(av[i], 'R')) recursive = 1; }
  if (ac - i < 2) { fprintf(stderr, "cp: source and destination required\n"); return 1; }
  int rc = 0; const char *dst = av[ac - 1]; struct stat st;
  if (ac - i > 2 && (stat(dst, &st) || !S_ISDIR(st.st_mode))) { fprintf(stderr, "cp: destination must be a directory\n"); return 1; }
  for (; i < ac - 1; i++) if (copy_path(av[i], dst, recursive, 0)) rc = 1; return rc;
}

static int cmd_mv(int ac, char **av) {
  if (ac != 3) { fprintf(stderr, "mv: source and destination required\n"); return 1; }
  const char *dst = av[2]; char *actual = NULL; struct stat st;
  if (stat(dst, &st) == 0 && S_ISDIR(st.st_mode)) {
    size_t n = strlen(dst) + strlen(base(av[1])) + 2; actual = malloc(n);
    snprintf(actual, n, "%s/%s", dst, base(av[1])); dst = actual;
  }
  if (!rename(av[1], dst)) { free(actual); return 0; }
  if (copy_path(av[1], dst, 1, 0)) { free(actual); return 1; }
  int rc = remove_path(av[1], 1, 0, 0); free(actual); return rc;
}

static int cmd_mkdir(int ac, char **av) {
  int parents = 0, i = 1;
  for (; i < ac && av[i][0] == '-'; i++) if (strchr(av[i], 'p')) parents = 1;
  if (i == ac) { fprintf(stderr, "mkdir: missing operand\n"); return 1; }
  int rc = 0;
  for (; i < ac; i++) {
    int x = parents ? mkdir_parents(av[i]) : (mkdir(av[i], 0777) ? errorf(av[i]) : 0);
    if (x) rc = 1;
  }
  return rc;
}

static int cmd_rmdir(int ac, char **av) {
  int rc = 0; if (ac < 2) return 1;
  for (int i = 1; i < ac; i++) if (rmdir(av[i])) rc = errorf(av[i]); return rc;
}

static int touch_one(const char *path) {
  FILE *f = fopen(path, "r+b");
  if (!f) { f = fopen(path, "wb"); if (!f) return errorf(path); fclose(f); return 0; }
  struct stat st;
  if (!fstat(fileno(f), &st)) {
    if (st.st_size) { int c = fgetc(f); rewind(f); if (c != EOF) { fputc(c, f); fflush(f); } }
    else { fputc(0, f); fflush(f); ftruncate(fileno(f), 0); }
  }
  fclose(f); return 0;
}

static int cmd_touch(int ac, char **av) {
  int rc = 0, i = 1; while (i < ac && av[i][0] == '-') i++;
  if (i == ac) return 1; for (; i < ac; i++) if (touch_one(av[i])) rc = 1; return rc;
}

static int cmd_ln(int ac, char **av) {
  int symbolic = 0, i = 1;
  for (; i < ac && av[i][0] == '-'; i++) if (strchr(av[i], 's')) symbolic = 1;
  if (ac - i != 2) { fprintf(stderr, "ln: target and link name required\n"); return 1; }
  int rc = symbolic ? symlink(av[i], av[i + 1]) : link(av[i], av[i + 1]);
  return rc ? errorf(av[i + 1]) : 0;
}

static FILE *open_input(const char *name) { return !name || !strcmp(name, "-") ? stdin : fopen(name, "rb"); }

static int cmd_head(int ac, char **av) {
  long count = 10; int i = 1;
  if (i < ac && !strcmp(av[i], "-n") && i + 1 < ac) { count = strtol(av[i + 1], NULL, 10); i += 2; }
  else if (i < ac && av[i][0] == '-' && isdigit((unsigned char)av[i][1])) count = strtol(av[i++] + 1, NULL, 10);
  if (i == ac) { av[--i] = "-"; ac = i + 1; }
  int rc = 0;
  for (; i < ac; i++) {
    FILE *f = open_input(av[i]); if (!f) { rc = errorf(av[i]); continue; }
    char buf[8192]; long lines = 0;
    while (lines < count && fgets(buf, sizeof buf, f)) { fputs(buf, stdout); if (strchr(buf, '\n')) lines++; }
    if (f != stdin) fclose(f);
  }
  return rc;
}

static char *read_all(FILE *f, size_t *size) {
  size_t cap = 65536, n = 0; char *data = malloc(cap);
  if (!data) return NULL;
  for (;;) {
    if (n == cap) { if (cap >= DATA_LIMIT) { free(data); errno = EFBIG; return NULL; } cap *= 2; data = realloc(data, cap); if (!data) return NULL; }
    size_t got = fread(data + n, 1, cap - n, f); n += got;
    if (!got) break;
  }
  if (n == cap) { char *grown = realloc(data, cap + 1); if (!grown) { free(data); return NULL; } data = grown; }
  data[n] = 0; *size = n; return data;
}

static int cmd_tail(int ac, char **av) {
  long count = 10; int i = 1;
  if (i < ac && !strcmp(av[i], "-n") && i + 1 < ac) { count = strtol(av[i + 1], NULL, 10); i += 2; }
  const char *name = i < ac ? av[i] : "-"; FILE *f = open_input(name);
  if (!f) return errorf(name); size_t n; char *data = read_all(f, &n); if (f != stdin) fclose(f);
  if (!data) return errorf(name);
  size_t p = n; long seen = 0;
  if (p && data[p - 1] == '\n') p--;
  while (p && seen < count) if (data[--p] == '\n') { seen++; if (seen == count) { p++; break; } }
  fwrite(data + p, 1, n - p, stdout); free(data); return 0;
}

static int cmd_wc(int ac, char **av) {
  int show_l = 0, show_w = 0, show_c = 0, i = 1;
  for (; i < ac && av[i][0] == '-'; i++) { show_l |= strchr(av[i], 'l') != NULL; show_w |= strchr(av[i], 'w') != NULL; show_c |= strchr(av[i], 'c') != NULL; }
  if (!show_l && !show_w && !show_c) show_l = show_w = show_c = 1;
  const char *name = i < ac ? av[i] : "-"; FILE *f = open_input(name); if (!f) return errorf(name);
  unsigned long l = 0, w = 0, c = 0; int ch, inword = 0;
  while ((ch = fgetc(f)) != EOF) { c++; if (ch == '\n') l++; if (isspace((unsigned char)ch)) inword = 0; else if (!inword) { inword = 1; w++; } }
  if (f != stdin) fclose(f); if (show_l) printf("%lu ", l); if (show_w) printf("%lu ", w); if (show_c) printf("%lu ", c); if (strcmp(name, "-")) printf("%s", name); putchar('\n'); return 0;
}

static int reverse_sort;
static int linecmp(const void *a, const void *b) {
  int x = strcmp(*(char *const *)a, *(char *const *)b); return reverse_sort ? -x : x;
}

static int cmd_sort(int ac, char **av) {
  int unique = 0, i = 1; reverse_sort = 0;
  for (; i < ac && av[i][0] == '-'; i++) { reverse_sort |= strchr(av[i], 'r') != NULL; unique |= strchr(av[i], 'u') != NULL; }
  const char *name = i < ac ? av[i] : "-"; FILE *f = open_input(name); if (!f) return errorf(name);
  size_t n; char *data = read_all(f, &n); if (f != stdin) fclose(f); if (!data) return errorf(name);
  char **lines = malloc(SORT_LINES * sizeof *lines); if (!lines) { free(data); return 1; }
  int nl = 0; size_t p = 0;
  while (p < n && nl < SORT_LINES) {
    lines[nl++] = data + p; while (p < n && data[p] != '\n') p++;
    if (p < n) data[p++] = 0; else data[n] = 0;
  }
  if (p < n) { fprintf(stderr, "sort: too many lines\n"); free(lines); free(data); return 1; }
  qsort(lines, (size_t)nl, sizeof *lines, linecmp);
  for (int x = 0; x < nl; x++) if (!unique || !x || strcmp(lines[x], lines[x - 1])) puts(lines[x]);
  free(lines); free(data); return 0;
}

static int cmd_cut(int ac, char **av) {
  char delim = '\t'; int field = 0, i = 1;
  while (i < ac && av[i][0] == '-') {
    if (!strcmp(av[i], "-d") && i + 1 < ac) { delim = av[i + 1][0]; i += 2; }
    else if (!strcmp(av[i], "-f") && i + 1 < ac) { field = atoi(av[i + 1]); i += 2; }
    else if (!strncmp(av[i], "-f", 2)) { field = atoi(av[i] + 2); i++; }
    else i++;
  }
  if (field < 1) { fprintf(stderr, "cut: a positive -f field is required\n"); return 1; }
  FILE *f = i < ac ? fopen(av[i], "r") : stdin; if (!f) return errorf(av[i]);
  char line[65536];
  while (fgets(line, sizeof line, f)) {
    char *p = line, *start = p; int current = 1;
    while (*p && current < field) if (*p++ == delim) { current++; start = p; }
    if (current == field) { p = start; while (*p && *p != delim && *p != '\n') p++; fwrite(start, 1, (size_t)(p - start), stdout); }
    putchar('\n');
  }
  if (f != stdin) fclose(f); return 0;
}

static int cmd_tr(int ac, char **av) {
  int del = 0, i = 1; if (i < ac && !strcmp(av[i], "-d")) { del = 1; i++; }
  if ((del && ac - i < 1) || (!del && ac - i < 2)) return 1;
  const unsigned char *from = (unsigned char *)av[i], *to = del ? NULL : (unsigned char *)av[i + 1];
  size_t nt = to ? strlen((char *)to) : 0; int c;
  if (!del && !nt) return 1;
  while ((c = getchar()) != EOF) {
    const unsigned char *p = (const unsigned char *)strchr((char *)from, c);
    if (p) { if (del) continue; size_t ix = (size_t)(p - from); c = to[ix < nt ? ix : nt - 1]; }
    putchar(c);
  }
  return 0;
}

static int cmd_tee(int ac, char **av) {
  int append = 0, i = 1; if (i < ac && !strcmp(av[i], "-a")) { append = 1; i++; }
  int nf = ac - i; FILE **files = calloc((size_t)(nf ? nf : 1), sizeof *files); if (!files) return 1;
  int rc = 0; for (int x = 0; x < nf; x++) if (!(files[x] = fopen(av[i + x], append ? "ab" : "wb"))) rc = errorf(av[i + x]);
  char buf[8192]; size_t n;
  while ((n = fread(buf, 1, sizeof buf, stdin))) {
    fwrite(buf, 1, n, stdout); for (int x = 0; x < nf; x++) if (files[x]) fwrite(buf, 1, n, files[x]);
  }
  for (int x = 0; x < nf; x++) if (files[x]) fclose(files[x]); free(files); return rc;
}

static int cmd_basename(int ac, char **av) {
  if (ac < 2) return 1; const char *b = base(av[1]); size_t n = strlen(b);
  if (ac > 2) { size_t s = strlen(av[2]); if (n > s && !strcmp(b + n - s, av[2])) n -= s; }
  fwrite(b, 1, n, stdout); putchar('\n'); return 0;
}

static int cmd_dirname(int ac, char **av) {
  if (ac < 2) return 1; char *s = strdup(av[1]); size_t n = strlen(s);
  while (n > 1 && s[n - 1] == '/') s[--n] = 0; char *p = strrchr(s, '/');
  if (!p) puts("."); else { while (p > s && p[-1] == '/') p--; if (p == s) p++; *p = 0; puts(*s ? s : "/"); }
  free(s); return 0;
}

static int cmd_seq(int ac, char **av) {
  long first = 1, step = 1, last;
  if (ac == 2) last = strtol(av[1], NULL, 10);
  else if (ac == 3) { first = strtol(av[1], NULL, 10); last = strtol(av[2], NULL, 10); }
  else if (ac == 4) { first = strtol(av[1], NULL, 10); step = strtol(av[2], NULL, 10); last = strtol(av[3], NULL, 10); }
  else return 1;
  if (!step) return 1; long count = 0;
  for (long x = first; (step > 0 ? x <= last : x >= last) && count++ < 1000000; x += step) printf("%ld\n", x);
  return 0;
}

static int cmd_cmp(int ac, char **av) {
  if (ac < 3) return 2; FILE *a = fopen(av[1], "rb"), *b = fopen(av[2], "rb");
  if (!a || !b) { if (a) fclose(a); if (b) fclose(b); return 2; }
  unsigned long pos = 1, line = 1; int x, y;
  do { x = fgetc(a); y = fgetc(b); if (x != y) { printf("%s %s differ: byte %lu, line %lu\n", av[1], av[2], pos, line); fclose(a); fclose(b); return 1; } if (x == '\n') line++; pos++; } while (x != EOF);
  fclose(a); fclose(b); return 0;
}

static int cmd_readlink(int ac, char **av) {
  if (ac != 2) return 1; char buf[65536]; ssize_t n = readlink(av[1], buf, sizeof buf - 1);
  if (n < 0) return errorf(av[1]); buf[n] = 0; puts(buf); return 0;
}

static int find_walk(const char *path, const char *pattern, int wanted, int depth) {
  if (depth > 128) return 1; struct stat st; if (lstat(path, &st)) return errorf(path);
  int type = S_ISDIR(st.st_mode) ? 'd' : S_ISREG(st.st_mode) ? 'f' : 'l';
  if ((!wanted || wanted == type) && (!pattern || fnmatch(pattern, base(path), 0) == 0)) puts(path);
  if (type != 'd') return 0; DIR *d = opendir(path); if (!d) return errorf(path);
  struct dirent *e; int rc = 0;
  while ((e = readdir(d))) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    size_t n = strlen(path) + strlen(e->d_name) + 2; char *child = malloc(n); if (!child) { rc = 1; break; }
    snprintf(child, n, "%s/%s", path, e->d_name); if (find_walk(child, pattern, wanted, depth + 1)) rc = 1; free(child);
  }
  closedir(d); return rc;
}

static int cmd_find(int ac, char **av) {
  int i = 1; const char *paths[128]; int np = 0; while (i < ac && av[i][0] != '-') { if (np < 128) paths[np++] = av[i]; i++; }
  if (!np) paths[np++] = "."; const char *pattern = NULL; int wanted = 0;
  while (i < ac) {
    if (!strcmp(av[i], "-name") && i + 1 < ac) { pattern = av[i + 1]; i += 2; }
    else if (!strcmp(av[i], "-type") && i + 1 < ac) { wanted = av[i + 1][0]; i += 2; }
    else if (!strcmp(av[i], "-print")) i++;
    else { fprintf(stderr, "find: unsupported expression: %s\n", av[i]); return 1; }
  }
  int rc = 0; for (i = 0; i < np; i++) if (find_walk(paths[i], pattern, wanted, 0)) rc = 1; return rc;
}

static int cmd_mktemp(int ac, char **av) {
  int directory = 0, i = 1; if (i < ac && !strcmp(av[i], "-d")) { directory = 1; i++; }
  char *pattern = strdup(i < ac ? av[i] : "tmp.XXXXXX"); if (!pattern) return 1;
  if (!strstr(pattern, "XXXXXX")) { fprintf(stderr, "mktemp: template must contain XXXXXX\n"); free(pattern); return 1; }
  char *xs = strstr(pattern, "XXXXXX"); int made = 0;
  for (unsigned attempt = 0; attempt < 1000 && !made; attempt++) {
    unsigned value = (unsigned)time(NULL) ^ (attempt * 2654435761u);
    static const char hex[] = "0123456789abcdef";
    for (int k = 0; k < 6; k++) { xs[k] = hex[value & 15]; value >>= 4; }
    if (directory) made = mkdir(pattern, 0700) == 0;
    else { FILE *f = fopen(pattern, "wx"); if (f) { fclose(f); made = 1; } }
    if (!made && errno != EEXIST) break;
  }
  if (!made) { int rc = errorf(pattern); free(pattern); return rc; }
  puts(pattern); free(pattern); return 0;
}

static int cmd_install(int ac, char **av) {
  int directory = 0, i = 1;
  while (i < ac && av[i][0] == '-') {
    if (!strcmp(av[i], "-d")) { directory = 1; i++; }
    else if ((!strcmp(av[i], "-m") || !strcmp(av[i], "-o") || !strcmp(av[i], "-g")) && i + 1 < ac) i += 2;
    else i++;
  }
  if (directory) { int rc = 0; for (; i < ac; i++) if (mkdir_parents(av[i])) rc = 1; return rc; }
  if (ac - i < 2) return 1; int rc = 0; const char *dst = av[ac - 1];
  for (; i < ac - 1; i++) if (copy_path(av[i], dst, 0, 0)) rc = 1; return rc;
}

int main(int argc, char **argv) {
  prog = base(argv[0]);
  if (!strcmp(prog, "rm")) return cmd_rm(argc, argv);
  if (!strcmp(prog, "cp")) return cmd_cp(argc, argv);
  if (!strcmp(prog, "mv")) return cmd_mv(argc, argv);
  if (!strcmp(prog, "mkdir")) return cmd_mkdir(argc, argv);
  if (!strcmp(prog, "rmdir")) return cmd_rmdir(argc, argv);
  if (!strcmp(prog, "touch")) return cmd_touch(argc, argv);
  if (!strcmp(prog, "ln")) return cmd_ln(argc, argv);
  if (!strcmp(prog, "head")) return cmd_head(argc, argv);
  if (!strcmp(prog, "tail")) return cmd_tail(argc, argv);
  if (!strcmp(prog, "wc")) return cmd_wc(argc, argv);
  if (!strcmp(prog, "sort")) return cmd_sort(argc, argv);
  if (!strcmp(prog, "cut")) return cmd_cut(argc, argv);
  if (!strcmp(prog, "tr")) return cmd_tr(argc, argv);
  if (!strcmp(prog, "tee")) return cmd_tee(argc, argv);
  if (!strcmp(prog, "basename")) return cmd_basename(argc, argv);
  if (!strcmp(prog, "dirname")) return cmd_dirname(argc, argv);
  if (!strcmp(prog, "seq")) return cmd_seq(argc, argv);
  if (!strcmp(prog, "cmp")) return cmd_cmp(argc, argv);
  if (!strcmp(prog, "install")) return cmd_install(argc, argv);
  if (!strcmp(prog, "readlink")) return cmd_readlink(argc, argv);
  if (!strcmp(prog, "find")) return cmd_find(argc, argv);
  if (!strcmp(prog, "mktemp")) return cmd_mktemp(argc, argv);
  fprintf(stderr, "coreutils: unknown applet '%s'\n", prog); return 127;
}
