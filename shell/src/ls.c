/* Bounded directory lister for Slop's browser workspace. */
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#define ENTRY_LIMIT 4096
#define OPERAND_LIMIT 64
#define PATH_LIMIT 4096

typedef struct {
  char *name;
  long long size;
  time_t mtime;
  mode_t mode;
} Entry;

static int sort_time, reverse_sort;

static const char *suffix(mode_t mode) {
  return S_ISDIR(mode) ? "/" : S_ISLNK(mode) ? "@" : "";
}

static void format_size(long long size, char output[32]) {
  static const char units[] = "KMGTPE";
  if (size < 1024) { snprintf(output, 32, "%lld", size); return; }
  double value = (double)size; int unit = -1;
  do { value /= 1024.0; unit++; } while (value >= 1024.0 && unit + 1 < (int)sizeof units - 1);
  if (value < 10.0) snprintf(output, 32, "%.1f%c", value, units[unit]);
  else snprintf(output, 32, "%.0f%c", value, units[unit]);
}

static void print_entry(const char *name, long long size, mode_t mode, int long_format, int human) {
  if (long_format) {
    if (human) {
      char formatted[32]; format_size(size, formatted);
      printf("%8s %s%s\n", formatted, name, suffix(mode));
    } else printf("%8lld %s%s\n", size, name, suffix(mode));
  } else printf("%s%s\n", name, suffix(mode));
}

static int compare_entries(const void *left, const void *right) {
  const Entry *a = left, *b = right; int result = 0;
  if (sort_time) {
    if (a->mtime > b->mtime) result = -1;
    else if (a->mtime < b->mtime) result = 1;
  }
  if (!result) result = strcmp(a->name, b->name);
  if (!result) return 0;
  return reverse_sort ? (result < 0 ? 1 : -1) : (result < 0 ? -1 : 1);
}

static void usage(void) {
  puts("usage: ls [-1adhlrt] [--] [PATH...]  # -h affects -l sizes; -t newest first; 64 operands; 4096 entries/directory\n"
       "long aliases: --all --directory --human-readable --reverse --sort=time");
}

int main(int argc, char **argv) {
  int long_format = 0, all = 0, human = 0, directory = 0;
  const char *paths[OPERAND_LIMIT]; int path_count = 0;
  for (int i = 1; i < argc; i++) {
    const char *argument = argv[i];
    if (!strcmp(argument, "--help")) { usage(); return 0; }
    if (!strcmp(argument, "--version")) { puts("ls 0.4-piodide"); return 0; }
    if (!strcmp(argument, "--all")) { all = 1; continue; }
    if (!strcmp(argument, "--directory")) { directory = 1; continue; }
    if (!strcmp(argument, "--human-readable")) { human = 1; continue; }
    if (!strcmp(argument, "--reverse")) { reverse_sort = 1; continue; }
    if (!strcmp(argument, "--sort=time")) { sort_time = 1; continue; }
    if (!strcmp(argument, "--")) {
      for (i++; i < argc; i++) {
        if (path_count >= OPERAND_LIMIT) { fprintf(stderr, "ls: operand limit is %d\n", OPERAND_LIMIT); return 2; }
        paths[path_count++] = argv[i];
      }
      break;
    }
    if (argument[0] == '-' && argument[1]) {
      if (argument[1] == '-') { fprintf(stderr, "ls: unknown option %s\n", argument); return 2; }
      for (const char *flag = argument + 1; *flag; flag++) {
        if (*flag == 'l') long_format = 1;
        else if (*flag == 'a') all = 1;
        else if (*flag == 'h') human = 1;
        else if (*flag == 't') sort_time = 1;
        else if (*flag == 'r') reverse_sort = 1;
        else if (*flag == 'd') directory = 1;
        else if (*flag == '1') { }
        else { fprintf(stderr, "ls: unknown option -%c\n", *flag); return 2; }
      }
      continue;
    }
    if (path_count >= OPERAND_LIMIT) { fprintf(stderr, "ls: operand limit is %d\n", OPERAND_LIMIT); return 2; }
    paths[path_count++] = argument;
  }
  if (!path_count) paths[path_count++] = ".";

  int result = 0;
  for (int operand_index = 0; operand_index < path_count; operand_index++) {
    const char *path = paths[operand_index]; struct stat operand;
    if (lstat(path, &operand)) {
      fprintf(stderr, "ls: %s: %s\n", path, strerror(errno)); result = 1; continue;
    }
    if (directory || !S_ISDIR(operand.st_mode)) {
      print_entry(path, (long long)operand.st_size, operand.st_mode, long_format, human);
      continue;
    }

    if (path_count > 1) printf("%s:\n", path);
    DIR *stream = opendir(path);
    if (!stream) { fprintf(stderr, "ls: %s: %s\n", path, strerror(errno)); result = 1; continue; }
    Entry *entries = calloc(ENTRY_LIMIT, sizeof *entries); int count = 0, bounded_failure = 0;
    if (!entries) { fprintf(stderr, "ls: %s: out of memory\n", path); closedir(stream); return 1; }
    struct dirent *item;
    while ((item = readdir(stream))) {
      if (!all && item->d_name[0] == '.') continue;
      if (count >= ENTRY_LIMIT) {
        fprintf(stderr, "ls: %s: entry limit is %d\n", path, ENTRY_LIMIT);
        result = 1; bounded_failure = 1; break;
      }
      char full[PATH_LIMIT];
      if (snprintf(full, sizeof full, "%s/%s", path, item->d_name) >= (int)sizeof full) {
        fprintf(stderr, "ls: %s/%s: path too long\n", path, item->d_name); result = 1; continue;
      }
      struct stat status;
      if (lstat(full, &status)) { fprintf(stderr, "ls: %s: %s\n", full, strerror(errno)); result = 1; continue; }
      entries[count].name = strdup(item->d_name);
      if (!entries[count].name) {
        fprintf(stderr, "ls: %s: out of memory\n", path); result = 1; bounded_failure = 1; break;
      }
      entries[count].size = (long long)status.st_size;
      entries[count].mtime = status.st_mtime;
      entries[count].mode = status.st_mode;
      count++;
    }
    closedir(stream);
    if (!bounded_failure) {
      qsort(entries, (size_t)count, sizeof *entries, compare_entries);
      for (int i = 0; i < count; i++)
        print_entry(entries[i].name, entries[i].size, entries[i].mode, long_format, human);
    }
    for (int i = 0; i < count; i++) free(entries[i].name);
    free(entries);
  }
  return result;
}
