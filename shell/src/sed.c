/* A bounded, useful subset of sed: s///[gp], d, p, q and simple addresses. */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <regex.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_SCRIPTS 64
#define MAX_LINE 65536
#define MAX_OUT (1024 * 1024)

typedef struct { char *text; } Script;
static const char *prog = "sed";

static const char *scan_part(const char *p, char delim, char **out) {
  const char *start = p; size_t cap = strlen(p) + 1, n = 0; char *s = malloc(cap);
  if (!s) return NULL;
  while (*p && *p != delim) {
    if (*p == '\\' && p[1] == delim) { s[n++] = delim; p += 2; }
    else { s[n++] = *p++; }
  }
  (void)start; s[n] = 0; *out = s; return *p == delim ? p + 1 : NULL;
}

static int append(char *out, size_t *n, const char *s, size_t z) {
  if (*n + z + 1 > MAX_OUT) return 0; memcpy(out + *n, s, z); *n += z; out[*n] = 0; return 1;
}

static int substitute(char **linep, const char *cmd, int extended, int *print_extra) {
  char delim = *cmd++; if (!delim) return 0;
  char *pattern = NULL, *replacement = NULL;
  cmd = scan_part(cmd, delim, &pattern); if (!cmd) { free(pattern); return 0; }
  cmd = scan_part(cmd, delim, &replacement); if (!cmd) { free(pattern); free(replacement); return 0; }
  int global = strchr(cmd, 'g') != NULL; *print_extra = strchr(cmd, 'p') != NULL;
  regex_t re; int flags = REG_NEWLINE | (extended ? REG_EXTENDED : 0);
  int err = regcomp(&re, pattern, flags); free(pattern);
  if (err) { char msg[256]; regerror(err, &re, msg, sizeof msg); fprintf(stderr, "%s: %s\n", prog, msg); free(replacement); return -1; }
  char *line = *linep, *out = malloc(MAX_OUT); size_t used = 0, offset = 0; int changed = 0;
  if (!out) { regfree(&re); free(replacement); return -1; } out[0] = 0;
  regmatch_t m[10];
  while (regexec(&re, line + offset, 10, m, 0) == 0) {
    changed = 1;
    if (!append(out, &used, line + offset, (size_t)m[0].rm_so)) goto large;
    for (const char *r = replacement; *r; r++) {
      if (*r == '&') {
        if (!append(out, &used, line + offset + m[0].rm_so, (size_t)(m[0].rm_eo - m[0].rm_so))) goto large;
      } else if (*r == '\\' && isdigit((unsigned char)r[1])) {
        int k = *++r - '0'; if (m[k].rm_so >= 0 && !append(out, &used, line + offset + m[k].rm_so, (size_t)(m[k].rm_eo - m[k].rm_so))) goto large;
      } else if (*r == '\\' && r[1]) { r++; if (!append(out, &used, r, 1)) goto large; }
      else if (!append(out, &used, r, 1)) goto large;
    }
    size_t advance = (size_t)m[0].rm_eo;
    if (!global) { offset += advance; break; }
    if (advance == 0) {
      if (!line[offset]) break;
      if (!append(out, &used, line + offset, 1)) goto large;
      offset++;
    } else offset += advance;
  }
  if (!append(out, &used, line + offset, strlen(line + offset))) goto large;
  regfree(&re); free(replacement);
  if (changed) { free(*linep); *linep = out; } else free(out);
  return changed;
large:
  fprintf(stderr, "%s: output line too large\n", prog); regfree(&re); free(replacement); free(out); return -1;
}

static int address_matches(const char **cmdp, const char *line, long lineno, int extended) {
  const char *p = *cmdp;
  if (isdigit((unsigned char)*p)) {
    long first = strtol(p, (char **)&p, 10), last = first;
    if (*p == ',' && isdigit((unsigned char)p[1])) {
      p++; last = strtol(p, (char **)&p, 10);
    }
    *cmdp = p; return lineno >= first && lineno <= last;
  }
  if (*p == '$') { p++; *cmdp = p; return 0; } /* final-line address is intentionally unsupported */
  if (*p == '/') {
    char *pat = NULL; p = scan_part(p + 1, '/', &pat); if (!p) { free(pat); return 0; }
    regex_t re; int flags = REG_NEWLINE | (extended ? REG_EXTENDED : 0);
    int ok = regcomp(&re, pat, flags) == 0 && regexec(&re, line, 0, NULL, 0) == 0;
    regfree(&re); free(pat); *cmdp = p; return ok;
  }
  return 1;
}

static int apply_script(char **line, const char *script, long lineno, int extended, FILE *output,
                        int *deleted, int *quit, int *printed) {
  char *copy = strdup(script); if (!copy) return 1;
  for (char *cmd = strtok(copy, ";"); cmd; cmd = strtok(NULL, ";")) {
    while (isspace((unsigned char)*cmd)) cmd++;
    const char *p = cmd; int address = address_matches(&p, *line, lineno, extended);
    if (*p == '!') { address = !address; p++; }
    while (isspace((unsigned char)*p)) p++;
    if (!address || !*p) continue;
    if (*p == 's') {
      int extra = 0, rc = substitute(line, p + 1, extended, &extra); if (rc < 0) { free(copy); return 1; }
      if (rc && extra) { fputs(*line, output); *printed = 1; }
    } else if (*p == 'd') { *deleted = 1; break; }
    else if (*p == 'p') { fputs(*line, output); *printed = 1; }
    else if (*p == 'q') { *quit = 1; break; }
    else { fprintf(stderr, "%s: unsupported command: %s\n", prog, p); free(copy); return 1; }
  }
  free(copy); return 0;
}

static int preflight_in_place_inputs(int argc, char **argv, int first) {
  for (int index = first; index < argc; index++) {
    const char *name = argv[index];
    if (!strcmp(name, "-")) {
      fprintf(stderr, "sed: -i cannot edit standard input\n"); return 0;
    }
    FILE *input = fopen(name, "r");
    if (!input) {
      fprintf(stderr, "sed: %s: cannot open\n", name); return 0;
    }
    struct stat status;
    int inspect_failed = fstat(fileno(input), &status) || !S_ISREG(status.st_mode);
    fclose(input);
    if (inspect_failed) {
      fprintf(stderr, "sed: %s: cannot inspect for in-place edit\n", name); return 0;
    }
  }
  return 1;
}

int main(int argc, char **argv) {
  if (argc == 2 && (!strcmp(argv[1], "--help") || !strcmp(argv[1], "-h"))) {
    puts("usage: sed [-n] [-E|-r] [-i[SUFFIX]] [-e SCRIPT] [SCRIPT] [--] [FILE...]\n"
         "commands: s/ERE/replacement/[gp], p, d, q; numeric and /ERE/ addresses\n"
         "in-place: every explicit regular input is validated before temporary files or writes");
    return 0;
  }
  if (argc == 2 && !strcmp(argv[1], "--version")) { puts("sed 0.4-piodide"); return 0; }
  Script scripts[MAX_SCRIPTS]; int ns = 0, quiet = 0, extended = 0, in_place = 0, i = 1;
  const char *backup_suffix = NULL;
  while (i < argc && argv[i][0] == '-') {
    if (!strcmp(argv[i], "--")) { i++; break; }
    if (!strcmp(argv[i], "-n")) { quiet = 1; i++; }
    else if (!strcmp(argv[i], "-E") || !strcmp(argv[i], "-r")) { extended = 1; i++; }
    else if (argv[i][0] == '-' && argv[i][1] &&
             strspn(argv[i] + 1, "nEr") == strlen(argv[i] + 1)) {
      for (const char *flag = argv[i] + 1; *flag; flag++) {
        if (*flag == 'n') quiet = 1;
        else extended = 1;
      }
      i++;
    }
    else if (!strcmp(argv[i], "-i")) { in_place = 1; backup_suffix = ""; i++; }
    else if (!strncmp(argv[i], "-i", 2)) { in_place = 1; backup_suffix = argv[i] + 2; i++; }
    else if (!strcmp(argv[i], "-e") && i + 1 < argc) { scripts[ns++].text = argv[i + 1]; i += 2; }
    else if (!strncmp(argv[i], "-e", 2)) { scripts[ns++].text = argv[i] + 2; i++; }
    else { fprintf(stderr, "sed: unsupported option: %s\n", argv[i]); return 2; }
    if (ns >= MAX_SCRIPTS) { fprintf(stderr, "sed: too many scripts\n"); return 2; }
  }
  if (!ns) { if (i >= argc) { fprintf(stderr, "sed: script required\n"); return 2; } scripts[ns++].text = argv[i++]; }
  if (i < argc && !strcmp(argv[i], "--")) i++;
  if (in_place && i >= argc) { fprintf(stderr, "sed: -i requires at least one file\n"); return 2; }
  if (in_place && !preflight_in_place_inputs(argc, argv, i)) return 2;
  int rc = 0, quit = 0; long lineno = 0;
  do {
    const char *name = i < argc ? argv[i++] : "-"; FILE *f = !strcmp(name, "-") ? stdin : fopen(name, "r");
    if (!f) { fprintf(stderr, "sed: %s: cannot open\n", name); rc = 2; continue; }
    if (in_place && f == stdin) { fprintf(stderr, "sed: -i cannot edit standard input\n"); return 2; }
    FILE *output = stdout; char *temporary = NULL; struct stat original;
    if (in_place) {
      size_t size = strlen(name) + 40;
      temporary = malloc(size);
      if (!temporary || stat(name, &original)) {
        fprintf(stderr, "sed: %s: cannot inspect for in-place edit\n", name);
        free(temporary); fclose(f); rc = 2; continue;
      }
      int descriptor = -1;
      for (int attempt = 1; attempt <= 1000; attempt++) {
        snprintf(temporary, size, "%s.piodide-sed-%d.tmp", name, attempt);
        descriptor = open(temporary, O_WRONLY | O_CREAT | O_EXCL, original.st_mode & 07777);
        if (descriptor >= 0 || errno != EEXIST) break;
      }
      if (descriptor < 0 || !(output = fdopen(descriptor, "w"))) {
        fprintf(stderr, "sed: %s: cannot create temporary file\n", name);
        if (descriptor >= 0) close(descriptor);
        free(temporary); fclose(f); rc = 2; continue;
      }
    }
    char raw[MAX_LINE];
    while (!quit && fgets(raw, sizeof raw, f)) {
      lineno++; char *line = strdup(raw); if (!line) { rc = 2; break; }
      int deleted = 0, printed = 0;
      for (int s = 0; s < ns && !deleted && !quit; s++)
        if (apply_script(&line, scripts[s].text, lineno, extended, output, &deleted, &quit, &printed)) { rc = 1; quit = 1; }
      if (!quiet && !deleted) fputs(line, output);
      free(line); (void)printed;
    }
    if (ferror(f)) { fprintf(stderr, "sed: %s: read error\n", name); rc = 2; }
    if (f != stdin) fclose(f);
    if (in_place) {
      int write_failed = fflush(output) || ferror(output);
      if (fclose(output)) write_failed = 1;
      if (write_failed) { fprintf(stderr, "sed: %s: write error\n", name); rc = 2; }
      if (rc) unlink(temporary);
      else if (backup_suffix && *backup_suffix) {
        size_t size = strlen(name) + strlen(backup_suffix) + 1;
        char *backup = malloc(size);
        if (!backup) { unlink(temporary); rc = 2; }
        else {
          snprintf(backup, size, "%s%s", name, backup_suffix);
          unlink(backup);
          if (rename(name, backup) || rename(temporary, name)) {
            fprintf(stderr, "sed: %s: cannot replace file\n", name);
            if (access(name, F_OK) != 0) rename(backup, name);
            unlink(temporary); rc = 2;
          }
          free(backup);
        }
      } else if (rename(temporary, name)) {
        fprintf(stderr, "sed: %s: cannot replace file\n", name); unlink(temporary); rc = 2;
      }
      free(temporary);
    }
  } while (i < argc && !quit);
  return rc;
}
