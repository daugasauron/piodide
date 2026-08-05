/* Small BSD/GNU ar-compatible archive writer for WASI object libraries. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#define LIMIT (128 * 1024 * 1024)
#define MEMBERS 4096

typedef struct { char *name; unsigned char *data; size_t size; unsigned mode; } Member;
static Member members[MEMBERS]; static int nmem;
static const char *base(const char *p) { const char *s = strrchr(p, '/'); return s ? s + 1 : p; }
static void trim_field(char *s) { size_t n = strlen(s); while (n && s[n-1] == ' ') s[--n] = 0; if (n && s[n-1] == '/') s[--n] = 0; }

static int add_member(const char *name, unsigned char *data, size_t size, unsigned mode) {
  if (nmem >= MEMBERS) return 0; members[nmem].name = strdup(name); members[nmem].data = data;
  members[nmem].size = size; members[nmem].mode = mode; return members[nmem++].name != NULL;
}

static int load_archive(const char *path) {
  FILE *f = fopen(path, "rb"); if (!f) return errno == ENOENT;
  char magic[8]; if (fread(magic, 1, 8, f) != 8 || memcmp(magic, "!<arch>\n", 8)) { fclose(f); return 0; }
  size_t total = 0;
  for (;;) {
    char h[61]; size_t got = fread(h, 1, 60, f); if (!got) break;
    if (got != 60 || h[58] != '`' || h[59] != '\n') { fclose(f); return 0; }
    h[60] = 0; char sf[11]; memcpy(sf, h + 48, 10); sf[10] = 0; size_t stored = (size_t)strtoul(sf, NULL, 10);
    char nf[17]; memcpy(nf, h, 16); nf[16] = 0; trim_field(nf);
    char mf[9]; memcpy(mf, h + 40, 8); mf[8] = 0; unsigned mode = (unsigned)strtoul(mf, NULL, 8);
    unsigned char *data = malloc(stored ? stored : 1); if (!data || fread(data, 1, stored, f) != stored) { free(data); fclose(f); return 0; }
    char *name = nf; size_t size = stored;
    if (!strncmp(nf, "#1/", 3)) {
      size_t nl = (size_t)strtoul(nf + 3, NULL, 10); if (nl > stored) { free(data); fclose(f); return 0; }
      name = malloc(nl + 1); if (!name) { free(data); fclose(f); return 0; }
      memcpy(name, data, nl); name[nl] = 0; memmove(data, data + nl, stored - nl); size = stored - nl;
    }
    if (strcmp(name, "/") && strcmp(name, "//") && name[0] != '/') {
      if (total + size > LIMIT || !add_member(name, data, size, mode)) { if (name != nf) free(name); free(data); fclose(f); return 0; }
      total += size;
    } else free(data);
    if (name != nf) free(name);
    if (stored & 1) fgetc(f);
  }
  fclose(f); return 1;
}

static int load_file(const char *path) {
  FILE *f = fopen(path, "rb"); if (!f) { fprintf(stderr, "ar: %s: %s\n", path, strerror(errno)); return 0; }
  struct stat st; if (stat(path, &st) || st.st_size < 0 || st.st_size > LIMIT) { fclose(f); return 0; }
  size_t n = (size_t)st.st_size; unsigned char *data = malloc(n ? n : 1);
  if (!data || fread(data, 1, n, f) != n) { free(data); fclose(f); return 0; }
  fclose(f); return add_member(base(path), data, n, (unsigned)st.st_mode);
}

static void drop_name(const char *name) {
  for (int i = 0; i < nmem;) {
    if (!strcmp(members[i].name, base(name))) {
      free(members[i].name); free(members[i].data); memmove(&members[i], &members[i+1], (size_t)(nmem-i-1) * sizeof members[0]); nmem--;
    } else i++;
  }
}

static int write_archive(const char *path) {
  FILE *f = fopen(path, "wb"); if (!f) { fprintf(stderr, "ar: %s: %s\n", path, strerror(errno)); return 0; }
  fwrite("!<arch>\n", 1, 8, f);
  for (int i = 0; i < nmem; i++) {
    Member *m = &members[i]; size_t nl = strlen(m->name); int extended = nl > 15 || strchr(m->name, ' ');
    char namefield[32]; if (extended) snprintf(namefield, sizeof namefield, "#1/%zu", nl); else snprintf(namefield, sizeof namefield, "%s/", m->name);
    size_t stored = m->size + (extended ? nl : 0); char h[61];
    int z = snprintf(h, sizeof h, "%-16s%-12ld%-6d%-6d%-8o%-10zu`\n", namefield, (long)time(NULL), 0, 0, m->mode ? m->mode : 0100644, stored);
    if (z != 60) { fclose(f); return 0; }
    fwrite(h, 1, 60, f); if (extended) fwrite(m->name, 1, nl, f); fwrite(m->data, 1, m->size, f);
    if (stored & 1) fputc('\n', f);
  }
  return fclose(f) == 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && (!strcmp(argv[1], "--help") || !strcmp(argv[1], "-h"))) {
    puts("usage: ar rcs ARCHIVE [MEMBERS...] | ar t ARCHIVE | ar x ARCHIVE | ar d ARCHIVE MEMBERS...");
    return 0;
  }
  if (argc == 2 && !strcmp(argv[1], "--version")) { puts("ar 0.4-piodide"); return 0; }
  if (argc < 3) { fprintf(stderr, "usage: ar rcs archive [members...] | ar t archive | ar x archive\n"); return 2; }
  const char *flags = argv[1]; while (*flags == '-') flags++;
  char op = strchr(flags, 't') ? 't' : strchr(flags, 'x') ? 'x' : strchr(flags, 'd') ? 'd' : 'r';
  const char *archive = argv[2];
  if (!load_archive(archive) && op != 'r') { fprintf(stderr, "ar: invalid archive: %s\n", archive); return 1; }
  if (op == 't') { for (int i = 0; i < nmem; i++) puts(members[i].name); return 0; }
  if (op == 'x') {
    int rc = 0; for (int i = 0; i < nmem; i++) { FILE *f = fopen(base(members[i].name), "wb"); if (!f || fwrite(members[i].data, 1, members[i].size, f) != members[i].size) rc = 1; if (f) fclose(f); } return rc;
  }
  if (op == 'd') { for (int i = 3; i < argc; i++) drop_name(argv[i]); return write_archive(archive) ? 0 : 1; }
  for (int i = 3; i < argc; i++) { drop_name(argv[i]); if (!load_file(argv[i])) return 1; }
  return write_archive(archive) ? 0 : 1;
}
