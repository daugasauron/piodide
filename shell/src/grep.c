/* Bounded grep/rg search for Slop. rg defaults to recursive ERE search. */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fnmatch.h>
#include <limits.h>
#include <regex.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define MAX_DEPTH 128
#define MAX_GLOBS 32
#define MAX_FILES 100000
#define MAX_EXPLICIT_FILES 100
#define MAX_PATTERNS 64
#define MAX_PATTERN_BYTES 65536
#define MAX_LINE (1024 * 1024)
#define MAX_LINE_INPUT (16 * 1024 * 1024)
#define MAX_LINE_RECORDS 100000
#define MAX_LINE_OUTPUT 1000000
#define MAX_NULL_INPUT (16 * 1024 * 1024)
#define MAX_NULL_RECORDS 100000
#define MAX_NULL_OUTPUT (16 * 1024 * 1024)
#define MAX_NULL_OUTPUT_RECORDS 100000
#define MAX_PATH_BYTES 4096
#define MAX_PATH_OUTPUT (1024 * 1024)

static int icase, invert, numbers, count_only, files_only, files_without, fixed, recursive, quiet;
static int list_files, show_hidden, force_filename, null_data, numbers_explicit, null_paths;
static int selected_any, reported_any, errors, visited;
static long max_count = LONG_MAX;
static const char *program_name;
static const char *patterns[MAX_PATTERNS];
static int pattern_count;
static size_t pattern_bytes;
static const char *globs[MAX_GLOBS];
static int nglobs;
static regex_t expressions[MAX_PATTERNS];
static unsigned char expression_ready[MAX_PATTERNS];
static unsigned char literal_regex[MAX_PATTERNS];
static unsigned char *line_output;
static size_t line_output_length, line_output_capacity;
static size_t line_input_bytes, line_record_count;
static unsigned char *null_output;
static size_t null_output_length, null_output_capacity;
static size_t null_input_bytes, null_record_count, null_output_records;
static unsigned char *path_output;
static size_t path_output_length, path_output_capacity, path_output_records;

static const char *base(const char *path) {
  const char *slash = strrchr(path, '/');
  return slash ? slash + 1 : path;
}

static int equal_ci(unsigned char a, unsigned char b) {
  return tolower(a) == tolower(b);
}

static int fixed_match(const char *line, const char *candidate) {
  size_t length = strlen(candidate);
  if (!length) return 1;
  for (const char *cursor = line; *cursor; cursor++) {
    size_t index = 0;
    while (index < length && cursor[index] &&
           (icase ? equal_ci((unsigned char)cursor[index], (unsigned char)candidate[index])
                  : cursor[index] == candidate[index])) index++;
    if (index == length) return 1;
  }
  return 0;
}

static int line_matches(const char *line) {
  int matched = 0;
  for (int index = 0; index < pattern_count && !matched; index++) {
    matched = fixed || literal_regex[index]
      ? fixed_match(line, patterns[index])
      : regexec(&expressions[index], line, 0, NULL, 0) == 0;
  }
  return invert ? !matched : matched;
}

static int add_pattern(const char *value) {
  if (pattern_count >= MAX_PATTERNS) {
    fprintf(stderr, "%s: too many patterns\n", program_name);
    return 0;
  }
  size_t length = strlen(value);
  if (length > MAX_PATTERN_BYTES - pattern_bytes) {
    fprintf(stderr, "%s: patterns exceed %d bytes\n", program_name, MAX_PATTERN_BYTES);
    return 0;
  }
  patterns[pattern_count++] = value;
  pattern_bytes += length;
  return 1;
}

static void free_expressions(void) {
  for (int index = 0; index < pattern_count; index++) {
    if (expression_ready[index]) regfree(&expressions[index]);
    expression_ready[index] = 0;
  }
}

static int regex_is_literal(const char *value) {
  return !strpbrk(value, ".[\\*^$()|+?{}]");
}

static int compile_patterns(void) {
  int flags = REG_EXTENDED | (null_data ? 0 : REG_NEWLINE) | (icase ? REG_ICASE : 0);
  for (int index = 0; index < pattern_count; index++) {
    if (regex_is_literal(patterns[index])) {
      literal_regex[index] = 1;
      continue;
    }
    int status = regcomp(&expressions[index], patterns[index], flags);
    if (status) {
      char message[256];
      regerror(status, &expressions[index], message, sizeof message);
      fprintf(stderr, "%s: %s\n", program_name, message);
      free_expressions();
      return 0;
    }
    expression_ready[index] = 1;
  }
  return 1;
}

static int reserve_line_output(size_t extra) {
  if (extra > MAX_LINE_OUTPUT - line_output_length) {
    if (!errors) fprintf(stderr, "%s: output limit exceeded\n", program_name);
    errors = 1;
    return 0;
  }
  size_t needed = line_output_length + extra;
  if (needed <= line_output_capacity) return 1;
  size_t capacity = line_output_capacity ? line_output_capacity : 4096;
  while (capacity < needed) {
    size_t next = capacity > MAX_LINE_OUTPUT / 2 ? MAX_LINE_OUTPUT : capacity * 2;
    if (next <= capacity) { capacity = needed; break; }
    capacity = next;
  }
  unsigned char *grown = realloc(line_output, capacity);
  if (!grown) {
    if (!errors) fprintf(stderr, "%s: output allocation failed\n", program_name);
    errors = 1;
    return 0;
  }
  line_output = grown;
  line_output_capacity = capacity;
  return 1;
}

static int append_line_bytes(const void *bytes, size_t length) {
  if (!reserve_line_output(length)) return 0;
  if (length) memcpy(line_output + line_output_length, bytes, length);
  line_output_length += length;
  return 1;
}

static int append_line_text(const char *text) {
  return append_line_bytes(text, strlen(text));
}

static int append_path_name(const char *path) {
  size_t length = strlen(path);
  if (length > MAX_PATH_BYTES) {
    if (!errors) fprintf(stderr, "%s: pathname exceeds %d bytes\n", program_name, MAX_PATH_BYTES);
    errors = 1;
    return 0;
  }
  if (path_output_records >= MAX_FILES) {
    if (!errors) fprintf(stderr, "%s: pathname count exceeds %d\n", program_name, MAX_FILES);
    errors = 1;
    return 0;
  }
  if (length + 1 > MAX_PATH_OUTPUT - path_output_length) {
    if (!errors) fprintf(stderr, "%s: pathname output exceeds %d bytes\n", program_name, MAX_PATH_OUTPUT);
    errors = 1;
    return 0;
  }
  size_t needed = path_output_length + length + 1;
  if (needed > path_output_capacity) {
    size_t capacity = path_output_capacity ? path_output_capacity : 4096;
    while (capacity < needed) {
      size_t next = capacity > MAX_PATH_OUTPUT / 2 ? MAX_PATH_OUTPUT : capacity * 2;
      if (next <= capacity) { capacity = needed; break; }
      capacity = next;
    }
    unsigned char *grown = realloc(path_output, capacity);
    if (!grown) {
      if (!errors) fprintf(stderr, "%s: pathname output allocation failed\n", program_name);
      errors = 1;
      return 0;
    }
    path_output = grown;
    path_output_capacity = capacity;
  }
  if (length) memcpy(path_output + path_output_length, path, length);
  path_output[path_output_length + length] = 0;
  path_output_length = needed;
  path_output_records++;
  return 1;
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

static void null_failure(const char *message, size_t limit) {
  if (!errors) fprintf(stderr, "%s: null-data %s %zu\n", program_name, message, limit);
  errors = 1;
}

static int reserve_null_output(size_t extra) {
  if (extra > MAX_NULL_OUTPUT - null_output_length) {
    null_failure("output exceeds", MAX_NULL_OUTPUT);
    return 0;
  }
  size_t needed = null_output_length + extra;
  if (needed <= null_output_capacity) return 1;
  size_t capacity = null_output_capacity ? null_output_capacity : 4096;
  while (capacity < needed) {
    size_t next = capacity > MAX_NULL_OUTPUT / 2 ? MAX_NULL_OUTPUT : capacity * 2;
    if (next <= capacity) { capacity = needed; break; }
    capacity = next;
  }
  unsigned char *grown = realloc(null_output, capacity);
  if (!grown) {
    if (!errors) fprintf(stderr, "%s: null-data allocation failed\n", program_name);
    errors = 1;
    return 0;
  }
  null_output = grown;
  null_output_capacity = capacity;
  return 1;
}

static int append_null_bytes(const void *bytes, size_t length) {
  if (!reserve_null_output(length)) return 0;
  if (length) memcpy(null_output + null_output_length, bytes, length);
  null_output_length += length;
  return 1;
}

static int begin_null_output_record(void) {
  if (null_output_records >= MAX_NULL_OUTPUT_RECORDS) {
    null_failure("output record count exceeds", MAX_NULL_OUTPUT_RECORDS);
    return 0;
  }
  null_output_records++;
  return 1;
}

static void append_null_match(
  const char *path,
  int show_name,
  long ordinal,
  const unsigned char *record,
  size_t length
) {
  if (!begin_null_output_record()) return;
  if (show_name && (!append_null_bytes(path, strlen(path)) || !append_null_bytes(":", 1))) return;
  if (numbers) {
    char number[32];
    int size = snprintf(number, sizeof number, "%ld:", ordinal);
    if (size < 0 || !append_null_bytes(number, (size_t)size)) return;
  }
  if (!append_null_bytes(record, length)) return;
  append_null_bytes("", 1);
}

static void append_null_name(const char *path) {
  if (!begin_null_output_record()) return;
  if (!append_null_bytes(path, strlen(path))) return;
  append_null_bytes("", 1);
}

static void append_null_count(const char *path, int show_name, long count) {
  if (!begin_null_output_record()) return;
  if (show_name && (!append_null_bytes(path, strlen(path)) || !append_null_bytes(":", 1))) return;
  char number[32];
  int size = snprintf(number, sizeof number, "%ld", count);
  if (size < 0 || !append_null_bytes(number, (size_t)size)) return;
  append_null_bytes("", 1);
}

static int grow_null_record(unsigned char **record, size_t *capacity, size_t needed) {
  if (needed <= *capacity) return 1;
  size_t next = *capacity ? *capacity * 2 : 4096;
  if (next < needed) next = needed;
  if (next > MAX_LINE + 1) next = MAX_LINE + 1;
  unsigned char *grown = realloc(*record, next);
  if (!grown) {
    if (!errors) fprintf(stderr, "%s: null-data allocation failed\n", program_name);
    errors = 1;
    return 0;
  }
  *record = grown;
  *capacity = next;
  return 1;
}

static int finish_null_record(unsigned char **record, size_t *capacity, size_t length) {
  if (null_record_count >= MAX_NULL_RECORDS) {
    null_failure("record count exceeds", MAX_NULL_RECORDS);
    return -1;
  }
  null_record_count++;
  if (!grow_null_record(record, capacity, length + 1)) return -1;
  (*record)[length] = 0;
  return 1;
}

static int read_null_record(
  FILE *file,
  unsigned char **record,
  size_t *capacity,
  size_t *length
) {
  *length = 0;
  for (;;) {
    int byte = fgetc(file);
    if (byte == EOF) {
      if (*length) return finish_null_record(record, capacity, *length);
      return 0;
    }
    if (null_input_bytes >= MAX_NULL_INPUT) {
      null_failure("input exceeds", MAX_NULL_INPUT);
      return -1;
    }
    null_input_bytes++;
    if (byte == 0) return finish_null_record(record, capacity, *length);
    if (*length >= MAX_LINE) {
      null_failure("record exceeds", MAX_LINE);
      return -1;
    }
    if (!grow_null_record(record, capacity, *length + 2)) return -1;
    (*record)[(*length)++] = (unsigned char)byte;
  }
}

static int search_file_null(const char *path, int show_name) {
  if (!glob_allows(path)) return 0;
  FILE *file = !strcmp(path, "-") ? stdin : fopen(path, "rb");
  if (!file) {
    fprintf(stderr, "%s: %s: %s\n", program_name, path, strerror(errno));
    errors = 1;
    return 0;
  }
  unsigned char *record = NULL;
  size_t capacity = 0, length = 0;
  long ordinal = 0, count = 0;
  int matched_file = 0, state;
  while (!errors && (state = read_null_record(file, &record, &capacity, &length)) > 0) {
    ordinal++;
    if (count >= max_count || ((quiet || files_only || files_without) && matched_file)) continue;
    if (!line_matches((const char *)record)) continue;
    matched_file = selected_any = 1;
    count++;
    if (!quiet && !files_only && !files_without && !count_only) {
      append_null_match(path, show_name, ordinal, record, length);
    }
  }
  if (!errors && ferror(file)) {
    fprintf(stderr, "%s: %s: %s\n", program_name, path, strerror(errno));
    errors = 1;
  }
  if (!errors && files_only && matched_file) {
    append_null_name(path);
    reported_any = 1;
  }
  if (!errors && files_without && !matched_file) {
    append_null_name(path);
    reported_any = 1;
  }
  if (!errors && count_only) append_null_count(path, show_name, count);
  free(record);
  if (file != stdin) fclose(file);
  return matched_file;
}

static int search_file_lines(const char *path, int show_name) {
  if (!glob_allows(path)) return 0;
  FILE *file = !strcmp(path, "-") ? stdin : fopen(path, "rb");
  if (!file) {
    fprintf(stderr, "%s: %s: %s\n", program_name, path, strerror(errno));
    errors = 1;
    return 0;
  }
  char *line = NULL;
  size_t capacity = 0;
  ssize_t length;
  long lineno = 0, count = 0;
  int matched_file = 0;
  while (!errors && count < max_count && (length = getline(&line, &capacity, file)) >= 0) {
    lineno++;
    if ((size_t)length > MAX_LINE) {
      fprintf(stderr, "%s: %s:%ld: line exceeds %d bytes\n", program_name, path, lineno, MAX_LINE);
      errors = 1;
      break;
    }
    if ((size_t)length > MAX_LINE_INPUT - line_input_bytes) {
      fprintf(stderr, "%s: input limit exceeded\n", program_name);
      errors = 1;
      break;
    }
    line_input_bytes += (size_t)length;
    if (line_record_count >= MAX_LINE_RECORDS) {
      fprintf(stderr, "%s: record limit exceeded\n", program_name);
      errors = 1;
      break;
    }
    line_record_count++;
    if (memchr(line, 0, (size_t)length)) continue;
    if (!line_matches(line)) continue;
    matched_file = selected_any = 1;
    count++;
    if (quiet) break;
    if (files_only) break;
    if (files_without) break;
    if (count_only) continue;
    if (show_name && (!append_line_text(path) || !append_line_text(":"))) break;
    if (numbers) {
      char number[32];
      int size = snprintf(number, sizeof number, "%ld:", lineno);
      if (size < 0 || !append_line_bytes(number, (size_t)size)) break;
    }
    if (!append_line_bytes(line, (size_t)length)) break;
    if ((!length || line[length - 1] != '\n') && !append_line_text("\n")) break;
  }
  if (!errors && ferror(file)) {
    fprintf(stderr, "%s: %s: %s\n", program_name, path, strerror(errno));
    errors = 1;
  }
  if (!errors && files_only && matched_file) {
    if (null_paths) {
      if (append_path_name(path)) reported_any = 1;
    } else {
      append_line_text(path); append_line_text("\n"); reported_any = 1;
    }
  }
  if (!errors && files_without && !matched_file) {
    if (null_paths) {
      if (append_path_name(path)) reported_any = 1;
    } else {
      append_line_text(path); append_line_text("\n"); reported_any = 1;
    }
  }
  if (!errors && count_only) {
    if (show_name) { append_line_text(path); append_line_text(":"); }
    char number[32];
    int size = snprintf(number, sizeof number, "%ld\n", count);
    if (size < 0 || !append_line_bytes(number, (size_t)size)) errors = 1;
  }
  free(line);
  if (file != stdin) fclose(file);
  return matched_file;
}

static int search_file(const char *path, int show_name) {
  return null_data ? search_file_null(path, show_name) : search_file_lines(path, show_name);
}

static int preflight_inputs(int argc, char **argv, int index) {
  int operands = argc - index;
  if (operands > MAX_EXPLICIT_FILES) {
    fprintf(stderr, "%s: too many input files (max %d)\n", program_name, MAX_EXPLICIT_FILES);
    return 0;
  }
  for (; index < argc; index++) {
    const char *path = argv[index];
    if (!strcmp(path, "-")) continue;
    struct stat status;
    if (lstat(path, &status)) {
      fprintf(stderr, "%s: %s: %s\n", program_name, path, strerror(errno));
      return 0;
    }
    if (S_ISDIR(status.st_mode)) {
      if (!recursive) {
        fprintf(stderr, "%s: %s: is a directory\n", program_name, path);
        return 0;
      }
      DIR *directory = opendir(path);
      if (!directory) {
        fprintf(stderr, "%s: %s: %s\n", program_name, path, strerror(errno));
        return 0;
      }
      closedir(directory);
      continue;
    }
    if (!glob_allows(path)) continue;
    FILE *file = fopen(path, "rb");
    if (!file) {
      fprintf(stderr, "%s: %s: %s\n", program_name, path, strerror(errno));
      return 0;
    }
    fclose(file);
  }
  return 1;
}

static void walk(const char *path, int depth, int show_name) {
  if (depth > MAX_DEPTH) {
    fprintf(stderr, "%s: %s: traversal depth limit reached\n", program_name, path);
    errors = 1;
    return;
  }
  if (++visited > MAX_FILES) {
    if (visited == MAX_FILES + 1) fprintf(stderr, "%s: file limit reached (%d)\n", program_name, MAX_FILES);
    errors = 1;
    return;
  }
  if (null_paths && strlen(path) > MAX_PATH_BYTES) {
    fprintf(stderr, "%s: pathname exceeds %d bytes\n", program_name, MAX_PATH_BYTES);
    errors = 1;
    return;
  }
  struct stat status;
  if (lstat(path, &status)) {
    fprintf(stderr, "%s: %s: %s\n", program_name, path, strerror(errno));
    errors = 1;
    return;
  }
  if (!S_ISDIR(status.st_mode)) {
    if (list_files) {
      if (glob_allows(path)) {
        if (null_paths) append_path_name(path);
        else puts(path);
      }
    } else search_file(path, show_name);
    return;
  }
  DIR *directory = opendir(path);
  if (!directory) {
    fprintf(stderr, "%s: %s: %s\n", program_name, path, strerror(errno));
    errors = 1;
    return;
  }
  struct dirent *entry;
  while ((entry = readdir(directory))) {
    if (errors || (quiet && selected_any && !null_data)) break;
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
    puts("usage: rg [options] PATTERN [--] [PATH...]\n"
         "       rg [options] (-e PATTERN|--regexp[=PATTERN])+ [--] [PATH...]\n"
         "       rg --files [-0|--null] [PATH...]\n"
         "options: -n/--line-number -i/--ignore-case -v/--invert-match -c/--count -l/--files-with-matches\n"
         "         -q/--quiet -F/--fixed-strings -E/--extended-regexp -m NUM/--max-count NUM\n"
         "         -e/--regexp PATTERN -g/--glob GLOB -R/-r/--recursive -H/--with-filename\n"
         "         --hidden --files-without-match --null-data (NUL records; -z is reserved)\n"
         "         -0/--null (NUL-terminated paths with --files, -l, or --files-without-match)\n"
         "         patterns: max 64 and 65536 bytes total; any pattern selects a record\n"
         "         explicit inputs: max 100, preflighted before pattern search\n"
         "         text limits: 1 MiB/record; 16 MiB input; 100000 records; 1000000 output bytes\n"
         "         null-data limits: 1 MiB/record; 16 MiB and 100000 records total\n"
         "         null-path limits: 100 inputs; 4096 bytes/path; 100000 paths; 1 MiB output");
  } else {
    puts("usage: grep [options] PATTERN [--] [FILE...]\n"
         "       grep [options] (-e PATTERN|--regexp[=PATTERN])+ [--] [FILE...]\n"
         "options: -n/--line-number -i/--ignore-case -v/--invert-match -c/--count\n"
         "         -l/--files-with-matches -L/--files-without-match -q/--quiet\n"
         "         -F/--fixed-strings -E/--extended-regexp -R/-r/--recursive\n"
         "         -H/--with-filename -m NUM/--max-count NUM -e/--regexp PATTERN\n"
         "         patterns: max 64 and 65536 bytes total; any pattern selects a record\n"
         "         explicit inputs: max 100, preflighted before pattern search\n"
         "         text limits: 1 MiB/record; 16 MiB input; 100000 records; 1000000 output bytes\n"
         "         -z/--null-data uses NUL records (1 MiB/record; 16 MiB, 100000 total)");
  }
}

int main(int argc, char **argv) {
  const char *program = base(argv[0]);
  program_name = program;
  int rg_mode = !strcmp(program, "rg");
  recursive = rg_mode;
  numbers = rg_mode;
  show_hidden = !rg_mode;
  int index = 1, options = 1;
  for (; index < argc; index++) {
    const char *argument = argv[index];
    if (options && !strcmp(argument, "--")) { options = 0; continue; }
    if (!options || argument[0] != '-' || !argument[1]) break;
    if (!strcmp(argument, "--help") || !strcmp(argument, "-h")) { usage(program); return 0; }
    if (!strcmp(argument, "--version") || !strcmp(argument, "-V")) {
      printf("%s 0.4-piodide\n", program); return 0;
    }
    if (!strcmp(argument, "--files")) { list_files = recursive = 1; continue; }
    if (!strcmp(argument, "--null")) {
      if (!rg_mode) { fprintf(stderr, "grep: unknown option --null\n"); return 2; }
      null_paths = 1;
      continue;
    }
    if (!strcmp(argument, "--null-data")) { null_data = 1; continue; }
    if (!strncmp(argument, "--null-data=", 12)) {
      fprintf(stderr, "%s: option --null-data does not take an argument\n", program); return 2;
    }
    if (!strcmp(argument, "--hidden")) { show_hidden = 1; continue; }
    if (!strcmp(argument, "--no-ignore") || !strcmp(argument, "--color=never")) continue;
    if (!strcmp(argument, "--fixed-strings")) { fixed = 1; continue; }
    if (!strcmp(argument, "--extended-regexp")) continue;
    if (!strcmp(argument, "--line-number")) { numbers = numbers_explicit = 1; continue; }
    if (!strcmp(argument, "--ignore-case")) { icase = 1; continue; }
    if (!strcmp(argument, "--invert-match")) { invert = 1; continue; }
    if (!strcmp(argument, "--count")) { count_only = 1; continue; }
    if (!strcmp(argument, "--files-with-matches")) { files_only = 1; continue; }
    if (!strcmp(argument, "--files-without-match")) { files_without = 1; continue; }
    if (!strcmp(argument, "--quiet") || !strcmp(argument, "--silent")) { quiet = 1; continue; }
    if (!strcmp(argument, "--recursive")) { recursive = 1; continue; }
    if (!strcmp(argument, "--with-filename")) { force_filename = 1; continue; }
    if (!strcmp(argument, "-m") || !strcmp(argument, "--max-count")) {
      if (++index >= argc) { fprintf(stderr, "%s: %s requires a count\n", program, argument); return 2; }
      char *end = NULL; errno = 0; max_count = strtol(argv[index], &end, 10);
      if (errno || !*argv[index] || *end || max_count < 0) {
        fprintf(stderr, "%s: invalid max count: %s\n", program, argv[index]); return 2;
      }
      continue;
    }
    if (!strncmp(argument, "--max-count=", 12) ||
        (!strncmp(argument, "-m", 2) && argument[2])) {
      const char *value = argument + (argument[1] == 'm' ? 2 : 12);
      char *end = NULL; errno = 0; max_count = strtol(value, &end, 10);
      if (errno || !*value || *end || max_count < 0) {
        fprintf(stderr, "%s: invalid max count: %s\n", program, value); return 2;
      }
      continue;
    }
    if (!strcmp(argument, "-e") || !strcmp(argument, "--regexp")) {
      if (++index >= argc) { fprintf(stderr, "%s: %s requires a pattern\n", program, argument); return 2; }
      if (!add_pattern(argv[index])) return 2;
      continue;
    }
    if (!strncmp(argument, "--regexp=", 9)) {
      if (!add_pattern(argument + 9)) return 2;
      continue;
    }
    if (!strcmp(argument, "-g") || !strcmp(argument, "--glob")) {
      if (++index >= argc || nglobs >= MAX_GLOBS) { fprintf(stderr, "%s: -g requires a glob (maximum %d)\n", program, MAX_GLOBS); return 2; }
      globs[nglobs++] = argv[index];
      continue;
    }
    if (!strncmp(argument, "--glob=", 7)) {
      if (nglobs >= MAX_GLOBS) { fprintf(stderr, "%s: too many globs\n", program); return 2; }
      globs[nglobs++] = argument + 7;
      continue;
    }
    if (argument[0] == '-' && argument[1] == '-') {
      fprintf(stderr, "%s: unknown option %s\n", program, argument); return 2;
    }
    for (const char *flag = argument + 1; *flag; flag++) {
      if (*flag == 'i') icase = 1;
      else if (*flag == 'v') invert = 1;
      else if (*flag == 'n') numbers = numbers_explicit = 1;
      else if (*flag == 'c') count_only = 1;
      else if (*flag == 'l') files_only = 1;
      else if (*flag == 'L') {
        if (rg_mode) { fprintf(stderr, "rg: -L symlink traversal is unavailable; use --files-without-match to list nonmatching files\n"); return 2; }
        files_without = 1;
      }
      else if (*flag == 'q') quiet = 1;
      else if (*flag == 'F') fixed = 1;
      else if (*flag == 'E') { }
      else if (*flag == 'R' || *flag == 'r') recursive = 1;
      else if (*flag == 'H') force_filename = 1;
      else if (*flag == 'I') { }
      else if (*flag == '0') {
        if (!rg_mode) { fprintf(stderr, "grep: unknown option -0\n"); return 2; }
        null_paths = 1;
      }
      else if (*flag == 'z') {
        if (rg_mode) {
          fprintf(stderr, "rg: -z is reserved for compressed search; use --null-data\n"); return 2;
        }
        null_data = 1;
      }
      else { fprintf(stderr, "%s: unknown option -%c\n", program, *flag); return 2; }
    }
  }

  if ((files_only && files_without) || (files_without && (count_only || quiet))) {
    fprintf(stderr, "%s: conflicting output modes\n", program); return 2;
  }
  if (rg_mode && null_data && !numbers_explicit) numbers = 0;
  if (null_data && list_files) {
    fprintf(stderr, "%s: --null-data cannot be used with --files\n", program); return 2;
  }
  if (null_paths && null_data) {
    fprintf(stderr, "rg: --null and --null-data are different modes and cannot be combined\n");
    return 2;
  }
  if (null_paths && !(list_files || files_only || files_without)) {
    fprintf(stderr, "rg: -0/--null requires --files, -l, or --files-without-match\n");
    return 2;
  }
  if (null_paths && list_files && (files_only || files_without)) {
    fprintf(stderr, "rg: conflicting pathname output modes\n");
    return 2;
  }
  if (null_paths && (numbers_explicit || count_only || quiet)) {
    fprintf(stderr, "rg: -0/--null cannot be combined with line numbers, count, or quiet mode\n");
    return 2;
  }

  if (!list_files) {
    if (!pattern_count) {
      if (index >= argc) { usage(program); return 2; }
      if (!add_pattern(argv[index++])) return 2;
    }
    /* In the common `grep PATTERN -- FILE` form, option scanning stopped at
       PATTERN. Consume the separator here instead of searching a file named
       `--` and falsely returning status 2 after useful output. */
    if (options && index < argc && !strcmp(argv[index], "--")) index++;
    if (!fixed && !compile_patterns()) return 2;
  }

  int operands = argc - index;
  if (null_paths) {
    if (operands > MAX_EXPLICIT_FILES) {
      fprintf(stderr, "rg: too many input paths (max %d)\n", MAX_EXPLICIT_FILES);
      free_expressions();
      return 2;
    }
    for (int operand = index; operand < argc; operand++) {
      if (!strcmp(argv[operand], "-")) {
        fprintf(stderr, "rg: -0/--null pathname output does not accept stdin\n");
        free_expressions();
        return 2;
      }
      if (strlen(argv[operand]) > MAX_PATH_BYTES) {
        fprintf(stderr, "rg: pathname exceeds %d bytes\n", MAX_PATH_BYTES);
        free_expressions();
        return 2;
      }
    }
  }
  if (!list_files && operands && !preflight_inputs(argc, argv, index)) {
    free_expressions();
    return 2;
  }
  if (!operands && !recursive) {
    search_file("-", 0);
  } else {
    if (!operands) {
      walk(".", 0, 1);
    } else {
      for (; index < argc; index++) {
        if (errors || (quiet && selected_any && !null_data)) break;
        struct stat status;
        if (list_files) {
          walk(argv[index], 0, 1);
        } else if (!strcmp(argv[index], "-")) {
          search_file("-", force_filename || operands > 1);
        } else if (!lstat(argv[index], &status) && S_ISDIR(status.st_mode)) {
          if (!recursive) {
            fprintf(stderr, "%s: %s: is a directory\n", program, argv[index]);
            errors = 1;
          } else walk(argv[index], 0, 1);
        } else {
          search_file(argv[index], force_filename || operands > 1);
        }
      }
    }
  }
  free_expressions();
  if (null_data && !errors && null_output_length) {
    if (fwrite(null_output, 1, null_output_length, stdout) != null_output_length || ferror(stdout)) {
      fprintf(stderr, "%s: stdout: %s\n", program_name, strerror(errno));
      errors = 1;
    }
  }
  if (!null_data && !list_files && !errors && line_output_length) {
    if (fwrite(line_output, 1, line_output_length, stdout) != line_output_length || ferror(stdout)) {
      fprintf(stderr, "%s: stdout: %s\n", program_name, strerror(errno));
      errors = 1;
    }
  }
  if (null_paths && !errors && path_output_length) {
    if (fwrite(path_output, 1, path_output_length, stdout) != path_output_length || ferror(stdout)) {
      fprintf(stderr, "%s: stdout: %s\n", program_name, strerror(errno));
      errors = 1;
    }
  }
  free(line_output);
  free(null_output);
  free(path_output);
  if (errors) return 2;
  return list_files || (files_without ? reported_any : selected_any) ? 0 : 1;
}
