/* A bounded, useful subset of sed: s///[gp], d, p, q and simple addresses. */
#define _GNU_SOURCE
#include <ctype.h>
#include <regex.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
    long n = strtol(p, (char **)&p, 10); *cmdp = p; return lineno == n;
  }
  if (*p == '$') { p++; *cmdp = p; return 0; } /* final-line address is intentionally unsupported */
  if (*p == '/') {
    char *pat = NULL; p = scan_part(p + 1, '/', &pat); if (!p) { free(pat); return 0; }
    regex_t re; int ok = regcomp(&re, pat, extended ? REG_EXTENDED : 0) == 0 && regexec(&re, line, 0, NULL, 0) == 0;
    regfree(&re); free(pat); *cmdp = p; return ok;
  }
  return 1;
}

static int apply_script(char **line, const char *script, long lineno, int extended,
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
      if (rc && extra) { fputs(*line, stdout); *printed = 1; }
    } else if (*p == 'd') { *deleted = 1; break; }
    else if (*p == 'p') { fputs(*line, stdout); *printed = 1; }
    else if (*p == 'q') { *quit = 1; break; }
    else { fprintf(stderr, "%s: unsupported command: %s\n", prog, p); free(copy); return 1; }
  }
  free(copy); return 0;
}

int main(int argc, char **argv) {
  Script scripts[MAX_SCRIPTS]; int ns = 0, quiet = 0, extended = 0, i = 1;
  while (i < argc && argv[i][0] == '-') {
    if (!strcmp(argv[i], "-n")) { quiet = 1; i++; }
    else if (!strcmp(argv[i], "-E") || !strcmp(argv[i], "-r")) { extended = 1; i++; }
    else if (!strcmp(argv[i], "-e") && i + 1 < argc) { scripts[ns++].text = argv[i + 1]; i += 2; }
    else if (!strncmp(argv[i], "-e", 2)) { scripts[ns++].text = argv[i] + 2; i++; }
    else break;
    if (ns >= MAX_SCRIPTS) { fprintf(stderr, "sed: too many scripts\n"); return 2; }
  }
  if (!ns) { if (i >= argc) { fprintf(stderr, "sed: script required\n"); return 2; } scripts[ns++].text = argv[i++]; }
  int rc = 0, quit = 0; long lineno = 0;
  do {
    const char *name = i < argc ? argv[i++] : "-"; FILE *f = !strcmp(name, "-") ? stdin : fopen(name, "r");
    if (!f) { fprintf(stderr, "sed: %s: cannot open\n", name); rc = 2; continue; }
    char raw[MAX_LINE];
    while (!quit && fgets(raw, sizeof raw, f)) {
      lineno++; char *line = strdup(raw); if (!line) { rc = 2; break; }
      int deleted = 0, printed = 0;
      for (int s = 0; s < ns && !deleted && !quit; s++)
        if (apply_script(&line, scripts[s].text, lineno, extended, &deleted, &quit, &printed)) { rc = 1; quit = 1; }
      if (!quiet && !deleted) fputs(line, stdout);
      free(line); (void)printed;
    }
    if (f != stdin) fclose(f);
  } while (i < argc && !quit);
  return rc;
}
