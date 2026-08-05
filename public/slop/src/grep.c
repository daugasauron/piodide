/* Bounded grep/rg search for Slop. rg defaults to recursive ERE search. */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fnmatch.h>
#include <regex.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define MAX_DEPTH 128
#define MAX_GLOBS 32
#define MAX_FILES 100000
#define MAX_LINE (1024 * 1024)

static int icase, invert, numbers, count_only, files_only, fixed, recursive, quiet;
static int list_files, show_hidden, force_filename;
static int selected_any, errors, visited;
static const char *pattern;
static const char *globs[MAX_GLOBS];
static int nglobs;
static regex_t expression;
static int expression_ready;

static const char *base(const char *path) {
  const char *slash = strrchr(path, '/');
  return slash ? slash + 1 : path;
}

static int equal_ci(unsigned char a, unsigned char b) {
  return tolower(a) == tolower(b);
}

static int fixed_match(const char *line) {
  size_t length = strlen(pattern);
  if (!length) return 1;
  for (const char *cursor = line; *cursor; cursor++) {
    size_t index = 0;
    while (index < length && cursor[index] &&
           (icase ? equal_ci((unsigned char)cursor[index], (unsigned char)pattern[index])
                  : cursor[index] == pattern[index])) index++;
    if (index == length) return 1;
  }
  return 0;
}

static int line_matches(const char *line) {
  int matched = fixed ? fixed_match(line) : regexec(&expression, line, 0, NULL, 0) == 0;
  return invert ? !matched : matched;
}

static int glob_allows(const char *path) {
  int included = 0, has_include = 0;
  for (int index = 0; index < nglobs; index++) {
    const char *value = globs[index];
    int exclude = value[0] == '!';
    if (exclude) value++;
    else has_include = 1;
    if (fnmatch(value, path, 0) == 0 || fnmatch(value, base(path), 0) == 0) {
      if (exclude) return 0;
      included = 1;
    }
  }
  return !has_include || included;
}

static int hidden_name(const char *name) {
  return name[0] == '.' && strcmp(name, ".") && strcmp(name, "..");
}

static int search_file(const char *path, int show_name) {
  if (!glob_allows(path)) return 0;
  FILE *file = !strcmp(path, "-") ? stdin : fopen(path, "rb");
  if (!file) {
    fprintf(stderr, "grep: %s: %s\n", path, strerror(errno));
    errors = 1;
    return 0;
  }
  char *line = NULL;
  size_t capacity = 0;
  ssize_t length;
  long lineno = 0, count = 0;
  int matched_file = 0;
  while ((length = getline(&line, &capacity, file)) >= 0) {
    lineno++;
    if ((size_t)length > MAX_LINE) {
      fprintf(stderr, "grep: %s:%ld: line exceeds %d bytes\n", path, lineno, MAX_LINE);
      errors = 1;
      break;
    }
    if (memchr(line, 0, (size_t)length)) continue;
    if (!line_matches(line)) continue;
    matched_file = selected_any = 1;
    count++;
    if (quiet) break;
    if (files_only) break;
    if (count_only) continue;
    if (show_name) printf("%s:", path);
    if (numbers) printf("%ld:", lineno);
    fwrite(line, 1, (size_t)length, stdout);
    if (!length || line[length - 1] != '\n') putchar('\n');
  }
  if (ferror(file)) {
    fprintf(stderr, "grep: %s: %s\n", path, strerror(errno));
    errors = 1;
  }
  if (files_only && matched_file) puts(path);
  if (count_only) {
    if (show_name) printf("%s:", path);
    printf("%ld\n", count);
  }
  free(line);
  if (file != stdin) fclose(file);
  return matched_file;
}

static void walk(const char *path, int depth, int show_name) {
  if (depth > MAX_DEPTH) {
    fprintf(stderr, "grep: %s: traversal depth limit reached\n", path);
    errors = 1;
    return;
  }
  if (++visited > MAX_FILES) {
    if (visited == MAX_FILES + 1) fprintf(stderr, "grep: file limit reached (%d)\n", MAX_FILES);
    errors = 1;
    return;
  }
  struct stat status;
  if (lstat(path, &status)) {
    fprintf(stderr, "grep: %s: %s\n", path, strerror(errno));
    errors = 1;
    return;
  }
  if (!S_ISDIR(status.st_mode)) {
    if (list_files) {
      if (glob_allows(path)) puts(path);
    } else search_file(path, show_name);
    return;
  }
  DIR *directory = opendir(path);
  if (!directory) {
    fprintf(stderr, "grep: %s: %s\n", path, strerror(errno));
    errors = 1;
    return;
  }
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (quiet && selected_any) break;
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..") ||
        !strcmp(entry->d_name, ".git")) continue;
    if (!show_hidden && hidden_name(entry->d_name)) continue;
    size_t size = strlen(path) + strlen(entry->d_name) + 2;
    char *child = malloc(size);
    if (!child) { errors = 1; break; }
    snprintf(child, size, "%s/%s", path, entry->d_name);
    walk(child, depth + 1, 1);
    free(child);
    if (visited > MAX_FILES) break;
  }
  closedir(directory);
}

static void usage(const char *program) {
  if (!strcmp(program, "rg")) {
    puts("usage: rg [options] PATTERN [PATH...]\n"
         "       rg --files [PATH...]\n"
         "options: -n -i -v -c -l -q -F -e PATTERN -g GLOB --hidden");
  } else {
    puts("usage: grep [options] PATTERN [FILE...]\n"
         "options: -n -i -v -c -l -q -F -E -R/-r -e PATTERN");
  }
}

int main(int argc, char **argv) {
  const char *program = base(argv[0]);
  int rg_mode = !strcmp(program, "rg");
  recursive = rg_mode;
  numbers = rg_mode;
  show_hidden = !rg_mode;
  int index = 1, options = 1;
  const char *explicit_pattern = NULL;
  for (; index < argc; index++) {
    const char *argument = argv[index];
    if (options && !strcmp(argument, "--")) { options = 0; continue; }
    if (!options || argument[0] != '-' || !argument[1]) break;
    if (!strcmp(argument, "--help") || !strcmp(argument, "-h")) { usage(program); return 0; }
    if (!strcmp(argument, "--version") || !strcmp(argument, "-V")) {
      printf("%s 0.4-piodide\n", program); return 0;
    }
    if (!strcmp(argument, "--files")) { list_files = recursive = 1; continue; }
    if (!strcmp(argument, "--hidden")) { show_hidden = 1; continue; }
    if (!strcmp(argument, "--no-ignore") || !strcmp(argument, "--color=never")) continue;
    if (!strcmp(argument, "--fixed-strings")) { fixed = 1; continue; }
    if (!strcmp(argument, "--line-number")) { numbers = 1; continue; }
    if (!strcmp(argument, "--ignore-case")) { icase = 1; continue; }
    if (!strcmp(argument, "--invert-match")) { invert = 1; continue; }
    if (!strcmp(argument, "--count")) { count_only = 1; continue; }
    if (!strcmp(argument, "--files-with-matches")) { files_only = 1; continue; }
    if (!strcmp(argument, "--quiet") || !strcmp(argument, "--silent")) { quiet = 1; continue; }
    if (!strcmp(argument, "-e") || !strcmp(argument, "--regexp")) {
      if (++index >= argc) { fprintf(stderr, "grep: %s requires a pattern\n", argument); return 2; }
      explicit_pattern = argv[index];
      continue;
    }
    if (!strcmp(argument, "-g") || !strcmp(argument, "--glob")) {
      if (++index >= argc || nglobs >= MAX_GLOBS) { fprintf(stderr, "grep: -g requires a glob (maximum %d)\n", MAX_GLOBS); return 2; }
      globs[nglobs++] = argv[index];
      continue;
    }
    if (!strncmp(argument, "--glob=", 7)) {
      if (nglobs >= MAX_GLOBS) { fprintf(stderr, "grep: too many globs\n"); return 2; }
      globs[nglobs++] = argument + 7;
      continue;
    }
    for (const char *flag = argument + 1; *flag; flag++) {
      if (*flag == 'i') icase = 1;
      else if (*flag == 'v') invert = 1;
      else if (*flag == 'n') numbers = 1;
      else if (*flag == 'c') count_only = 1;
      else if (*flag == 'l') files_only = 1;
      else if (*flag == 'q') quiet = 1;
      else if (*flag == 'F') fixed = 1;
      else if (*flag == 'E') { }
      else if (*flag == 'R' || *flag == 'r') recursive = 1;
      else if (*flag == 'H') force_filename = 1;
      else if (*flag == 'I') { }
      else { fprintf(stderr, "grep: unknown option -%c\n", *flag); return 2; }
    }
  }

  if (!list_files) {
    pattern = explicit_pattern;
    if (!pattern) {
      if (index >= argc) { usage(program); return 2; }
      pattern = argv[index++];
    }
    if (!fixed) {
      int flags = REG_EXTENDED | REG_NEWLINE | (icase ? REG_ICASE : 0);
      int status = regcomp(&expression, pattern, flags);
      if (status) {
        char message[256];
        regerror(status, &expression, message, sizeof message);
        fprintf(stderr, "grep: %s\n", message);
        return 2;
      }
      expression_ready = 1;
    }
  }

  int operands = argc - index;
  if (!operands && !recursive) {
    search_file("-", 0);
  } else {
    if (!operands) {
      walk(".", 0, 1);
    } else {
      for (; index < argc; index++) {
        if (quiet && selected_any) break;
        struct stat status;
        if (!strcmp(argv[index], "-")) {
          search_file("-", force_filename || operands > 1);
        } else if (!lstat(argv[index], &status) && S_ISDIR(status.st_mode)) {
          if (!recursive) {
            fprintf(stderr, "grep: %s: is a directory\n", argv[index]);
            errors = 1;
          } else walk(argv[index], 0, 1);
        } else {
          search_file(argv[index], force_filename || operands > 1);
        }
      }
    }
  }
  if (expression_ready) regfree(&expression);
  if (errors) return 2;
  return list_files || selected_any ? 0 : 1;
}
