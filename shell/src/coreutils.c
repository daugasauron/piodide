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
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

/* WASI libc may not declare chmod */
#ifdef __wasi__
/* WASI doesn't expose chmod; treat as no-op success since permissions are host-managed */
static int chmod(const char *path, mode_t mode) { (void)path; (void)mode; return 0; }
#else
int chmod(const char *, mode_t);
#endif

#define COPY_BUF 65536
#define DATA_LIMIT (16 * 1024 * 1024)
#define SORT_LINES 100000
#define XARGS_MAX 128
#define XARGS_BLOB 16384
#define ENV_LIMIT 65536

typedef struct {
  const char *stdin_data; int stdin_len; char *capture; int capture_cap;
  int *capture_len; const char *out_file; int out_append;
  const char *env_data; int env_len;
} slop_io;
extern int piodide_spawn(const char *path, const char *argv_blob, const char *cwd,
                         slop_io *io);
extern char **environ;

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
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (av[i][1] == '-') { fprintf(stderr, "rm: unsupported option: %s\n", av[i]); return 2; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'r' || *flag == 'R') recursive = 1;
      else if (*flag == 'f') force = 1;
      else { fprintf(stderr, "rm: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (i == ac && !force) { fprintf(stderr, "rm: missing operand\n"); return 1; }
  int rc = 0; for (; i < ac; i++) if (remove_path(av[i], recursive, force, 0)) rc = 1; return rc;
}

static int cmd_cp(int ac, char **av) {
  int recursive = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'r' || *flag == 'R' || *flag == 'a') recursive = 1;
      else if (*flag == 'f' || *flag == 'p') { }
      else { fprintf(stderr, "cp: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (ac - i < 2) { fprintf(stderr, "cp: source and destination required\n"); return 1; }
  int rc = 0; const char *dst = av[ac - 1]; struct stat st;
  if (ac - i > 2 && (stat(dst, &st) || !S_ISDIR(st.st_mode))) { fprintf(stderr, "cp: destination must be a directory\n"); return 1; }
  for (; i < ac - 1; i++) if (copy_path(av[i], dst, recursive, 0)) rc = 1; return rc;
}

static int cmd_mv(int ac, char **av) {
  int i = 1, no_clobber = 0;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'f') no_clobber = 0;
      else if (*flag == 'n') no_clobber = 1;
      else { fprintf(stderr, "mv: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (ac - i != 2) { fprintf(stderr, "mv: source and destination required\n"); return 1; }
  const char *src = av[i], *dst = av[i + 1]; char *actual = NULL; struct stat st;
  if (stat(dst, &st) == 0 && S_ISDIR(st.st_mode)) {
    size_t n = strlen(dst) + strlen(base(src)) + 2; actual = malloc(n);
    if (!actual) return 1;
    snprintf(actual, n, "%s/%s", dst, base(src)); dst = actual;
  }
  if (no_clobber && stat(dst, &st) == 0) { free(actual); return 0; }
  if (!rename(src, dst)) { free(actual); return 0; }
  if (copy_path(src, dst, 1, 0)) { free(actual); return 1; }
  int rc = remove_path(src, 1, 0, 0); free(actual); return rc;
}

static int cmd_mkdir(int ac, char **av) {
  int parents = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'p') parents = 1;
      else { fprintf(stderr, "mkdir: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (i == ac) { fprintf(stderr, "mkdir: missing operand\n"); return 1; }
  int rc = 0;
  for (; i < ac; i++) {
    int x = parents ? mkdir_parents(av[i]) : (mkdir(av[i], 0777) ? errorf(av[i]) : 0);
    if (x) rc = 1;
  }
  return rc;
}

static int cmd_rmdir(int ac, char **av) {
  int rc = 0, i = 1;
  if (i < ac && !strcmp(av[i], "--")) i++;
  else if (i < ac && av[i][0] == '-') { fprintf(stderr, "rmdir: unsupported option: %s\n", av[i]); return 2; }
  if (i == ac) return 1;
  for (; i < ac; i++) if (rmdir(av[i])) rc = errorf(av[i]); return rc;
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
  int rc = 0, no_create = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'c') no_create = 1;
      else { fprintf(stderr, "touch: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (i == ac) return 1;
  for (; i < ac; i++) {
    struct stat status;
    if (no_create && stat(av[i], &status) != 0 && errno == ENOENT) continue;
    if (touch_one(av[i])) rc = 1;
  }
  return rc;
}

static int cmd_ln(int ac, char **av) {
  int symbolic = 0, force = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 's') symbolic = 1;
      else if (*flag == 'f') force = 1;
      else { fprintf(stderr, "ln: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (ac - i != 2) { fprintf(stderr, "ln: target and link name required\n"); return 1; }
  if (force) unlink(av[i + 1]);
  int rc = symbolic ? symlink(av[i], av[i + 1]) : link(av[i], av[i + 1]);
  return rc ? errorf(av[i + 1]) : 0;
}

static FILE *open_input(const char *name) { return !name || !strcmp(name, "-") ? stdin : fopen(name, "rb"); }

static int cmd_head(int ac, char **av) {
  long count = 10, byte_count = -1; int i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if ((!strcmp(av[i], "-n") || !strcmp(av[i], "--lines")) && i + 1 < ac) {
      count = strtol(av[i + 1], NULL, 10); i += 2;
    } else if ((!strcmp(av[i], "-c") || !strcmp(av[i], "--bytes")) && i + 1 < ac) {
      byte_count = strtol(av[i + 1], NULL, 10); i += 2;
    } else if (!strncmp(av[i], "--lines=", 8)) { count = strtol(av[i++] + 8, NULL, 10); }
    else if (!strncmp(av[i], "--bytes=", 8)) { byte_count = strtol(av[i++] + 8, NULL, 10); }
    else if (!strncmp(av[i], "-c", 2) && av[i][2]) { byte_count = strtol(av[i++] + 2, NULL, 10); }
    else if (isdigit((unsigned char)av[i][1])) count = strtol(av[i++] + 1, NULL, 10);
    else { fprintf(stderr, "head: unsupported option: %s\n", av[i]); return 2; }
  }
  if (count < 0 || byte_count < -1) { fprintf(stderr, "head: count must be non-negative\n"); return 2; }
  if (i == ac) { av[--i] = "-"; ac = i + 1; }
  int rc = 0;
  for (; i < ac; i++) {
    FILE *f = open_input(av[i]); if (!f) { rc = errorf(av[i]); continue; }
    char buf[8192];
    if (byte_count >= 0) {
      long left = byte_count;
      while (left > 0) {
        size_t wanted = left < (long)sizeof buf ? (size_t)left : sizeof buf;
        size_t got = fread(buf, 1, wanted, f);
        if (!got) break;
        if (fwrite(buf, 1, got, stdout) != got) { rc = 1; break; }
        left -= (long)got;
      }
    } else {
      long lines = 0;
      while (lines < count && fgets(buf, sizeof buf, f)) { fputs(buf, stdout); if (strchr(buf, '\n')) lines++; }
    }
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
  long count = 10; int from_start = 0, i = 1;
  if (i < ac && (!strcmp(av[i], "-n") || !strcmp(av[i], "--lines")) && i + 1 < ac) {
    const char *value = av[i + 1]; from_start = value[0] == '+'; count = strtol(value, NULL, 10); i += 2;
  } else if (i < ac && !strncmp(av[i], "--lines=", 8)) {
    const char *value = av[i] + 8; from_start = value[0] == '+'; count = strtol(value, NULL, 10); i++;
  } else if (i < ac && !strncmp(av[i], "-n", 2) && av[i][2]) {
    const char *value = av[i] + 2; from_start = value[0] == '+'; count = strtol(value, NULL, 10); i++;
  } else if (i < ac && av[i][0] == '-') {
    fprintf(stderr, "tail: unsupported option: %s\n", av[i]); return 2;
  }
  if (ac - i > 1) { fprintf(stderr, "tail: only one input file is supported\n"); return 2; }
  if (count < 0) count = -count;
  const char *name = i < ac ? av[i] : "-"; FILE *f = open_input(name);
  if (!f) return errorf(name); size_t n; char *data = read_all(f, &n); if (f != stdin) fclose(f);
  if (!data) return errorf(name);
  size_t p = 0;
  if (from_start) {
    long line = 1;
    while (p < n && line < count) if (data[p++] == '\n') line++;
  } else {
    p = n; long seen = 0;
    if (p && data[p - 1] == '\n') p--;
    while (p && seen < count) if (data[--p] == '\n') { seen++; if (seen == count) { p++; break; } }
  }
  fwrite(data + p, 1, n - p, stdout); free(data); return 0;
}

static int cmd_wc(int ac, char **av) {
  int show_l = 0, show_w = 0, show_c = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'l') show_l = 1;
      else if (*flag == 'w') show_w = 1;
      else if (*flag == 'c') show_c = 1;
      else { fprintf(stderr, "wc: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (!show_l && !show_w && !show_c) show_l = show_w = show_c = 1;
  if (ac - i > 1) { fprintf(stderr, "wc: only one input file is supported\n"); return 2; }
  const char *name = i < ac ? av[i] : "-"; FILE *f = open_input(name); if (!f) return errorf(name);
  unsigned long l = 0, w = 0, c = 0; int ch, inword = 0;
  while ((ch = fgetc(f)) != EOF) { c++; if (ch == '\n') l++; if (isspace((unsigned char)ch)) inword = 0; else if (!inword) { inword = 1; w++; } }
  if (f != stdin) fclose(f); if (show_l) printf("%lu ", l); if (show_w) printf("%lu ", w); if (show_c) printf("%lu ", c); if (strcmp(name, "-")) printf("%s", name); putchar('\n'); return 0;
}

static int reverse_sort, numeric_sort;
static int linecmp(const void *a, const void *b) {
  int x;
  if (numeric_sort) {
    double left = strtod(*(char *const *)a, NULL), right = strtod(*(char *const *)b, NULL);
    x = left < right ? -1 : left > right ? 1 : strcmp(*(char *const *)a, *(char *const *)b);
  } else x = strcmp(*(char *const *)a, *(char *const *)b);
  return reverse_sort ? -x : x;
}

static int cmd_sort(int ac, char **av) {
  int unique = 0, i = 1; reverse_sort = numeric_sort = 0;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'r') reverse_sort = 1;
      else if (*flag == 'u') unique = 1;
      else if (*flag == 'n') numeric_sort = 1;
      else { fprintf(stderr, "sort: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (ac - i > 1) { fprintf(stderr, "sort: only one input file is supported\n"); return 2; }
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
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "-d") && i + 1 < ac) { delim = av[i + 1][0]; i += 2; }
    else if (!strncmp(av[i], "--delimiter=", 12) && av[i][12]) { delim = av[i][12]; i++; }
    else if (!strncmp(av[i], "-d", 2) && av[i][2]) { delim = av[i][2]; i++; }
    else if (!strcmp(av[i], "-f") && i + 1 < ac) { field = atoi(av[i + 1]); i += 2; }
    else if (!strncmp(av[i], "--fields=", 9)) { field = atoi(av[i] + 9); i++; }
    else if (!strncmp(av[i], "-f", 2)) { field = atoi(av[i] + 2); i++; }
    else { fprintf(stderr, "cut: unsupported option: %s\n", av[i]); return 2; }
  }
  if (field < 1) { fprintf(stderr, "cut: a positive -f field is required\n"); return 1; }
  if (ac - i > 1) { fprintf(stderr, "cut: only one input file is supported\n"); return 2; }
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

static int tr_append(unsigned char *out, size_t *used, unsigned char value) {
  if (*used >= 512) return 0; out[(*used)++] = value; return 1;
}

static int tr_class(const char *value, unsigned char *out, size_t *used, size_t *consumed) {
  struct Class { const char *name; const char *chars; } classes[] = {
    { "[:lower:]", "abcdefghijklmnopqrstuvwxyz" },
    { "[:upper:]", "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    { "[:digit:]", "0123456789" },
    { "[:space:]", " \t\r\n\v\f" },
    { "[:alpha:]", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    { "[:alnum:]", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
  };
  for (size_t index = 0; index < sizeof classes / sizeof classes[0]; index++) {
    size_t length = strlen(classes[index].name);
    if (!strncmp(value, classes[index].name, length)) {
      for (const char *p = classes[index].chars; *p; p++) if (!tr_append(out, used, (unsigned char)*p)) return -1;
      *consumed = length; return 1;
    }
  }
  return 0;
}

static int tr_expand(const char *value, unsigned char *out, size_t *length) {
  *length = 0;
  for (size_t index = 0; value[index];) {
    size_t consumed = 0;
    int class_result = tr_class(value + index, out, length, &consumed);
    if (class_result < 0) return 0;
    if (class_result > 0) { index += consumed; continue; }
    unsigned char first = (unsigned char)value[index++];
    if (first == '\\' && value[index]) {
      unsigned char escaped = (unsigned char)value[index++];
      first = escaped == 'n' ? '\n' : escaped == 'r' ? '\r' : escaped == 't' ? '\t' :
        escaped == 'v' ? '\v' : escaped == 'f' ? '\f' : escaped;
    }
    if (value[index] == '-' && value[index + 1]) {
      index++;
      unsigned char last = (unsigned char)value[index++];
      if (last == '\\' && value[index]) last = (unsigned char)value[index++];
      if (last < first) return 0;
      for (unsigned value_byte = first; value_byte <= last; value_byte++)
        if (!tr_append(out, length, (unsigned char)value_byte)) return 0;
    } else if (!tr_append(out, length, first)) return 0;
  }
  return 1;
}

static int tr_index(const unsigned char *set, size_t length, unsigned char value) {
  for (size_t index = 0; index < length; index++) if (set[index] == value) return (int)index;
  return -1;
}

static int cmd_tr(int ac, char **av) {
  int del = 0, squeeze = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'd') del = 1;
      else if (*flag == 's') squeeze = 1;
      else { fprintf(stderr, "tr: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  int operands = ac - i;
  int translate = !del && operands == 2;
  int second_squeeze_set = del && squeeze && operands == 2;
  if (operands < 1 || operands > 2 || (!del && !squeeze && !translate) ||
      (del && !squeeze && operands != 1)) {
    fprintf(stderr, "tr: expected SET1%s\n", del || squeeze ? " [SET2]" : " SET2"); return 2;
  }
  unsigned char from[512], to[512]; size_t nf = 0, nt = 0;
  if (!tr_expand(av[i], from, &nf) ||
      ((translate || second_squeeze_set) && !tr_expand(av[i + 1], to, &nt)) ||
      ((translate || second_squeeze_set) && !nt)) {
    fprintf(stderr, "tr: invalid or oversized character set\n"); return 2;
  }
  const unsigned char *squeeze_set = translate || second_squeeze_set ? to : from;
  size_t squeeze_length = translate || second_squeeze_set ? nt : nf;
  int c, previous = -1;
  while ((c = getchar()) != EOF) {
    int index = tr_index(from, nf, (unsigned char)c);
    if (index >= 0) {
      if (del) continue;
      if (translate) c = to[(size_t)index < nt ? (size_t)index : nt - 1];
    }
    if (squeeze && c == previous && tr_index(squeeze_set, squeeze_length, (unsigned char)c) >= 0) continue;
    putchar(c); previous = c;
  }
  return 0;
}

static int cmd_tee(int ac, char **av) {
  int append = 0, i = 1;
  if (i < ac && (!strcmp(av[i], "-a") || !strcmp(av[i], "--append"))) { append = 1; i++; }
  if (i < ac && !strcmp(av[i], "--")) i++;
  else if (i < ac && av[i][0] == '-') { fprintf(stderr, "tee: unsupported option: %s\n", av[i]); return 2; }
  int nf = ac - i; FILE **files = calloc((size_t)(nf ? nf : 1), sizeof *files); if (!files) return 1;
  int rc = 0; for (int x = 0; x < nf; x++) if (!(files[x] = fopen(av[i + x], append ? "ab" : "wb"))) rc = errorf(av[i + x]);
  char buf[8192]; size_t n;
  while ((n = fread(buf, 1, sizeof buf, stdin))) {
    fwrite(buf, 1, n, stdout); for (int x = 0; x < nf; x++) if (files[x]) fwrite(buf, 1, n, files[x]);
  }
  for (int x = 0; x < nf; x++) if (files[x]) fclose(files[x]); free(files); return rc;
}

static int cmd_basename(int ac, char **av) {
  if (ac < 2 || ac > 3) { fprintf(stderr, "basename: expected PATH [SUFFIX]\n"); return 2; }
  const char *b = base(av[1]); size_t n = strlen(b);
  if (ac > 2) { size_t s = strlen(av[2]); if (n > s && !strcmp(b + n - s, av[2])) n -= s; }
  fwrite(b, 1, n, stdout); putchar('\n'); return 0;
}

static int cmd_dirname(int ac, char **av) {
  if (ac != 2) { fprintf(stderr, "dirname: expected one path\n"); return 2; }
  char *s = strdup(av[1]); size_t n = strlen(s);
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
  if (ac != 2 || av[1][0] == '-') { fprintf(stderr, "readlink: expected one link path\n"); return 2; }
  char buf[65536]; ssize_t n = readlink(av[1], buf, sizeof buf - 1);
  if (n < 0) return errorf(av[1]); buf[n] = 0; puts(buf); return 0;
}

static void find_print(const char *path, int nul) {
  fwrite(path, 1, strlen(path), stdout);
  putchar(nul ? '\0' : '\n');
}

static int find_walk(const char *path, const char *pattern, int wanted, int depth,
                     int max_depth, int nul) {
  if (depth > 128) return 1; struct stat st; if (lstat(path, &st)) return errorf(path);
  int type = S_ISDIR(st.st_mode) ? 'd' : S_ISREG(st.st_mode) ? 'f' : 'l';
  if ((!wanted || wanted == type) && (!pattern || fnmatch(pattern, base(path), 0) == 0)) find_print(path, nul);
  if (type != 'd' || (max_depth >= 0 && depth >= max_depth)) return 0;
  DIR *d = opendir(path); if (!d) return errorf(path);
  struct dirent *e; int rc = 0;
  while ((e = readdir(d))) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    size_t n = strlen(path) + strlen(e->d_name) + 2; char *child = malloc(n); if (!child) { rc = 1; break; }
    snprintf(child, n, "%s/%s", path, e->d_name);
    if (find_walk(child, pattern, wanted, depth + 1, max_depth, nul)) rc = 1;
    free(child);
  }
  closedir(d); return rc;
}

static int cmd_find(int ac, char **av) {
  int i = 1; const char *paths[128]; int np = 0; while (i < ac && av[i][0] != '-') { if (np < 128) paths[np++] = av[i]; i++; }
  if (!np) paths[np++] = "."; const char *pattern = NULL; int wanted = 0, max_depth = -1, nul = 0;
  while (i < ac) {
    if (!strcmp(av[i], "-name") && i + 1 < ac) { pattern = av[i + 1]; i += 2; }
    else if (!strcmp(av[i], "-type") && i + 1 < ac) { wanted = av[i + 1][0]; i += 2; }
    else if (!strcmp(av[i], "-maxdepth") && i + 1 < ac) {
      char *end = NULL; long value = strtol(av[i + 1], &end, 10);
      if (*end || value < 0 || value > 128) { fprintf(stderr, "find: invalid -maxdepth: %s\n", av[i + 1]); return 2; }
      max_depth = (int)value; i += 2;
    }
    else if (!strcmp(av[i], "-print")) i++;
    else if (!strcmp(av[i], "-print0")) { nul = 1; i++; }
    else { fprintf(stderr, "find: unsupported expression: %s\n", av[i]); return 2; }
  }
  int rc = 0;
  for (i = 0; i < np; i++) if (find_walk(paths[i], pattern, wanted, 0, max_depth, nul)) rc = 1;
  return rc;
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
    else if (!strcmp(av[i], "--")) { i++; break; }
    else { fprintf(stderr, "install: unsupported option: %s\n", av[i]); return 2; }
  }
  if (directory) { int rc = 0; for (; i < ac; i++) if (mkdir_parents(av[i])) rc = 1; return rc; }
  if (ac - i < 2) return 1; int rc = 0; const char *dst = av[ac - 1];
  for (; i < ac - 1; i++) if (copy_path(av[i], dst, 0, 0)) rc = 1; return rc;
}

static int cmd_chmod(int ac, char **av) {
  if (ac < 3) { fprintf(stderr, "usage: chmod MODE FILE...\n"); return 1; }
  char *end = NULL; long parsed = strtol(av[1], &end, 8);
  if (!*av[1] || *end || parsed < 0 || parsed > 07777) {
    fprintf(stderr, "chmod: invalid mode: %s\n", av[1]); return 1;
  }
  mode_t mode = (mode_t)parsed;
  int rc = 0;
  for (int i = 2; i < ac; i++) {
    struct stat st;
    if (stat(av[i], &st) != 0) { fprintf(stderr, "chmod: %s: %s\n", av[i], strerror(errno)); rc = 1; continue; }
    if (chmod(av[i], mode) != 0) { fprintf(stderr, "chmod: %s: %s\n", av[i], strerror(errno)); rc = 1; }
  }
  return rc;
}

static int cmd_uniq(int ac, char **av) {
  FILE *in = stdin;
  int show_count = 0;
  int arg_start = 1;
  for (int i = 1; i < ac; i++) {
    if (!strcmp(av[i], "-c")) { show_count = 1; arg_start++; }
    else if (!strcmp(av[i], "--")) { arg_start = i + 1; break; }
    else { arg_start = i; break; }
  }
  if (ac - arg_start > 1) { fprintf(stderr, "uniq: only one input file is supported\n"); return 1; }
  if (arg_start < ac) { in = fopen(av[arg_start], "r"); if (!in) { fprintf(stderr, "uniq: %s: %s\n", av[arg_start], strerror(errno)); return 1; } }
  char prev[65536] = ""; int have_prev = 0, count = 0;
  char line[65536];
  while (fgets(line, sizeof line, in)) {
    size_t len = strlen(line);
    if (len == sizeof line - 1 && line[len - 1] != '\n') {
      fprintf(stderr, "uniq: input line exceeds 65534 bytes\n");
      if (in != stdin) fclose(in); return 1;
    }
    if (len > 0 && line[len-1] == '\n') line[--len] = 0;
    if (have_prev && !strcmp(line, prev)) { count++; continue; }
    if (have_prev) { if (show_count) printf("%7d %s\n", count, prev); else printf("%s\n", prev); }
    strcpy(prev, line); have_prev = 1; count = 1;
  }
  if (have_prev) { if (show_count) printf("%7d %s\n", count, prev); else printf("%s\n", prev); }
  if (in != stdin) fclose(in);
  return 0;
}

static int xargs_append(char *blob, size_t *used, const char *value) {
  size_t n = strlen(value) + 1;
  if (*used + n + 1 > XARGS_BLOB) return 0;
  memcpy(blob + *used, value, n); *used += n; return 1;
}

static int xargs_run(const char *cmd, char **fixed, int fixed_count,
                     char **items, int item_count) {
  static char blob[XARGS_BLOB], captured[COPY_BUF], environment[ENV_LIMIT];
  char path[4096];
  const char *cwd = getenv("PIODIDE_CWD");
  if (!cwd) cwd = getenv("PWD");
  if (!cwd) cwd = "/home/web";
  if (strchr(cmd, '/')) {
    if (*cmd == '/') snprintf(path, sizeof path, "%s", cmd);
    else snprintf(path, sizeof path, "%s/%s", cwd, cmd);
  } else if (!strcmp(cmd, "cc") || !strcmp(cmd, "ld") ||
             !strcmp(cmd, "compile") || !strcmp(cmd, "link")) {
    snprintf(path, sizeof path, "%s", cmd);
  } else {
    snprintf(path, sizeof path, "/bin/%s", cmd);
  }
  if (path[0] == '/') {
    struct stat status;
    if (stat(path, &status) != 0 || !S_ISREG(status.st_mode)) {
      fprintf(stderr, "xargs: command not found: %s\n", cmd); return 127;
    }
  }
  size_t used = 0;
  if (!xargs_append(blob, &used, path)) return 1;
  for (int i = 0; i < fixed_count; i++) if (!xargs_append(blob, &used, fixed[i])) return 1;
  for (int i = 0; i < item_count; i++) if (!xargs_append(blob, &used, items[i])) return 1;
  blob[used] = 0;
  size_t env_used = 0;
  for (char **entry = environ; entry && *entry; entry++) {
    size_t length = strlen(*entry) + 1;
    if (env_used + length + 1 > sizeof environment) {
      fprintf(stderr, "xargs: environment exceeds %d bytes\n", ENV_LIMIT); return 2;
    }
    memcpy(environment + env_used, *entry, length); env_used += length;
  }
  environment[env_used++] = 0;
  int captured_len = 0;
  slop_io io; memset(&io, 0, sizeof io);
  io.capture = captured; io.capture_cap = COPY_BUF; io.capture_len = &captured_len;
  io.env_data = environment; io.env_len = (int)env_used;
  int rc = piodide_spawn(path, blob, cwd, &io);
  int shown = captured_len > COPY_BUF ? COPY_BUF : captured_len;
  if (shown > 0) fwrite(captured, 1, (size_t)shown, stdout);
  if (captured_len > COPY_BUF) { fprintf(stderr, "xargs: command output exceeds %d bytes\n", COPY_BUF); return 1; }
  return rc;
}

static int cmd_xargs(int ac, char **av) {
  const char *cmd = "echo";
  int n_cmd_args = 0;
  int max_args = 0;
  int nul = 0, no_run_empty = 0;
  static char *cmd_args[XARGS_MAX];
  int i = 1;
  while (i < ac && av[i][0] == '-') {
    if (!strcmp(av[i], "-n") && i + 1 < ac) {
      max_args = atoi(av[i+1]);
      if (max_args <= 0) { fprintf(stderr, "xargs: -n requires a positive number\n"); return 1; }
      i += 2;
    }
    else if (!strcmp(av[i], "-0") || !strcmp(av[i], "--null")) { nul = 1; i++; }
    else if (!strcmp(av[i], "-r") || !strcmp(av[i], "--no-run-if-empty")) { no_run_empty = 1; i++; }
    else if (!strcmp(av[i], "--")) { i++; break; }
    else { fprintf(stderr, "xargs: unsupported option: %s\n", av[i]); return 1; }
  }
  if (i < ac) cmd = av[i++];
  for (; i < ac; i++) {
    if (n_cmd_args >= XARGS_MAX - 1) { fprintf(stderr, "xargs: too many command arguments\n"); return 1; }
    cmd_args[n_cmd_args++] = av[i];
  }

  /* Read all of stdin into a buffer */
  static char buf[COPY_BUF];
  size_t total = 0;
  char chunk[4096];
  size_t nrd;
  while ((nrd = fread(chunk, 1, sizeof chunk, stdin)) > 0) {
    if (total + nrd >= sizeof buf) { fprintf(stderr, "xargs: input exceeds %d bytes\n", COPY_BUF - 1); return 1; }
    memcpy(buf + total, chunk, nrd); total += nrd;
  }
  buf[total] = 0;

  char *p = buf, *end = buf + total;
  char *items[XARGS_MAX]; int batch_count = 0, ran = 0, rc = 0;
  int batch_limit = max_args > 0 ? max_args : XARGS_MAX - n_cmd_args - 1;
  if (batch_limit > XARGS_MAX - n_cmd_args - 1) batch_limit = XARGS_MAX - n_cmd_args - 1;
  if (batch_limit < 1) { fprintf(stderr, "xargs: too many fixed command arguments\n"); return 1; }
  while (p < end) {
    while (p < end && !nul && isspace((unsigned char)*p)) p++;
    if (p >= end) break;
    char *start = p;
    if (nul) while (p < end && *p) p++;
    else while (p < end && !isspace((unsigned char)*p)) p++;
    if (p < end) { *p = 0; p++; }
    items[batch_count++] = start;
    if (batch_count >= batch_limit) {
      int status = xargs_run(cmd, cmd_args, n_cmd_args, items, batch_count);
      if (status) rc = status;
      batch_count = 0; ran = 1;
    }
  }
  if (batch_count > 0 || (!ran && !no_run_empty)) {
    int status = xargs_run(cmd, cmd_args, n_cmd_args, items, batch_count);
    if (status) rc = status;
  }
  return rc;
}

static void print_help(const char *name) {
  if (!strcmp(name, "rm")) puts("usage: rm [-f] [-r|-R] [--] PATH...");
  else if (!strcmp(name, "cp")) puts("usage: cp [-a|-r|-R] [-f] [--] SOURCE... DEST");
  else if (!strcmp(name, "mv")) puts("usage: mv [-f|-n] [--] SOURCE DEST");
  else if (!strcmp(name, "mkdir")) puts("usage: mkdir [-p] [--] DIRECTORY...");
  else if (!strcmp(name, "rmdir")) puts("usage: rmdir [--] DIRECTORY...");
  else if (!strcmp(name, "touch")) puts("usage: touch [-c] [--] FILE...");
  else if (!strcmp(name, "ln")) puts("usage: ln [-s] [-f] [--] TARGET LINK");
  else if (!strcmp(name, "head")) puts("usage: head [-n LINES|-c BYTES] [FILE...]");
  else if (!strcmp(name, "tail")) puts("usage: tail [-n LINES] [FILE]  # +N starts at line N");
  else if (!strcmp(name, "wc")) puts("usage: wc [-lwc] [FILE]");
  else if (!strcmp(name, "sort")) puts("usage: sort [-rnu] [FILE]");
  else if (!strcmp(name, "cut")) puts("usage: cut -d DELIMITER -f FIELD [FILE]");
  else if (!strcmp(name, "tr")) puts("usage: tr [-d] [-s] SET1 [SET2]");
  else if (!strcmp(name, "tee")) puts("usage: tee [-a] [FILE...]");
  else if (!strcmp(name, "basename")) puts("usage: basename PATH [SUFFIX]");
  else if (!strcmp(name, "dirname")) puts("usage: dirname PATH");
  else if (!strcmp(name, "seq")) puts("usage: seq [FIRST [STEP]] LAST");
  else if (!strcmp(name, "cmp")) puts("usage: cmp FILE1 FILE2");
  else if (!strcmp(name, "install")) puts("usage: install [-d] [-m MODE] SOURCE... DEST");
  else if (!strcmp(name, "readlink")) puts("usage: readlink LINK");
  else if (!strcmp(name, "find")) puts("usage: find [PATH...] [-maxdepth N] [-name GLOB] [-type f|d|l] [-print|-print0]");
  else if (!strcmp(name, "mktemp")) puts("usage: mktemp [-d] [TEMPLATE.XXXXXX]");
  else if (!strcmp(name, "chmod")) puts("usage: chmod OCTAL_MODE FILE...");
  else if (!strcmp(name, "uniq")) puts("usage: uniq [-c] [FILE]");
  else if (!strcmp(name, "xargs")) puts("usage: xargs [-0r] [-n COUNT] [COMMAND [ARGS...]]");
  else puts("bounded Slop utility");
}

int main(int argc, char **argv) {
  prog = base(argv[0]);
  if (argc == 2 && !strcmp(argv[1], "--help")) { print_help(prog); return 0; }
  if (argc == 2 && !strcmp(argv[1], "--version")) { printf("%s 0.4-piodide\n", prog); return 0; }
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
  if (!strcmp(prog, "chmod")) return cmd_chmod(argc, argv);
  if (!strcmp(prog, "uniq")) return cmd_uniq(argc, argv);
  if (!strcmp(prog, "xargs")) return cmd_xargs(argc, argv);
  fprintf(stderr, "coreutils: unknown applet '%s'\n", prog); return 127;
}
