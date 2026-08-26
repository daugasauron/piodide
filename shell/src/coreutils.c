/* Small multicall utilities for slop's WASI workspace. */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <fnmatch.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

/* WASI does not expose chmod. The command fails explicitly below instead of
 * claiming a mode change that the shared filesystem cannot represent. */
#ifndef __wasi__
int chmod(const char *, mode_t);
#endif

#define COPY_BUF 65536
#define DATA_LIMIT (16 * 1024 * 1024)
#define SORT_LINES 100000
#define RECORD_LIMIT (1024 * 1024)
#define RECORD_OUTPUT_LIMIT (32 * 1024 * 1024)
#define DIFF_LINES 100000
#define FIND_ENTRIES 100000
#define FIND_PATHS 100
#define DU_PATHS 64
#define DU_DEPTH_LIMIT 128
#define DU_ENTRIES 100000
#define DU_RECORDS 100000
#define DU_OUTPUT_LIMIT (16 * 1024 * 1024)
#define DU_PATH_LIMIT 4096
#define DU_PATH_TOTAL_LIMIT 65536
#define REALPATH_MISSING_OPERANDS 100
#define REALPATH_MISSING_PATH_LIMIT 4096
#define REALPATH_MISSING_COMPONENT_LIMIT 256
#define XARGS_MAX 128
#define XARGS_BLOB 16384
#define ENV_LIMIT 65536
#define PASTE_FILES 32
#define PASTE_DELIMITERS 256
#define JOIN_FIELDS 1000
#define JOIN_RECORD_OUTPUT_LIMIT (2 * 1024 * 1024)
#define XXD_LIMIT (16 * 1024 * 1024)
#define BASE64_PATH_LIMIT 4096
#define BASE64_ENCODE_OUTPUT_LIMIT 22369624
#define BASE64_DECODE_OUTPUT_LIMIT 12582912
#define STRINGS_OPERAND_LIMIT 100
#define STRINGS_PATH_LIMIT 4096
#define STRINGS_MIN_LIMIT 65536
#define STRINGS_EXPLICIT_INPUT_LIMIT (64 * 1024 * 1024)
#define STRINGS_OUTPUT_LIMIT (16 * 1024 * 1024)
#define TRUNCATE_SIZE_LIMIT (64 * 1024 * 1024)
#define TRUNCATE_PATH_LIMIT 4096
#define SHA256_MANIFEST_LIMIT (1024 * 1024)
#define SHA256_MANIFEST_RECORDS 4096
#define SHA256_MANIFEST_LINE 4096
#define HEAD_INPUT_LIMIT 100
#define HEAD_TOTAL_LIMIT (64 * 1024 * 1024)
#define CP_SOURCE_LIMIT 100
#define CP_PATH_LIMIT 4096
#define CP_PATH_TOTAL_LIMIT 65536
#define CP_COMPONENT_LIMIT 128
#define CP_RESOLVED_PATH_LIMIT 65536
#define RM_OPERAND_LIMIT 100
#define RM_PATH_LIMIT CP_PATH_LIMIT
#define RM_PATH_TOTAL_LIMIT CP_PATH_TOTAL_LIMIT
#define RM_COMPONENT_LIMIT CP_COMPONENT_LIMIT
#define RM_RECURSION_LIMIT 128
#define RM_PLAN_LIMIT 100000
#define RM_PLAN_HASH_SIZE 262147
#define RMDIR_OPERAND_LIMIT RM_OPERAND_LIMIT
#define RMDIR_PATH_LIMIT RM_PATH_LIMIT
#define RMDIR_PATH_TOTAL_LIMIT RM_PATH_TOTAL_LIMIT
#define RMDIR_COMPONENT_LIMIT RM_COMPONENT_LIMIT
#define MV_SOURCE_LIMIT CP_SOURCE_LIMIT
#define MV_PATH_LIMIT CP_PATH_LIMIT
#define MV_PATH_TOTAL_LIMIT CP_PATH_TOTAL_LIMIT
#define MV_COMPONENT_LIMIT CP_COMPONENT_LIMIT
#define TOUCH_OPERAND_LIMIT 100
#define TOUCH_PATH_LIMIT 4096
#define TOUCH_PATH_TOTAL_LIMIT 65536
#define TOUCH_COMPONENT_LIMIT 128
#define INSTALL_SOURCE_LIMIT CP_SOURCE_LIMIT
#define INSTALL_DIRECTORY_LIMIT CP_SOURCE_LIMIT
#define INSTALL_PATH_LIMIT CP_PATH_LIMIT
#define INSTALL_PATH_TOTAL_LIMIT CP_PATH_TOTAL_LIMIT
#define INSTALL_COMPONENT_LIMIT CP_COMPONENT_LIMIT
#define LN_PATH_LIMIT CP_PATH_LIMIT
#define LN_COMPONENT_LIMIT CP_COMPONENT_LIMIT
#define MKDIR_OPERAND_LIMIT 100
#define MKDIR_PATH_LIMIT CP_PATH_LIMIT
#define MKDIR_PATH_TOTAL_LIMIT CP_PATH_TOTAL_LIMIT
#define MKDIR_COMPONENT_LIMIT CP_COMPONENT_LIMIT
#define MKDIR_CREATION_LIMIT 1024
#define MKTEMP_TEMPLATE_LIMIT 1024
#define MKTEMP_PATH_LIMIT CP_PATH_LIMIT
#define MKTEMP_COMPONENT_LIMIT CP_COMPONENT_LIMIT
#define MKTEMP_ATTEMPT_LIMIT 128

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
static char *canonical_existing_path(const char *input);
static char *canonical_existing_path_counted(const char *input, int *link_count);
static char *canonical_touch_target(const char *input, int *exists);

static int cp_path_component_limit(const char *path) {
  int components = 0, leading_parents = 0;
  int absolute = path[0] == '/';
  const char *cursor = path;
  while (*cursor) {
    while (*cursor == '/') cursor++;
    const char *start = cursor;
    while (*cursor && *cursor != '/') cursor++;
    size_t length = (size_t)(cursor - start);
    if (!length || (length == 1 && start[0] == '.')) continue;
    if (length == 2 && start[0] == '.' && start[1] == '.') {
      if (components) components--;
      else if (!absolute) leading_parents++;
      continue;
    }
    components++;
  }
  return components + leading_parents <= CP_COMPONENT_LIMIT;
}

static int cp_append_component(
  char *output,
  size_t *length,
  size_t *offsets,
  int *depth,
  const char *component,
  size_t component_length
) {
  if (*depth >= CP_COMPONENT_LIMIT * 2 ||
      component_length > CP_RESOLVED_PATH_LIMIT - *length - 2) {
    errno = ENAMETOOLONG;
    return 0;
  }
  offsets[(*depth)++] = *length;
  if (*length > 1) output[(*length)++] = '/';
  memcpy(output + *length, component, component_length);
  *length += component_length;
  output[*length] = 0;
  return 1;
}

static int cp_apply_lexical_components(
  char *output,
  size_t *length,
  size_t *offsets,
  int *depth,
  const char *path
) {
  const char *cursor = path;
  while (*cursor) {
    while (*cursor == '/') cursor++;
    const char *start = cursor;
    while (*cursor && *cursor != '/') cursor++;
    size_t component_length = (size_t)(cursor - start);
    if (!component_length || (component_length == 1 && start[0] == '.')) continue;
    if (component_length == 2 && start[0] == '.' && start[1] == '.') {
      if (*depth) {
        *length = offsets[--(*depth)];
        output[*length] = 0;
      }
      continue;
    }
    if (!cp_append_component(output, length, offsets, depth, start, component_length)) return 0;
  }
  return 1;
}

static char *cp_lexical_absolute_path(const char *input) {
  if (!input || !*input) { errno = ENOENT; return NULL; }
  char *output = calloc(1, CP_RESOLVED_PATH_LIMIT);
  if (!output) { errno = ENOMEM; return NULL; }
  size_t offsets[CP_COMPONENT_LIMIT * 2];
  size_t length = 1;
  int depth = 0;
  output[0] = '/';
  if (input[0] != '/') {
    const char *cwd = getenv("PIODIDE_CWD");
    if (!cwd || !*cwd) cwd = getenv("PWD");
    if (!cwd || cwd[0] != '/') cwd = "/home/web";
    if (!cp_apply_lexical_components(output, &length, offsets, &depth, cwd)) {
      free(output); return NULL;
    }
  }
  if (!cp_apply_lexical_components(output, &length, offsets, &depth, input)) {
    free(output); return NULL;
  }
  return output;
}

static char *cp_canonical_target_path(const char *input) {
  char *lexical = cp_lexical_absolute_path(input);
  if (!lexical) return NULL;
  char *probe = strdup(lexical);
  if (!probe) { free(lexical); errno = ENOMEM; return NULL; }
  for (;;) {
    char *resolved = canonical_existing_path(probe);
    if (resolved) {
      size_t prefix_length = strlen(probe);
      const char *suffix = lexical + prefix_length;
      size_t resolved_length = strlen(resolved), suffix_length = strlen(suffix);
      if (resolved_length + suffix_length >= CP_RESOLVED_PATH_LIMIT) {
        free(resolved); free(probe); free(lexical); errno = ENAMETOOLONG; return NULL;
      }
      char *target = malloc(resolved_length + suffix_length + 1);
      if (!target) {
        free(resolved); free(probe); free(lexical); errno = ENOMEM; return NULL;
      }
      memcpy(target, resolved, resolved_length);
      memcpy(target + resolved_length, suffix, suffix_length + 1);
      free(resolved); free(probe); free(lexical);
      return target;
    }
    if (errno != ENOENT || !strcmp(probe, "/")) {
      free(probe); free(lexical); return NULL;
    }
    char *slash = strrchr(probe, '/');
    if (!slash || slash == probe) strcpy(probe, "/");
    else *slash = 0;
  }
}

static char *cp_effective_target(const char *source, const char *destination, int destination_is_dir) {
  if (!destination_is_dir) return strdup(destination);
  size_t source_length = strlen(source);
  while (source_length && source[source_length - 1] == '/') source_length--;
  size_t base_start = source_length;
  while (base_start && source[base_start - 1] != '/') base_start--;
  size_t base_length = source_length - base_start;
  if (!base_length) { errno = EINVAL; return NULL; }
  size_t destination_length = strlen(destination);
  if (destination_length + base_length + 2 > CP_RESOLVED_PATH_LIMIT) {
    errno = ENAMETOOLONG; return NULL;
  }
  char *target = malloc(destination_length + base_length + 2);
  if (!target) { errno = ENOMEM; return NULL; }
  memcpy(target, destination, destination_length);
  target[destination_length] = '/';
  memcpy(target + destination_length + 1, source + base_start, base_length);
  target[destination_length + base_length + 1] = 0;
  return target;
}

static int cp_destination_is_directory(const char *path) {
  char *physical = canonical_existing_path(path);
  if (!physical) return 0;
  struct stat status;
  int directory = stat(physical, &status) == 0 && S_ISDIR(status.st_mode);
  free(physical);
  return directory;
}

static int cp_path_within(const char *source, const char *target) {
  size_t source_length = strlen(source);
  if (!strcmp(source, target)) return 1;
  if (!strcmp(source, "/")) return target[0] == '/';
  return !strncmp(source, target, source_length) && target[source_length] == '/';
}

/* Resolve every existing parent component physically while preserving the
 * final directory entry. Split the raw path before resolution so `link/..`
 * must traverse link rather than disappearing during lexical normalization.
 * rename(2) operates on a final symlink rather than its referent, so
 * canonical_existing_path() is intentionally not used for an ordinary final
 * component. */
static char *mv_canonical_entry_path(const char *input) {
  if (!input || !*input) { errno = ENOENT; return NULL; }
  char *raw = strdup(input);
  if (!raw) { errno = ENOMEM; return NULL; }
  size_t raw_length = strlen(raw);
  while (raw_length > 1 && raw[raw_length - 1] == '/') raw[--raw_length] = 0;
  if (!strcmp(raw, "/")) return raw;

  char *slash = strrchr(raw, '/');
  const char *name = slash ? slash + 1 : raw;
  if (!*name) { free(raw); errno = EINVAL; return NULL; }
  if (!strcmp(name, ".") || !strcmp(name, "..")) {
    char *resolved = canonical_existing_path(raw);
    free(raw); return resolved;
  }

  char *parent;
  if (!slash) parent = strdup(".");
  else if (slash == raw) parent = strdup("/");
  else {
    *slash = 0;
    parent = strdup(raw);
    *slash = '/';
  }
  if (!parent) { free(raw); errno = ENOMEM; return NULL; }
  char *physical_parent = canonical_existing_path(parent);
  free(parent);
  if (!physical_parent) { free(raw); return NULL; }
  struct stat parent_status;
  if (stat(physical_parent, &parent_status) || !S_ISDIR(parent_status.st_mode)) {
    if (!errno) errno = ENOTDIR;
    free(physical_parent); free(raw); return NULL;
  }

  size_t parent_length = strlen(physical_parent), name_length = strlen(name);
  if (parent_length + name_length + 2 > CP_RESOLVED_PATH_LIMIT) {
    free(physical_parent); free(raw); errno = ENAMETOOLONG; return NULL;
  }
  char *entry = malloc(parent_length + name_length + 2);
  if (!entry) { free(physical_parent); free(raw); errno = ENOMEM; return NULL; }
  memcpy(entry, physical_parent, parent_length);
  size_t length = parent_length;
  if (length > 1) entry[length++] = '/';
  memcpy(entry + length, name, name_length + 1);
  free(physical_parent); free(raw); return entry;
}

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

struct rm_plan_entry {
  char *path;
  int directory;
  int depth;
};

struct rm_plan {
  struct rm_plan_entry *entries;
  int *slots;
  int count;
  int scanned;
};

static uint64_t rm_path_hash(const char *path) {
  uint64_t hash = UINT64_C(1469598103934665603);
  for (const unsigned char *cursor = (const unsigned char *)path; *cursor; cursor++) {
    hash ^= *cursor;
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

static int rm_plan_lookup(const struct rm_plan *plan, const char *path) {
  size_t slot = (size_t)(rm_path_hash(path) % RM_PLAN_HASH_SIZE);
  for (int probe = 0; probe < RM_PLAN_HASH_SIZE; probe++) {
    int stored = plan->slots[slot];
    if (!stored) return -1;
    if (!strcmp(plan->entries[stored - 1].path, path)) return stored - 1;
    if (++slot == RM_PLAN_HASH_SIZE) slot = 0;
  }
  return -1;
}

static int rm_path_depth(const char *path) {
  int depth = 0, in_component = 0;
  for (const char *cursor = path; *cursor; cursor++) {
    if (*cursor == '/') in_component = 0;
    else if (!in_component) { depth++; in_component = 1; }
  }
  return depth;
}

static int rm_plan_add(struct rm_plan *plan, char *path, int directory) {
  if (rm_plan_lookup(plan, path) >= 0) { free(path); return 0; }
  if (plan->count == RM_PLAN_LIMIT) {
    fprintf(stderr, "rm: planned entries exceed %d\n", RM_PLAN_LIMIT);
    free(path); return 2;
  }
  int index = plan->count++;
  plan->entries[index].path = path;
  plan->entries[index].directory = directory;
  plan->entries[index].depth = rm_path_depth(path);
  size_t slot = (size_t)(rm_path_hash(path) % RM_PLAN_HASH_SIZE);
  while (plan->slots[slot]) if (++slot == RM_PLAN_HASH_SIZE) slot = 0;
  plan->slots[slot] = index + 1;
  return 0;
}

static int rm_plan_collect(
  struct rm_plan *plan,
  char *path,
  const char *display,
  int recursive,
  int force,
  int depth
) {
  if (rm_plan_lookup(plan, path) >= 0) { free(path); return 0; }
  if (depth > RM_RECURSION_LIMIT) {
    fprintf(stderr, "rm: recursion exceeds depth %d: %s\n", RM_RECURSION_LIMIT, display);
    free(path); return 2;
  }
  if (++plan->scanned > RM_PLAN_LIMIT) {
    fprintf(stderr, "rm: scanned entries exceed %d\n", RM_PLAN_LIMIT);
    free(path); return 2;
  }

  struct stat status;
  if (lstat(path, &status)) {
    int missing = errno == ENOENT;
    if (!missing || !force) errorf(display);
    free(path); return missing && force ? 0 : 1;
  }
  if (!S_ISDIR(status.st_mode)) return rm_plan_add(plan, path, 0);
  if (!recursive) {
    errno = EISDIR; errorf(display); free(path); return 1;
  }

  DIR *directory = opendir(path);
  if (!directory) { int rc = errorf(display); free(path); return rc; }
  int rc = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) {
      if (errno) rc = errorf(display);
      break;
    }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    size_t path_length = strlen(path), name_length = strlen(entry->d_name);
    if (path_length + name_length + 2 > CP_RESOLVED_PATH_LIMIT) {
      fprintf(stderr, "rm: resolved path exceeds %d bytes\n", CP_RESOLVED_PATH_LIMIT);
      rc = 2; break;
    }
    char *child = malloc(path_length + name_length + 2);
    if (!child) { errno = ENOMEM; rc = errorf(display); break; }
    memcpy(child, path, path_length);
    size_t length = path_length;
    if (length > 1) child[length++] = '/';
    memcpy(child + length, entry->d_name, name_length + 1);
    rc = rm_plan_collect(plan, child, child, recursive, force, depth + 1);
    if (rc) break;
  }
  if (closedir(directory) && !rc) rc = errorf(display);
  if (rc) { free(path); return rc; }
  return rm_plan_add(plan, path, 1);
}

static int rm_plan_order(const void *left_value, const void *right_value) {
  const struct rm_plan_entry *left = left_value, *right = right_value;
  if (left->depth != right->depth) return right->depth - left->depth;
  return strcmp(left->path, right->path);
}

static int rm_dot_operand(const char *path) {
  size_t length = strlen(path);
  while (length > 1 && path[length - 1] == '/') length--;
  size_t start = length;
  while (start && path[start - 1] != '/') start--;
  size_t component = length - start;
  return (component == 1 && path[start] == '.') ||
    (component == 2 && path[start] == '.' && path[start + 1] == '.');
}

static void rm_plan_dispose(struct rm_plan *plan) {
  for (int index = 0; index < plan->count; index++) free(plan->entries[index].path);
  free(plan->entries); free(plan->slots);
}

static int copy_path_exact(const char *src, const char *dst, int recursive, int no_clobber, int depth) {
  if (depth > 128) return 1;
  struct stat st; if (stat(src, &st)) return errorf(src);
  struct stat target;
  if (stat(dst, &target) == 0 && target.st_dev == st.st_dev && target.st_ino == st.st_ino) {
    fprintf(stderr, "%s: '%s' and '%s' are the same file\n", prog, src, dst);
    return 1;
  }
  int rc = 0;
  if (S_ISDIR(st.st_mode)) {
    if (!recursive) { fprintf(stderr, "%s: omitting directory '%s'\n", prog, src); return 1; }
    struct stat existing;
    if (no_clobber && lstat(dst, &existing) == 0 && !S_ISDIR(existing.st_mode)) {
      return 0;
    }
    if (mkdir(dst, 0777) && errno != EEXIST) return errorf(dst);
    DIR *d = opendir(src); if (!d) return errorf(src);
    struct dirent *e;
    while ((e = readdir(d))) {
      if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
      size_t a = strlen(src) + strlen(e->d_name) + 2, b = strlen(dst) + strlen(e->d_name) + 2;
      char *ss = malloc(a), *dd = malloc(b);
      if (!ss || !dd) { free(ss); free(dd); rc = 1; break; }
      snprintf(ss, a, "%s/%s", src, e->d_name); snprintf(dd, b, "%s/%s", dst, e->d_name);
      if (copy_path_exact(ss, dd, recursive, no_clobber, depth + 1)) rc = 1;
      free(ss); free(dd);
    }
    closedir(d);
  } else {
    struct stat existing;
    if (no_clobber && lstat(dst, &existing) == 0) rc = 0;
    else rc = copy_file(src, dst);
  }
  return rc;
}

static int move_path_exact(const char *src, const char *dst, int depth) {
  if (depth > CP_COMPONENT_LIMIT) {
    fprintf(stderr, "mv: recursion too deep: %s\n", src); return 1;
  }
  if (!rename(src, dst)) return 0;
  int rename_error = errno;
  struct stat source_status, target_status;
  if (lstat(src, &source_status) || lstat(dst, &target_status) ||
      !S_ISDIR(source_status.st_mode) || !S_ISDIR(target_status.st_mode)) {
    errno = rename_error; return errorf(dst);
  }

  DIR *directory = opendir(src);
  if (!directory) return errorf(src);
  struct dirent *entry;
  int rc = 0;
  while ((entry = readdir(directory))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    size_t source_length = strlen(src) + strlen(entry->d_name) + 2;
    size_t target_length = strlen(dst) + strlen(entry->d_name) + 2;
    if (source_length > CP_RESOLVED_PATH_LIMIT || target_length > CP_RESOLVED_PATH_LIMIT) {
      errno = ENAMETOOLONG; errorf(entry->d_name); rc = 1; break;
    }
    char *source_child = malloc(source_length), *target_child = malloc(target_length);
    if (!source_child || !target_child) {
      free(source_child); free(target_child); errno = ENOMEM; errorf(entry->d_name); rc = 1; break;
    }
    snprintf(source_child, source_length, "%s/%s", src, entry->d_name);
    snprintf(target_child, target_length, "%s/%s", dst, entry->d_name);
    if (move_path_exact(source_child, target_child, depth + 1)) rc = 1;
    free(source_child); free(target_child);
    if (rc) break;
  }
  closedir(directory);
  if (!rc && rmdir(src)) rc = errorf(src);
  return rc;
}

static int cmd_rm(int ac, char **av) {
  int recursive = 0, force = 0, options_terminated = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { options_terminated = 1; i++; break; }
    if (av[i][1] == '-') { fprintf(stderr, "rm: unsupported option: %s\n", av[i]); return 2; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'r' || *flag == 'R') recursive = 1;
      else if (*flag == 'f') force = 1;
      else { fprintf(stderr, "rm: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (i == ac) { fprintf(stderr, "rm: missing operand\n"); return 2; }
  for (int operand = i; !options_terminated && operand < ac; operand++) {
    if (av[operand][0] == '-' && av[operand][1]) {
      fprintf(stderr, "rm: unsupported option: %s\n", av[operand]); return 2;
    }
  }
  int operand_count = ac - i;
  if (operand_count > RM_OPERAND_LIMIT) {
    fprintf(stderr, "rm: too many operands (max %d)\n", RM_OPERAND_LIMIT); return 2;
  }
  size_t path_bytes = 0;
  for (int operand = i; operand < ac; operand++) {
    size_t length = strlen(av[operand]);
    if (!length) { fprintf(stderr, "rm: empty path operand\n"); return 2; }
    if (length > RM_PATH_LIMIT) {
      fprintf(stderr, "rm: path operand exceeds %d bytes\n", RM_PATH_LIMIT); return 2;
    }
    if (length > RM_PATH_TOTAL_LIMIT - path_bytes) {
      fprintf(stderr, "rm: path operands exceed %d bytes\n", RM_PATH_TOTAL_LIMIT); return 2;
    }
    path_bytes += length;
    if (!cp_path_component_limit(av[operand])) {
      fprintf(stderr, "rm: path has more than %d components\n", RM_COMPONENT_LIMIT); return 2;
    }
    if (rm_dot_operand(av[operand])) {
      fprintf(stderr, "rm: refusing '.' or '..' operand: %s\n", av[operand]); return 1;
    }
  }

  struct rm_plan plan = {0};
  plan.entries = calloc(RM_PLAN_LIMIT, sizeof *plan.entries);
  plan.slots = calloc(RM_PLAN_HASH_SIZE, sizeof *plan.slots);
  if (!plan.entries || !plan.slots) {
    errno = ENOMEM; errorf("deletion plan"); rm_plan_dispose(&plan); return 1;
  }
  int rc = 0;
  for (int operand = i; operand < ac; operand++) {
    char *physical = mv_canonical_entry_path(av[operand]);
    if (!physical) {
      if (errno == ELOOP || errno == ENAMETOOLONG) {
        fprintf(stderr, "rm: path resolution limit exceeded: %s\n", av[operand]);
        rc = 2; break;
      }
      int missing = errno == ENOENT;
      if (!missing || !force) errorf(av[operand]);
      if (!missing || !force) { rc = 1; break; }
      continue;
    }
    if (!strcmp(physical, "/")) {
      fprintf(stderr, "rm: refusing to remove root directory\n");
      free(physical); rc = 1; break;
    }
    rc = rm_plan_collect(&plan, physical, av[operand], recursive, force, 0);
    if (rc) break;
  }
  if (!rc) {
    qsort(plan.entries, (size_t)plan.count, sizeof *plan.entries, rm_plan_order);
    for (int index = 0; index < plan.count; index++) {
      struct rm_plan_entry *entry = &plan.entries[index];
      if ((entry->directory ? rmdir(entry->path) : unlink(entry->path))) {
        rc = errorf(entry->path); break;
      }
    }
  }
  rm_plan_dispose(&plan);
  return rc;
}

static int cmd_cp(int ac, char **av) {
  int recursive = 0, no_clobber = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "--recursive")) { recursive = 1; continue; }
    if (!strcmp(av[i], "--force")) { no_clobber = 0; continue; }
    if (!strcmp(av[i], "--no-clobber")) { no_clobber = 1; continue; }
    if (av[i][1] == '-') { fprintf(stderr, "cp: unsupported option: %s\n", av[i]); return 2; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'r' || *flag == 'R') recursive = 1;
      else if (*flag == 'f') no_clobber = 0;
      else if (*flag == 'n') no_clobber = 1;
      else if (*flag == 'a' || *flag == 'p') {
        fprintf(stderr, "cp: option -%c is unsupported because metadata preservation is unavailable\n", *flag);
        return 2;
      }
      else { fprintf(stderr, "cp: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (ac - i < 2) { fprintf(stderr, "cp: source and destination required\n"); return 1; }
  int source_count = ac - i - 1;
  if (source_count > CP_SOURCE_LIMIT) {
    fprintf(stderr, "cp: too many sources (max %d)\n", CP_SOURCE_LIMIT); return 2;
  }
  size_t path_bytes = 0;
  for (int operand = i; operand < ac; operand++) {
    size_t length = strlen(av[operand]);
    if (length > CP_PATH_LIMIT) {
      fprintf(stderr, "cp: path operand exceeds %d bytes\n", CP_PATH_LIMIT); return 2;
    }
    if (length > CP_PATH_TOTAL_LIMIT - path_bytes) {
      fprintf(stderr, "cp: path operands exceed %d bytes\n", CP_PATH_TOTAL_LIMIT); return 2;
    }
    path_bytes += length;
  }
  for (int operand = i; operand < ac; operand++) {
    if (!cp_path_component_limit(av[operand])) {
      fprintf(stderr, "cp: path has too many components\n"); return 1;
    }
  }

  const char *destination = av[ac - 1];
  int destination_is_dir = cp_destination_is_directory(destination);
  if (source_count > 1 && !destination_is_dir) {
    fprintf(stderr, "cp: destination must be a directory\n"); return 1;
  }

  struct cp_plan {
    const char *source;
    char *target;
    char *physical_source;
    char *physical_target;
    int directory;
  } plans[CP_SOURCE_LIMIT];
  memset(plans, 0, sizeof plans);
  int preflight_error = 0;
  for (int source_index = 0; source_index < source_count; source_index++) {
    struct cp_plan *plan = &plans[source_index];
    plan->source = av[i + source_index];
    plan->target = cp_effective_target(plan->source, destination, destination_is_dir);
    if (!plan->target) { errorf(destination); preflight_error = 1; break; }
    plan->physical_source = canonical_existing_path(plan->source);
    if (!plan->physical_source) { errorf(plan->source); preflight_error = 1; break; }
    struct stat source_status;
    if (stat(plan->physical_source, &source_status)) {
      errorf(plan->source); preflight_error = 1; break;
    }
    plan->directory = S_ISDIR(source_status.st_mode);
    if (plan->directory && !recursive) {
      fprintf(stderr, "cp: omitting directory '%s'\n", plan->source);
      preflight_error = 1; break;
    }
    plan->physical_target = cp_canonical_target_path(plan->target);
    if (!plan->physical_target) { errorf(plan->target); preflight_error = 1; break; }

    if (plan->directory && cp_path_within(plan->physical_source, plan->physical_target)) {
      fprintf(stderr, "cp: recursive destination is within source\n");
      preflight_error = 1; break;
    }
    struct stat target_status;
    if (stat(plan->physical_target, &target_status) == 0 &&
        target_status.st_dev == source_status.st_dev && target_status.st_ino == source_status.st_ino) {
      fprintf(stderr, "cp: '%s' and '%s' are the same file\n", plan->source, plan->target);
      preflight_error = 1; break;
    }
  }

  int rc = preflight_error;
  if (!preflight_error) {
    for (int plan_index = 0; plan_index < source_count; plan_index++) {
      if (copy_path_exact(
        plans[plan_index].physical_source,
        plans[plan_index].target,
        recursive,
        no_clobber,
        0
      )) rc = 1;
    }
  }
  for (int plan_index = 0; plan_index < source_count; plan_index++) {
    free(plans[plan_index].target);
    free(plans[plan_index].physical_source);
    free(plans[plan_index].physical_target);
  }
  return rc;
}

static int cmd_mv(int ac, char **av) {
  int i = 1, no_clobber = 0;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "--force")) { no_clobber = 0; continue; }
    if (!strcmp(av[i], "--no-clobber")) { no_clobber = 1; continue; }
    if (av[i][1] == '-') { fprintf(stderr, "mv: unsupported option: %s\n", av[i]); return 2; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'f') no_clobber = 0;
      else if (*flag == 'n') no_clobber = 1;
      else { fprintf(stderr, "mv: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (ac - i < 2) { fprintf(stderr, "mv: source and destination required\n"); return 1; }
  int source_count = ac - i - 1;
  if (source_count > MV_SOURCE_LIMIT) {
    fprintf(stderr, "mv: too many sources (max %d)\n", MV_SOURCE_LIMIT); return 2;
  }
  size_t path_bytes = 0;
  for (int operand = i; operand < ac; operand++) {
    size_t length = strlen(av[operand]);
    if (length > MV_PATH_LIMIT) {
      fprintf(stderr, "mv: path operand exceeds %d bytes\n", MV_PATH_LIMIT); return 2;
    }
    if (length > MV_PATH_TOTAL_LIMIT - path_bytes) {
      fprintf(stderr, "mv: path operands exceed %d bytes\n", MV_PATH_TOTAL_LIMIT); return 2;
    }
    path_bytes += length;
  }
  for (int operand = i; operand < ac; operand++) {
    if (!cp_path_component_limit(av[operand])) {
      fprintf(stderr, "mv: path has too many components\n"); return 1;
    }
  }

  const char *destination = av[ac - 1];
  char *physical_destination = mv_canonical_entry_path(destination);
  if (!physical_destination) return errorf(destination);
  struct stat destination_entry_status;
  int destination_exists = lstat(physical_destination, &destination_entry_status) == 0;
  if (!destination_exists && errno != ENOENT) {
    int rc = errorf(destination); free(physical_destination); return rc;
  }
  int destination_is_dir = 0;
  if (destination_exists) {
    char *resolved_destination = canonical_existing_path(destination);
    if (resolved_destination) {
      struct stat destination_status;
      if (stat(resolved_destination, &destination_status)) {
        int rc = errorf(destination);
        free(resolved_destination); free(physical_destination); return rc;
      }
      destination_is_dir = S_ISDIR(destination_status.st_mode);
      free(resolved_destination);
    } else if (!S_ISLNK(destination_entry_status.st_mode) || errno != ENOENT) {
      int rc = errorf(destination); free(physical_destination); return rc;
    }
  }
  free(physical_destination);
  if (source_count > 1 && !destination_is_dir) {
    fprintf(stderr, "mv: destination must be a directory\n"); return 1;
  }

  struct mv_plan {
    const char *source;
    char *target;
    char *physical_source;
    char *physical_target;
    struct stat source_status;
    struct stat target_status;
    int target_exists;
    int directory;
    int skip;
  } plans[MV_SOURCE_LIMIT];
  memset(plans, 0, sizeof plans);

  int preflight_error = 0;
  for (int source_index = 0; source_index < source_count; source_index++) {
    struct mv_plan *plan = &plans[source_index];
    plan->source = av[i + source_index];
    plan->target = cp_effective_target(plan->source, destination, destination_is_dir);
    if (!plan->target) { errorf(destination); preflight_error = 1; break; }
    plan->physical_source = mv_canonical_entry_path(plan->source);
    if (!plan->physical_source) { errorf(plan->source); preflight_error = 1; break; }
    if (lstat(plan->physical_source, &plan->source_status)) {
      errorf(plan->source); preflight_error = 1; break;
    }
    plan->directory = S_ISDIR(plan->source_status.st_mode);
    plan->physical_target = mv_canonical_entry_path(plan->target);
    if (!plan->physical_target) { errorf(plan->target); preflight_error = 1; break; }
    plan->target_exists = lstat(plan->physical_target, &plan->target_status) == 0;
    if (!plan->target_exists && errno != ENOENT) {
      errorf(plan->target); preflight_error = 1; break;
    }

    if (plan->directory && cp_path_within(plan->physical_source, plan->physical_target)) {
      fprintf(stderr, "mv: destination is within source\n");
      preflight_error = 1; break;
    }
    if (source_count > 1 && !strcmp(plan->physical_source, plan->physical_target)) {
      fprintf(stderr, "mv: source and target operands overlap\n");
      preflight_error = 1; break;
    }
    if (plan->target_exists &&
        plan->source_status.st_dev == plan->target_status.st_dev &&
        plan->source_status.st_ino == plan->target_status.st_ino) {
      plan->skip = 1;
    } else if (no_clobber && plan->target_exists) {
      plan->skip = 1;
    } else if (plan->target_exists &&
        (plan->directory != S_ISDIR(plan->target_status.st_mode))) {
      fprintf(stderr, "mv: incompatible source and target types\n");
      preflight_error = 1; break;
    }
  }

  if (!preflight_error) {
    for (int left = 0; left < source_count && !preflight_error; left++) {
      for (int right = left + 1; right < source_count; right++) {
        if (!strcmp(plans[left].physical_target, plans[right].physical_target)) {
          fprintf(stderr, "mv: multiple sources map to the same target\n");
          preflight_error = 1; break;
        }
        if ((plans[left].directory && cp_path_within(
              plans[left].physical_source, plans[right].physical_source)) ||
            (plans[right].directory && cp_path_within(
              plans[right].physical_source, plans[left].physical_source))) {
          fprintf(stderr, "mv: source operands overlap\n");
          preflight_error = 1; break;
        }
      }
    }
  }
  if (!preflight_error) {
    for (int target_index = 0; target_index < source_count && !preflight_error; target_index++) {
      for (int source_index = 0; source_index < source_count; source_index++) {
        if (target_index == source_index) continue;
        if (cp_path_within(plans[source_index].physical_source,
                           plans[target_index].physical_target) ||
            cp_path_within(plans[target_index].physical_target,
                           plans[source_index].physical_source)) {
          fprintf(stderr, "mv: source and target operands overlap\n");
          preflight_error = 1; break;
        }
      }
    }
  }

  int rc = preflight_error;
  if (!preflight_error) {
    for (int plan_index = 0; plan_index < source_count; plan_index++) {
      struct mv_plan *plan = &plans[plan_index];
      if (plan->skip) continue;
      if (move_path_exact(plan->physical_source, plan->physical_target, 0)) { rc = 1; break; }
    }
  }
  for (int plan_index = 0; plan_index < source_count; plan_index++) {
    free(plans[plan_index].target);
    free(plans[plan_index].physical_source);
    free(plans[plan_index].physical_target);
  }
  return rc;
}

static int mkdir_plan_contains(char **plans, int plan_count, const char *path) {
  for (int index = 0; index < plan_count; index++)
    if (!strcmp(plans[index], path)) return 1;
  return 0;
}

static int mkdir_has_remaining_component(const char *cursor) {
  while (*cursor) {
    while (*cursor == '/') cursor++;
    const char *start = cursor;
    while (*cursor && *cursor != '/') cursor++;
    if (cursor != start) return 1;
  }
  return 0;
}

static void mkdir_physical_parent(char *path) {
  if (!strcmp(path, "/")) return;
  char *slash = strrchr(path, '/');
  if (!slash || slash == path) strcpy(path, "/");
  else *slash = 0;
}

static char *mkdir_child_path(const char *parent, const char *name, size_t name_length) {
  size_t parent_length = strlen(parent);
  if (parent_length + name_length + 2 > CP_RESOLVED_PATH_LIMIT) {
    errno = ENAMETOOLONG; return NULL;
  }
  char *child = malloc(parent_length + name_length + 2);
  if (!child) { errno = ENOMEM; return NULL; }
  memcpy(child, parent, parent_length);
  size_t length = parent_length;
  if (length > 1) child[length++] = '/';
  memcpy(child + length, name, name_length);
  child[length + name_length] = 0;
  return child;
}

static int mkdir_plan_operand(
  const char *input,
  int parents,
  char **plans,
  int *plan_count
) {
  char *resolved = input[0] == '/' ? strdup("/") : canonical_existing_path(".");
  if (!resolved) return errorf(input);
  int links = 0, created = 0;
  const char *cursor = input;
  while (*cursor) {
    while (*cursor == '/') cursor++;
    const char *start = cursor;
    while (*cursor && *cursor != '/') cursor++;
    size_t component_length = (size_t)(cursor - start);
    if (!component_length || (component_length == 1 && start[0] == '.')) continue;
    if (component_length == 2 && start[0] == '.' && start[1] == '.') {
      mkdir_physical_parent(resolved); continue;
    }

    int has_remaining = mkdir_has_remaining_component(cursor);
    char *candidate = mkdir_child_path(resolved, start, component_length);
    if (!candidate) {
      int rc = errorf(input); free(resolved); return rc;
    }
    if (mkdir_plan_contains(plans, *plan_count, candidate)) {
      if (!parents && !has_remaining) {
        errno = EEXIST; errorf(input); free(candidate); free(resolved); return 1;
      }
      free(resolved); resolved = candidate; continue;
    }

    struct stat status;
    if (lstat(candidate, &status) == 0) {
      if (S_ISLNK(status.st_mode)) {
        if (!parents && !has_remaining) {
          errno = EEXIST; errorf(input); free(candidate); free(resolved); return 1;
        }
        char *physical = canonical_existing_path_counted(candidate, &links);
        if (!physical || stat(physical, &status)) {
          errorf(input); free(physical); free(candidate); free(resolved); return 1;
        }
        if (!S_ISDIR(status.st_mode)) {
          errno = ENOTDIR; errorf(input); free(physical); free(candidate); free(resolved); return 1;
        }
        free(candidate); free(resolved); resolved = physical; continue;
      }
      if (!S_ISDIR(status.st_mode)) {
        errno = has_remaining ? ENOTDIR : EEXIST;
        errorf(input); free(candidate); free(resolved); return 1;
      }
      if (!parents && !has_remaining) {
        errno = EEXIST; errorf(input); free(candidate); free(resolved); return 1;
      }
      free(resolved); resolved = candidate; continue;
    }
    if (errno != ENOENT) {
      errorf(input); free(candidate); free(resolved); return 1;
    }
    if (!parents && has_remaining) {
      errno = ENOENT; errorf(input); free(candidate); free(resolved); return 1;
    }
    if (*plan_count == MKDIR_CREATION_LIMIT) {
      fprintf(stderr, "mkdir: planned creations exceed %d\n", MKDIR_CREATION_LIMIT);
      free(candidate); free(resolved); return 2;
    }
    plans[(*plan_count)++] = candidate;
    char *next = strdup(candidate);
    if (!next) { errno = ENOMEM; errorf(input); free(resolved); return 1; }
    free(resolved); resolved = next; created = 1;
  }
  if (!parents && !created) {
    errno = EEXIST; errorf(input); free(resolved); return 1;
  }
  free(resolved); return 0;
}

static int cmd_mkdir(int ac, char **av) {
  int parents = 0, options_terminated = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { options_terminated = 1; i++; break; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'p') parents = 1;
      else { fprintf(stderr, "mkdir: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (i == ac) { fprintf(stderr, "mkdir: missing operand\n"); return 2; }
  for (int operand = i; !options_terminated && operand < ac; operand++) {
    if (av[operand][0] != '-' || !av[operand][1]) continue;
    fprintf(stderr, "mkdir: unsupported option: %s\n", av[operand]); return 2;
  }
  int operand_count = ac - i;
  if (operand_count > MKDIR_OPERAND_LIMIT) {
    fprintf(stderr, "mkdir: too many operands (max %d)\n", MKDIR_OPERAND_LIMIT); return 2;
  }
  size_t path_bytes = 0;
  for (int operand = i; operand < ac; operand++) {
    size_t length = strlen(av[operand]);
    if (!length) { fprintf(stderr, "mkdir: empty path operand\n"); return 2; }
    if (length > MKDIR_PATH_LIMIT) {
      fprintf(stderr, "mkdir: path operand exceeds %d bytes\n", MKDIR_PATH_LIMIT); return 2;
    }
    if (length > MKDIR_PATH_TOTAL_LIMIT - path_bytes) {
      fprintf(stderr, "mkdir: path operands exceed %d bytes\n", MKDIR_PATH_TOTAL_LIMIT); return 2;
    }
    path_bytes += length;
    if (!cp_path_component_limit(av[operand])) {
      fprintf(stderr, "mkdir: path has more than %d components\n", MKDIR_COMPONENT_LIMIT); return 2;
    }
  }

  char *plans[MKDIR_CREATION_LIMIT]; memset(plans, 0, sizeof plans);
  int plan_count = 0, rc = 0;
  for (int operand = i; operand < ac; operand++) {
    rc = mkdir_plan_operand(av[operand], parents, plans, &plan_count);
    if (rc) break;
  }
  if (!rc) {
    for (int plan_index = 0; plan_index < plan_count; plan_index++) {
      if (mkdir(plans[plan_index], 0777)) { rc = errorf(plans[plan_index]); break; }
    }
  }
  for (int plan_index = 0; plan_index < plan_count; plan_index++) free(plans[plan_index]);
  return rc;
}

static int cmd_rmdir(int ac, char **av) {
  struct rmdir_plan {
    char *physical;
    const char *display;
  } plans[RMDIR_OPERAND_LIMIT];
  memset(plans, 0, sizeof plans);

  int options_terminated = 0, i = 1;
  if (i < ac && !strcmp(av[i], "--")) { options_terminated = 1; i++; }
  else if (i < ac && av[i][0] == '-' && av[i][1]) {
    fprintf(stderr, "rmdir: unsupported option: %s\n", av[i]); return 2;
  }
  if (i == ac) { fprintf(stderr, "rmdir: missing operand\n"); return 2; }
  for (int operand = i; !options_terminated && operand < ac; operand++) {
    if (av[operand][0] == '-' && av[operand][1]) {
      fprintf(stderr, "rmdir: unsupported option: %s\n", av[operand]); return 2;
    }
  }

  int operand_count = ac - i;
  if (operand_count > RMDIR_OPERAND_LIMIT) {
    fprintf(stderr, "rmdir: too many operands (max %d)\n", RMDIR_OPERAND_LIMIT); return 2;
  }
  size_t path_bytes = 0;
  for (int operand = i; operand < ac; operand++) {
    size_t length = strlen(av[operand]);
    if (!length) { fprintf(stderr, "rmdir: empty path operand\n"); return 2; }
    if (length > RMDIR_PATH_LIMIT) {
      fprintf(stderr, "rmdir: path operand exceeds %d bytes\n", RMDIR_PATH_LIMIT); return 2;
    }
    if (length > RMDIR_PATH_TOTAL_LIMIT - path_bytes) {
      fprintf(stderr, "rmdir: path operands exceed %d bytes\n", RMDIR_PATH_TOTAL_LIMIT); return 2;
    }
    path_bytes += length;
    if (!cp_path_component_limit(av[operand])) {
      fprintf(stderr, "rmdir: path has more than %d components\n", RMDIR_COMPONENT_LIMIT); return 2;
    }
    if (rm_dot_operand(av[operand])) {
      fprintf(stderr, "rmdir: refusing '.' or '..' operand: %s\n", av[operand]); return 1;
    }
  }

  int plan_count = 0, rc = 0;
  for (int operand = i; operand < ac; operand++) {
    char *physical = mv_canonical_entry_path(av[operand]);
    if (!physical) {
      if (errno == ELOOP || errno == ENAMETOOLONG) {
        fprintf(stderr, "rmdir: path resolution limit exceeded: %s\n", av[operand]); rc = 2;
      } else rc = errorf(av[operand]);
      break;
    }
    if (!strcmp(physical, "/")) {
      fprintf(stderr, "rmdir: refusing to remove root directory\n");
      free(physical); rc = 1; break;
    }

    struct stat status;
    if (lstat(physical, &status)) {
      rc = errorf(av[operand]); free(physical); break;
    }
    if (!S_ISDIR(status.st_mode)) {
      errno = ENOTDIR; rc = errorf(av[operand]); free(physical); break;
    }
    int duplicate = 0;
    for (int plan_index = 0; plan_index < plan_count; plan_index++) {
      if (!strcmp(plans[plan_index].physical, physical)) { duplicate = 1; break; }
    }
    if (duplicate) {
      errno = ENOENT; rc = errorf(av[operand]); free(physical); break;
    }

    DIR *directory = opendir(physical);
    if (!directory) { rc = errorf(av[operand]); free(physical); break; }
    for (;;) {
      errno = 0;
      struct dirent *entry = readdir(directory);
      if (!entry) {
        if (errno) rc = errorf(av[operand]);
        break;
      }
      if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
      int removed_earlier = 0;
      size_t parent_length = strlen(physical);
      for (int plan_index = 0; plan_index < plan_count; plan_index++) {
        const char *planned = plans[plan_index].physical;
        if (parent_length == 1) {
          if (planned[0] == '/' && !strcmp(planned + 1, entry->d_name)) {
            removed_earlier = 1; break;
          }
        } else if (!strncmp(planned, physical, parent_length) &&
                   planned[parent_length] == '/' &&
                   !strcmp(planned + parent_length + 1, entry->d_name)) {
          removed_earlier = 1; break;
        }
      }
      if (!removed_earlier) {
        errno = ENOTEMPTY; rc = errorf(av[operand]); break;
      }
    }
    if (closedir(directory) && !rc) rc = errorf(av[operand]);
    if (rc) { free(physical); break; }
    plans[plan_count].physical = physical;
    plans[plan_count].display = av[operand];
    plan_count++;
  }

  if (!rc) {
    for (int plan_index = 0; plan_index < plan_count; plan_index++) {
      if (!rmdir(plans[plan_index].physical)) continue;
      int saved_errno = errno;
      errorf(plans[plan_index].display);
      for (int rollback = plan_index - 1; rollback >= 0; rollback--) {
        if (mkdir(plans[rollback].physical, 0777)) {
          fprintf(stderr, "rmdir: rollback failed: %s: %s\n",
                  plans[rollback].display, strerror(errno));
        }
      }
      errno = saved_errno; rc = 1; break;
    }
  }
  for (int plan_index = 0; plan_index < plan_count; plan_index++)
    free(plans[plan_index].physical);
  return rc;
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
  int no_create = 0, options_terminated = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { options_terminated = 1; i++; break; }
    if (av[i][1] == '-') { fprintf(stderr, "touch: unsupported option: %s\n", av[i]); return 2; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'c') no_create = 1;
      else { fprintf(stderr, "touch: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (i == ac) { fprintf(stderr, "touch: missing operand\n"); return 2; }
  for (int operand = i; !options_terminated && operand < ac; operand++) {
    if (av[operand][0] != '-' || !av[operand][1]) continue;
    if (av[operand][1] == '-') fprintf(stderr, "touch: unsupported option: %s\n", av[operand]);
    else fprintf(stderr, "touch: unsupported option: -%c\n", av[operand][1]);
    return 2;
  }
  int operand_count = ac - i;
  if (operand_count > TOUCH_OPERAND_LIMIT) {
    fprintf(stderr, "touch: too many operands (max %d)\n", TOUCH_OPERAND_LIMIT); return 2;
  }
  size_t path_bytes = 0;
  for (int operand = i; operand < ac; operand++) {
    size_t length = strlen(av[operand]);
    if (length > TOUCH_PATH_LIMIT) {
      fprintf(stderr, "touch: path operand exceeds %d bytes\n", TOUCH_PATH_LIMIT); return 2;
    }
    if (length > TOUCH_PATH_TOTAL_LIMIT - path_bytes) {
      fprintf(stderr, "touch: path operands exceed %d bytes\n", TOUCH_PATH_TOTAL_LIMIT); return 2;
    }
    path_bytes += length;
    if (!cp_path_component_limit(av[operand])) {
      fprintf(stderr, "touch: path has more than %d components\n", TOUCH_COMPONENT_LIMIT); return 2;
    }
  }

  int skip[TOUCH_OPERAND_LIMIT]; memset(skip, 0, sizeof skip);
  char *targets[TOUCH_OPERAND_LIMIT]; memset(targets, 0, sizeof targets);
  int preflight_error = 0;
  for (int operand = 0; operand < operand_count; operand++) {
    int exists = 0;
    char *physical = canonical_touch_target(av[i + operand], &exists);
    if (!physical) { errorf(av[i + operand]); preflight_error = 1; break; }
    targets[operand] = physical;
    if (exists) {
      struct stat status;
      if (stat(physical, &status)) {
        errorf(av[i + operand]); preflight_error = 1; break;
      }
      if (!S_ISREG(status.st_mode)) {
        errno = S_ISDIR(status.st_mode) ? EISDIR : EINVAL;
        errorf(av[i + operand]); preflight_error = 1; break;
      }
    } else if (no_create) skip[operand] = 1;
  }

  int rc = preflight_error;
  if (!preflight_error) {
    for (int operand = 0; operand < operand_count; operand++) {
      if (skip[operand]) continue;
      if (touch_one(targets[operand])) { rc = 1; break; }
    }
  }
  for (int operand = 0; operand < operand_count; operand++) free(targets[operand]);
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
  if (ac - i != 2) { fprintf(stderr, "ln: target and link name required\n"); return 2; }
  const char *target = av[i], *link_name = av[i + 1];
  if (strlen(target) > LN_PATH_LIMIT || strlen(link_name) > LN_PATH_LIMIT) {
    fprintf(stderr, "ln: path operand exceeds %d bytes\n", LN_PATH_LIMIT); return 2;
  }
  if (!cp_path_component_limit(link_name)) {
    fprintf(stderr, "ln: link path has more than %d components\n", LN_COMPONENT_LIMIT); return 2;
  }
  if (!symbolic) {
    fprintf(stderr, "ln: hard links are unsupported; use -s\n"); return 2;
  }
  size_t link_length = strlen(link_name);
  if (link_length && link_name[link_length - 1] == '/') {
    fprintf(stderr, "ln: link name must not end with '/'\n"); return 2;
  }

  char *physical_link = mv_canonical_entry_path(link_name);
  if (!physical_link) return errorf(link_name);
  struct stat destination_status;
  int destination_exists = lstat(physical_link, &destination_status) == 0;
  if (!destination_exists && errno != ENOENT) {
    int rc = errorf(link_name); free(physical_link); return rc;
  }
  if (destination_exists && !force) {
    errno = EEXIST; int rc = errorf(link_name); free(physical_link); return rc;
  }
  if (destination_exists && S_ISDIR(destination_status.st_mode)) {
    errno = EISDIR; int rc = errorf(link_name); free(physical_link); return rc;
  }
  if (destination_exists && unlink(physical_link)) {
    int rc = errorf(link_name); free(physical_link); return rc;
  }
  int rc = symlink(target, physical_link) ? errorf(link_name) : 0;
  free(physical_link); return rc;
}

static FILE *open_input(const char *name) { return !name || !strcmp(name, "-") ? stdin : fopen(name, "rb"); }

static int parse_long_value(const char *text, long *value) {
  char *end = NULL; errno = 0;
  long parsed = strtol(text, &end, 10);
  if (errno || !*text || *end) return 0;
  *value = parsed; return 1;
}

static int parse_head_zero_count(const char *text, long *value) {
  if (!text[0]) return 0;
  long parsed = 0;
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p < '0' || *p > '9') return 0;
    int digit = *p - '0';
    if (parsed > SORT_LINES / 10 ||
        (parsed == SORT_LINES / 10 && digit > SORT_LINES % 10)) return 0;
    parsed = parsed * 10 + digit;
  }
  *value = parsed; return 1;
}

static const char *head_input_name(const char *name) {
  return !strcmp(name, "-") ? "standard input" : name;
}

static int head_zero_stream(FILE *file, const char *name, long count,
                            size_t *total_examined, size_t *total_emitted) {
  if (count == 0) return 0;
  unsigned char chunk[COPY_BUF];
  size_t capacity = COPY_BUF, output_size = 0, examined = 0;
  size_t record_size = 0, records = 0;
  unsigned char *output = malloc(capacity);
  if (!output) return errorf(head_input_name(name));

  while (records < (size_t)count) {
    if (examined == DATA_LIMIT || *total_examined == HEAD_TOTAL_LIMIT) {
      int extra = fgetc(file);
      if (extra == EOF) {
        if (ferror(file)) {
          if (!errno) errno = EIO;
          int rc = errorf(head_input_name(name)); free(output); return rc;
        }
        break;
      }
      if (examined == DATA_LIMIT)
        fprintf(stderr, "head: %s: input exceeds 16777216 bytes\n", head_input_name(name));
      else
        fprintf(stderr, "head: %s: invocation input exceeds 67108864 bytes\n", head_input_name(name));
      free(output); return 1;
    }

    size_t wanted = sizeof chunk;
    if (wanted > DATA_LIMIT - examined) wanted = DATA_LIMIT - examined;
    if (wanted > HEAD_TOTAL_LIMIT - *total_examined)
      wanted = HEAD_TOTAL_LIMIT - *total_examined;
    size_t got = fread(chunk, 1, wanted, file);
    if (ferror(file)) {
      if (!errno) errno = EIO;
      int rc = errorf(head_input_name(name)); free(output); return rc;
    }
    if (!got) break;

    for (size_t offset = 0; offset < got && records < (size_t)count; offset++) {
      unsigned char byte = chunk[offset];
      examined++; (*total_examined)++; record_size++;
      if (record_size > RECORD_LIMIT) {
        fprintf(stderr, "head: %s: NUL record exceeds 1048576 bytes\n", head_input_name(name));
        free(output); return 1;
      }
      if (output_size == capacity) {
        size_t next = capacity * 2;
        if (next > DATA_LIMIT) next = DATA_LIMIT;
        unsigned char *grown = realloc(output, next);
        if (!grown) { free(output); return errorf(head_input_name(name)); }
        output = grown; capacity = next;
      }
      output[output_size++] = byte;
      if (byte == 0) { records++; record_size = 0; }
    }
  }

  if (output_size > DATA_LIMIT || output_size > HEAD_TOTAL_LIMIT - *total_emitted) {
    fprintf(stderr, "head: %s: output exceeds bounded limits\n", head_input_name(name));
    free(output); return 1;
  }
  if (output_size && fwrite(output, 1, output_size, stdout) != output_size) {
    fputs("head: write error\n", stderr); free(output); return 1;
  }
  *total_emitted += output_size;
  free(output); return 0;
}

static int cmd_head(int ac, char **av) {
  long count = 10, byte_count = -1; int i = 1, zero_terminated = 0, option_terminator = 0;
  const char *line_count_text = NULL, *zero_unsupported_count_form = NULL;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; option_terminator = 1; break; }
    const char *option = av[i];
    const char *line_value = NULL, *bytes_value = NULL;
    if (!strcmp(av[i], "-z") || !strcmp(av[i], "--zero-terminated")) {
      zero_terminated = 1; i++;
    } else if ((!strcmp(av[i], "-n") || !strcmp(av[i], "--lines")) && i + 1 < ac) {
      if (!strcmp(av[i], "--lines")) zero_unsupported_count_form = option;
      line_value = av[i + 1]; i += 2;
    } else if ((!strcmp(av[i], "-c") || !strcmp(av[i], "--bytes")) && i + 1 < ac) {
      bytes_value = av[i + 1]; i += 2;
    } else if (!strncmp(av[i], "--lines=", 8)) {
      zero_unsupported_count_form = option; line_value = av[i++] + 8;
    }
    else if (!strncmp(av[i], "--bytes=", 8)) { bytes_value = av[i++] + 8; }
    else if (!strncmp(av[i], "-c", 2) && av[i][2]) { bytes_value = av[i++] + 2; }
    else if (!strncmp(av[i], "-n", 2) && av[i][2]) { line_value = av[i++] + 2; }
    else if (isdigit((unsigned char)av[i][1])) {
      zero_unsupported_count_form = option; line_value = av[i++] + 1;
    }
    else { fprintf(stderr, "head: unsupported option: %s\n", av[i]); return 2; }
    if ((line_value && (!parse_long_value(line_value, &count) || count < 0)) ||
        (bytes_value && (!parse_long_value(bytes_value, &byte_count) || byte_count < 0))) {
      fprintf(stderr, "head: invalid count: %s\n", line_value ? line_value : bytes_value); return 2;
    }
    if (line_value) line_count_text = line_value;
  }
  if (zero_terminated && byte_count >= 0) {
    fputs("head: -z is incompatible with -c\n", stderr); return 2;
  }
  if (zero_terminated && zero_unsupported_count_form) {
    fprintf(stderr, "head: unsupported option in zero mode: %s\n", zero_unsupported_count_form); return 2;
  }
  if (zero_terminated && line_count_text && !parse_head_zero_count(line_count_text, &count)) {
    fprintf(stderr, "head: invalid count: %s\n", line_count_text); return 2;
  }
  if (zero_terminated && !option_terminator) {
    for (int operand = i; operand < ac; operand++) {
      long ignored;
      if (av[operand][0] == '+' && parse_long_value(av[operand] + 1, &ignored)) {
        fprintf(stderr, "head: unsupported count: %s\n", av[operand]); return 2;
      }
    }
  }
  int input_count = i == ac ? 1 : ac - i;
  if (zero_terminated && input_count > HEAD_INPUT_LIMIT) {
    fputs("head: too many input files (max 100)\n", stderr); return 2;
  }
  int rc = 0; size_t total_examined = 0, total_emitted = 0;
  for (int input = 0; input < input_count; input++) {
    const char *name = i == ac ? "-" : av[i + input];
    FILE *f = open_input(name); if (!f) { rc = errorf(name); continue; }
    if (zero_terminated) {
      if (head_zero_stream(f, name, count, &total_examined, &total_emitted)) rc = 1;
      if (f != stdin) fclose(f);
      continue;
    }
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

/* Return 1 on success, 0 when DATA_LIMIT is exceeded, and -1 on I/O/allocation
 * failure. The extra byte probe makes the exact advertised limit usable. */
static int read_bounded_all(FILE *f, char **output, size_t *size) {
  size_t cap = 65536, n = 0; char *data = malloc(cap + 1);
  if (!data) return -1;
  while (n < DATA_LIMIT) {
    if (n == cap) {
      size_t next = cap * 2;
      if (next > DATA_LIMIT) next = DATA_LIMIT;
      char *grown = realloc(data, next + 1);
      if (!grown) { free(data); return -1; }
      data = grown; cap = next;
    }
    size_t got = fread(data + n, 1, cap - n, f); n += got;
    if (!got) break;
  }
  if (ferror(f)) { if (!errno) errno = EIO; free(data); return -1; }
  if (n == DATA_LIMIT) {
    int extra = fgetc(f);
    if (extra != EOF) { free(data); return 0; }
    if (ferror(f)) { if (!errno) errno = EIO; free(data); return -1; }
  }
  data[n] = 0; *output = data; *size = n; return 1;
}

static int tail_parse_byte_count(const char *text, size_t *result) {
  if (!*text) return 0;
  size_t value = 0;
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (!isdigit(*p)) return 0;
    size_t digit = (size_t)(*p - '0');
    if (value > ((size_t)DATA_LIMIT - digit) / 10) return 0;
    value = value * 10 + digit;
  }
  *result = value; return 1;
}

static int tail_bytes(FILE *file, size_t count, const char *name) {
  unsigned char *ring = count ? malloc(count) : NULL;
  if (count && !ring) return errorf(name);
  unsigned char chunk[COPY_BUF]; size_t stored = 0, start = 0;
  for (;;) {
    size_t got = fread(chunk, 1, sizeof chunk, file), offset = 0;
    while (count && offset < got) {
      if (stored < count) {
        size_t take = count - stored;
        if (take > got - offset) take = got - offset;
        memcpy(ring + stored, chunk + offset, take);
        stored += take; offset += take;
      } else {
        size_t take = count - start;
        if (take > got - offset) take = got - offset;
        memcpy(ring + start, chunk + offset, take);
        start = (start + take) % count; offset += take;
      }
    }
    if (ferror(file)) {
      if (!errno) errno = EIO;
      free(ring); return errorf(name);
    }
    if (!got) break;
  }
  int rc = 0;
  if (stored < count) {
    if (stored && fwrite(ring, 1, stored, stdout) != stored) rc = 1;
  } else if (stored) {
    size_t first = count - start;
    if ((first && fwrite(ring + start, 1, first, stdout) != first) ||
        (start && fwrite(ring, 1, start, stdout) != start)) rc = 1;
  }
  if (ferror(stdout)) rc = 1;
  free(ring); return rc;
}

static int cmd_tail(int ac, char **av) {
  long count = 10; size_t byte_count = 0; int byte_mode = 0, from_start = 0, i = 1;
  const char *count_value = NULL, *byte_value = NULL;
  if (i < ac && !strcmp(av[i], "--")) {
    i++;
  } else if (i < ac && !strcmp(av[i], "-c")) {
    byte_mode = 1;
    if (i + 1 < ac) { byte_value = av[i + 1]; i += 2; }
    else { byte_value = ""; i++; }
  } else if (i < ac && !strncmp(av[i], "-c", 2)) {
    byte_mode = 1; byte_value = av[i] + 2; i++;
  } else if (i < ac && (!strcmp(av[i], "-n") || !strcmp(av[i], "--lines")) && i + 1 < ac) {
    count_value = av[i + 1]; i += 2;
  } else if (i < ac && !strncmp(av[i], "--lines=", 8)) {
    count_value = av[i] + 8; i++;
  } else if (i < ac && !strncmp(av[i], "-n", 2) && av[i][2]) {
    count_value = av[i] + 2; i++;
  } else if (i < ac && av[i][0] == '-') {
    fprintf(stderr, "tail: unsupported option: %s\n", av[i]); return 2;
  }
  if (byte_mode) {
    if (!tail_parse_byte_count(byte_value, &byte_count)) {
      fprintf(stderr, "tail: invalid count: %s\n", byte_value); return 2;
    }
  } else if (count_value) {
    from_start = count_value[0] == '+';
    if (!parse_long_value(count_value, &count)) {
      fprintf(stderr, "tail: invalid count: %s\n", count_value); return 2;
    }
  }
  if (i < ac && !strcmp(av[i], "--")) i++;
  if (ac - i > 1) { fprintf(stderr, "tail: only one input file is supported\n"); return 2; }
  if (count == LONG_MIN) { fprintf(stderr, "tail: count is too large\n"); return 2; }
  if (count < 0) count = -count;
  const char *name = i < ac ? av[i] : "-"; FILE *f = open_input(name);
  if (!f) return errorf(name);
  if (byte_mode) {
    int rc = tail_bytes(f, byte_count, name);
    if (f != stdin) fclose(f);
    return rc;
  }
  size_t n; char *data = read_all(f, &n); if (f != stdin) fclose(f);
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

typedef struct { unsigned long long lines, words, bytes; } wc_counts;

static int wc_stream(FILE *f, wc_counts *counts) {
  int ch, inword = 0;
  memset(counts, 0, sizeof *counts);
  while ((ch = fgetc(f)) != EOF) {
    counts->bytes++;
    if (ch == '\n') counts->lines++;
    if (isspace((unsigned char)ch)) inword = 0;
    else if (!inword) { inword = 1; counts->words++; }
  }
  return ferror(f) ? 1 : 0;
}

static void wc_print(const wc_counts *counts, int show_l, int show_w, int show_c,
                     const char *name) {
  int field = 0;
  if (show_l) { printf("%llu", counts->lines); field = 1; }
  if (show_w) { printf("%s%llu", field ? " " : "", counts->words); field = 1; }
  if (show_c) { printf("%s%llu", field ? " " : "", counts->bytes); field = 1; }
  if (name) printf("%s%s", field ? " " : "", name);
  putchar('\n');
}

static int cmd_wc(int ac, char **av) {
  int show_l = 0, show_w = 0, show_c = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "--lines")) { show_l = 1; continue; }
    if (!strcmp(av[i], "--words")) { show_w = 1; continue; }
    if (!strcmp(av[i], "--bytes")) { show_c = 1; continue; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'l') show_l = 1;
      else if (*flag == 'w') show_w = 1;
      else if (*flag == 'c') show_c = 1;
      else { fprintf(stderr, "wc: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (!show_l && !show_w && !show_c) show_l = show_w = show_c = 1;
  if (i == ac) {
    wc_counts counts;
    if (wc_stream(stdin, &counts)) return errorf("-");
    wc_print(&counts, show_l, show_w, show_c, NULL);
    return 0;
  }
  int operands = ac - i, rc = 0; wc_counts total = {0, 0, 0};
  for (; i < ac; i++) {
    const char *name = av[i]; FILE *f = open_input(name);
    if (!f) { errorf(name); rc = 1; continue; }
    wc_counts counts;
    if (wc_stream(f, &counts)) {
      if (!errno) errno = EIO;
      errorf(name); rc = 1; if (f != stdin) fclose(f); continue;
    }
    if (f != stdin) fclose(f);
    wc_print(&counts, show_l, show_w, show_c,
             operands > 1 || strcmp(name, "-") ? name : NULL);
    if (ULLONG_MAX - total.lines < counts.lines ||
        ULLONG_MAX - total.words < counts.words ||
        ULLONG_MAX - total.bytes < counts.bytes) {
      fprintf(stderr, "wc: total count overflow\n"); return 1;
    }
    total.lines += counts.lines; total.words += counts.words; total.bytes += counts.bytes;
  }
  if (operands > 1) wc_print(&total, show_l, show_w, show_c, "total");
  return rc;
}

typedef struct {
  unsigned char *data;
  size_t length;
  const unsigned char *key;
  size_t key_length;
  double number;
} sort_record;

static int reverse_sort, numeric_sort, sort_key_field, sort_separator_set;
static unsigned char sort_separator;

static int sort_bytes_compare(const unsigned char *left, size_t left_length,
                              const unsigned char *right, size_t right_length) {
  size_t common = left_length < right_length ? left_length : right_length;
  int compared = common ? memcmp(left, right, common) : 0;
  if (compared) return compared < 0 ? -1 : 1;
  return left_length < right_length ? -1 : left_length > right_length ? 1 : 0;
}

static void sort_key_slice(const sort_record *record,
                           const unsigned char **start, size_t *length) {
  if (!sort_key_field) { *start = record->data; *length = record->length; return; }
  size_t begin = 0, end; int field = 1;
  if (sort_separator_set) {
    while (field < sort_key_field) {
      while (begin < record->length && record->data[begin] != sort_separator) begin++;
      if (begin == record->length) break;
      begin++; field++;
    }
    if (field < sort_key_field) begin = record->length;
    end = begin;
    while (end < record->length && record->data[end] != sort_separator) end++;
  } else {
    while (begin < record->length &&
           (record->data[begin] == ' ' || record->data[begin] == '\t')) begin++;
    while (begin < record->length && field < sort_key_field) {
      while (begin < record->length &&
             record->data[begin] != ' ' && record->data[begin] != '\t') begin++;
      while (begin < record->length &&
             (record->data[begin] == ' ' || record->data[begin] == '\t')) begin++;
      field++;
    }
    end = begin;
    while (end < record->length && record->data[end] != ' ' && record->data[end] != '\t') end++;
  }
  *start = record->data + begin; *length = end - begin;
}

static void sort_prepare_record(sort_record *record) {
  sort_key_slice(record, &record->key, &record->key_length);
  if (!numeric_sort) return;
  unsigned char *end = (unsigned char *)record->key + record->key_length;
  unsigned char saved = *end; *end = 0;
  record->number = strtod((const char *)record->key, NULL);
  *end = saved;
}

static int sort_record_compare(const void *a, const void *b) {
  const sort_record *left = a, *right = b; int compared;
  if (numeric_sort) {
    compared = left->number < right->number ? -1 : left->number > right->number ? 1 :
      sort_bytes_compare(left->data, left->length, right->data, right->length);
  } else if (sort_key_field) {
    compared = sort_bytes_compare(left->key, left->key_length, right->key, right->key_length);
    if (!compared)
      compared = sort_bytes_compare(left->data, left->length, right->data, right->length);
  } else compared = sort_bytes_compare(left->data, left->length, right->data, right->length);
  return reverse_sort ? -compared : compared;
}

static int parse_sort_field(const char **cursor, int *field) {
  const unsigned char *p = (const unsigned char *)*cursor;
  if (*p < '0' || *p > '9') return 0;
  int parsed = 0;
  do {
    int digit = *p++ - '0';
    if (parsed > 100 || (parsed == 100 && digit > 0)) return 0;
    parsed = parsed * 10 + digit;
  } while (*p >= '0' && *p <= '9');
  if (parsed < 1) return 0;
  *field = parsed; *cursor = (const char *)p; return 1;
}

static int parse_sort_key(const char *value) {
  const char *cursor = value; int first, last;
  if (!parse_sort_field(&cursor, &first)) return 0;
  if (*cursor == ',') {
    cursor++;
    if (!parse_sort_field(&cursor, &last) || last != first) return 0;
  }
  if (*cursor == 'n') { numeric_sort = 1; cursor++; }
  if (*cursor) return 0;
  sort_key_field = first; return 1;
}

static int split_sort_records(char *data, size_t size, sort_record *records,
                              size_t *record_count, unsigned char terminator) {
  size_t count = 0, start = 0;
  while (start < size) {
    if (count >= SORT_LINES) {
      fprintf(stderr, "sort: too many records (limit %d)\n", SORT_LINES); return 2;
    }
    size_t end = start;
    while (end < size && (unsigned char)data[end] != terminator) end++;
    size_t length = end - start;
    if (length > RECORD_LIMIT) {
      fprintf(stderr, "sort: record exceeds %d bytes\n", RECORD_LIMIT); return 2;
    }
    records[count++] = (sort_record){(unsigned char *)data + start, length, NULL, 0, 0};
    start = end < size ? end + 1 : size;
  }
  *record_count = count; return 0;
}

static int sort_records_equal(const sort_record *left, const sort_record *right) {
  return left->length == right->length &&
    (!left->length || !memcmp(left->data, right->data, left->length));
}

static int cmd_sort(int ac, char **av) {
  int unique = 0, zero = 0, key_seen = 0, separator_seen = 0, i = 1;
  const char *separator_value = NULL;
  reverse_sort = numeric_sort = sort_key_field = sort_separator_set = 0;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    const char *key = NULL, *separator = NULL;
    if (!strcmp(av[i], "-k") || !strcmp(av[i], "--key")) {
      if (i + 1 >= ac) { fprintf(stderr, "sort: %s requires a key\n", av[i]); return 2; }
      key = av[++i];
    } else if (!strncmp(av[i], "-k", 2) && av[i][2]) key = av[i] + 2;
    else if (!strncmp(av[i], "--key=", 6)) key = av[i] + 6;
    else if (!strcmp(av[i], "-t")) {
      if (i + 1 >= ac) { fputs("sort: -t requires a field separator\n", stderr); return 2; }
      separator = av[++i];
    } else if (!strncmp(av[i], "-t", 2) && av[i][2]) separator = av[i] + 2;
    else if (!strncmp(av[i], "--field-separator=", 18)) separator = av[i] + 18;
    if (key) {
      if (key_seen || !parse_sort_key(key)) {
        fprintf(stderr, "sort: key must be FIELD or FIELD,FIELD with equal fields and optional n\n"); return 2;
      }
      key_seen = 1; continue;
    }
    if (separator) {
      if (separator_seen) { fputs("sort: field separator may be specified only once\n", stderr); return 2; }
      separator_seen = 1; separator_value = separator; continue;
    }
    if (av[i][1] == '-') { fprintf(stderr, "sort: unsupported option: %s\n", av[i]); return 2; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'r') reverse_sort = 1;
      else if (*flag == 'u') unique = 1;
      else if (*flag == 'n') numeric_sort = 1;
      else if (*flag == 'z') zero = 1;
      else { fprintf(stderr, "sort: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (separator_seen) {
    if (strlen(separator_value) != 1 || (!zero && separator_value[0] == '\n')) {
      fputs("sort: field separator must be one non-NUL byte other than the record terminator\n", stderr);
      return 2;
    }
    sort_separator_set = 1; sort_separator = (unsigned char)separator_value[0];
  }
  if (ac - i > 1) { fprintf(stderr, "sort: only one input file is supported\n"); return 2; }
  const char *name = i < ac ? av[i] : "-"; FILE *f = open_input(name); if (!f) return errorf(name);
  size_t n; char *data = NULL; int loaded = read_bounded_all(f, &data, &n);
  if (f != stdin) fclose(f);
  if (loaded < 0) return errorf(name);
  if (!loaded) { fprintf(stderr, "sort: input exceeds %d bytes\n", DATA_LIMIT); return 2; }
  sort_record *records = malloc(SORT_LINES * sizeof *records);
  if (!records) { free(data); return 1; }
  size_t record_count = 0;
  int split = split_sort_records(data, n, records, &record_count, zero ? 0 : '\n');
  if (split) { free(records); free(data); return split; }
  for (size_t index = 0; index < record_count; index++) sort_prepare_record(&records[index]);
  qsort(records, record_count, sizeof *records, sort_record_compare);
  int rc = 0;
  for (size_t index = 0; index < record_count; index++) {
    if (unique && index && sort_records_equal(&records[index], &records[index - 1])) continue;
    if ((records[index].length &&
         fwrite(records[index].data, 1, records[index].length, stdout) != records[index].length) ||
        putchar(zero ? 0 : '\n') == EOF) { rc = 1; break; }
  }
  free(records); free(data); return rc || ferror(stdout) ? 1 : 0;
}

typedef struct { size_t first, last; } cut_range;

static int parse_cut_ranges(const char *value, cut_range *ranges, int *count) {
  *count = 0; const char *p = value;
  while (*p) {
    if (*count >= 64) return 0;
    size_t first, last; char *end = NULL;
    if (*p == '-') {
      first = 1; p++; if (!isdigit((unsigned char)*p)) return 0;
      unsigned long parsed = strtoul(p, &end, 10); if (parsed < 1 || parsed > 1000000) return 0;
      last = (size_t)parsed; p = end;
    } else {
      if (!isdigit((unsigned char)*p)) return 0;
      unsigned long parsed = strtoul(p, &end, 10); if (parsed < 1 || parsed > 1000000) return 0;
      first = last = (size_t)parsed; p = end;
      if (*p == '-') {
        p++;
        if (isdigit((unsigned char)*p)) {
          parsed = strtoul(p, &end, 10); if (parsed < first || parsed > 1000000) return 0;
          last = (size_t)parsed; p = end;
        } else last = (size_t)-1;
      }
    }
    ranges[(*count)++] = (cut_range){first, last};
    if (!*p) break;
    if (*p++ != ',' || !*p) return 0;
  }
  return *count > 0;
}

static int cut_position_selected(size_t position, const cut_range *ranges, int count) {
  for (int i = 0; i < count; i++)
    if (position >= ranges[i].first && position <= ranges[i].last) return 1;
  return 0;
}

static size_t utf8_character_size(const unsigned char *text, size_t remaining) {
  unsigned char first = text[0]; size_t size =
    first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 :
    first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
  if (size > remaining) return 1;
  for (size_t i = 1; i < size; i++) if ((text[i] & 0xc0) != 0x80) return 1;
  if ((first == 0xe0 && text[1] < 0xa0) || (first == 0xed && text[1] >= 0xa0) ||
      (first == 0xf0 && text[1] < 0x90) || (first == 0xf4 && text[1] >= 0x90)) return 1;
  return size;
}

static int cut_parse_zero_field(const char *value, size_t *field) {
  if (!*value) return 0;
  size_t parsed = 0;
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (!isdigit(*p)) return 0;
    size_t digit = (size_t)(*p - '0');
    if (parsed > ((size_t)RECORD_LIMIT + 1 - digit) / 10) return 0;
    parsed = parsed * 10 + digit;
  }
  if (parsed < 1 || parsed > (size_t)RECORD_LIMIT + 1) return 0;
  *field = parsed; return 1;
}

static void cut_zero_field(const unsigned char *record, size_t length,
                           unsigned char delimiter, size_t field,
                           const unsigned char **selected, size_t *selected_length) {
  if (!memchr(record, delimiter, length)) {
    *selected = record; *selected_length = length; return;
  }
  const unsigned char *start = record, *end = record + length;
  size_t current = 1;
  for (const unsigned char *p = record; p < end; p++) {
    if (*p != delimiter) continue;
    if (current == field) {
      *selected = start; *selected_length = (size_t)(p - start); return;
    }
    current++; start = p + 1;
  }
  if (current == field) {
    *selected = start; *selected_length = (size_t)(end - start); return;
  }
  *selected = end; *selected_length = 0;
}

static int cut_zero_records(FILE *file, const char *name, unsigned char delimiter,
                            size_t field) {
  char *input = NULL; size_t input_size = 0;
  int loaded = read_bounded_all(file, &input, &input_size);
  int saved_errno = errno;
  if (file != stdin) fclose(file);
  errno = saved_errno;
  if (!loaded) {
    fprintf(stderr, "cut: input exceeds 16777216 bytes\n"); return 1;
  }
  if (loaded < 0) return errorf(name);

  const unsigned char *bytes = (const unsigned char *)input;
  size_t record_start = 0, records = 0, output_size = 0;
  for (size_t offset = 0; offset <= input_size; offset++) {
    int terminated = offset < input_size && bytes[offset] == 0;
    if (!terminated && offset != input_size) continue;
    if (offset == input_size && record_start == input_size) break;
    size_t record_length = offset - record_start;
    if (++records > SORT_LINES) {
      fprintf(stderr, "cut: more than 100000 NUL records\n"); free(input); return 1;
    }
    if (record_length > RECORD_LIMIT) {
      fprintf(stderr, "cut: NUL record exceeds 1048576 bytes\n"); free(input); return 1;
    }
    const unsigned char *selected; size_t selected_length;
    cut_zero_field(bytes + record_start, record_length, delimiter, field,
                   &selected, &selected_length);
    (void)selected;
    if (selected_length + 1 > DATA_LIMIT - output_size) {
      fprintf(stderr, "cut: output exceeds 16777216 bytes\n"); free(input); return 1;
    }
    output_size += selected_length + 1;
    record_start = offset + 1;
  }

  unsigned char *output = output_size ? malloc(output_size) : NULL;
  if (output_size && !output) { free(input); errno = ENOMEM; return errorf(name); }
  record_start = 0; size_t output_offset = 0;
  for (size_t offset = 0; offset <= input_size; offset++) {
    int terminated = offset < input_size && bytes[offset] == 0;
    if (!terminated && offset != input_size) continue;
    if (offset == input_size && record_start == input_size) break;
    const unsigned char *selected; size_t selected_length;
    cut_zero_field(bytes + record_start, offset - record_start, delimiter, field,
                   &selected, &selected_length);
    if (selected_length) memcpy(output + output_offset, selected, selected_length);
    output_offset += selected_length; output[output_offset++] = 0;
    record_start = offset + 1;
  }
  int rc = 0;
  if (output_size && fwrite(output, 1, output_size, stdout) != output_size) rc = 1;
  if (ferror(stdout)) rc = 1;
  free(output); free(input); return rc;
}

static int cmd_cut(int ac, char **av) {
  char delim = '\t'; const char *delimiter = NULL, *field_value = NULL, *character_value = NULL;
  int zero_terminated = 0, i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "-z") || !strcmp(av[i], "--zero-terminated")) {
      zero_terminated = 1; i++;
    } else if (!strcmp(av[i], "-d") || !strcmp(av[i], "--delimiter")) {
      if (i + 1 >= ac) { fprintf(stderr, "cut: %s requires a delimiter\n", av[i]); return 2; }
      delimiter = av[i + 1]; i += 2;
    } else if (!strncmp(av[i], "--delimiter=", 12)) { delimiter = av[i] + 12; i++; }
    else if (!strncmp(av[i], "-d", 2) && av[i][2]) { delimiter = av[i] + 2; i++; }
    else if (!strcmp(av[i], "-f") || !strcmp(av[i], "--fields")) {
      if (i + 1 >= ac) { fprintf(stderr, "cut: %s requires a field\n", av[i]); return 2; }
      field_value = av[i + 1]; i += 2;
    } else if (!strncmp(av[i], "--fields=", 9)) { field_value = av[i] + 9; i++; }
    else if (!strncmp(av[i], "-f", 2) && av[i][2]) { field_value = av[i] + 2; i++; }
    else if (!strcmp(av[i], "-c") || !strcmp(av[i], "--characters")) {
      if (i + 1 >= ac) { fprintf(stderr, "cut: %s requires a list\n", av[i]); return 2; }
      character_value = av[i + 1]; i += 2;
    } else if (!strncmp(av[i], "--characters=", 13)) { character_value = av[i] + 13; i++; }
    else if (!strncmp(av[i], "-c", 2) && av[i][2]) { character_value = av[i] + 2; i++; }
    else { fprintf(stderr, "cut: unsupported option: %s\n", av[i]); return 2; }
  }
  if (zero_terminated && ac - i > 1) {
    fprintf(stderr, "cut: only one input file is supported\n"); return 2;
  }
  if ((field_value != NULL) == (character_value != NULL)) {
    fprintf(stderr, "cut: exactly one of -f or -c is required\n"); return 2;
  }
  if (zero_terminated && character_value) {
    fprintf(stderr, "cut: -z supports field mode only\n"); return 2;
  }
  if (zero_terminated) {
    size_t field = 0;
    if (!cut_parse_zero_field(field_value, &field)) {
      fprintf(stderr, "cut: field must be an integer from 1 through 1048577\n"); return 2;
    }
    if (delimiter && (strlen(delimiter) != 1 || !delimiter[0])) {
      fprintf(stderr, "cut: delimiter must be one non-NUL byte\n"); return 2;
    }
    if (delimiter) delim = delimiter[0];
    const char *name = i < ac ? av[i] : "-";
    FILE *f = open_input(name); if (!f) return errorf(name);
    return cut_zero_records(f, name, (unsigned char)delim, field);
  }
  if (delimiter && character_value) { fprintf(stderr, "cut: a delimiter applies only to fields\n"); return 2; }
  if (delimiter) {
    if (strlen(delimiter) != 1) { fprintf(stderr, "cut: delimiter must be one byte\n"); return 2; }
    delim = delimiter[0];
  }
  int field = 0; cut_range ranges[64]; int range_count = 0;
  if (field_value) {
    char *end = NULL; long parsed = strtol(field_value, &end, 10);
    if (!*field_value || *end || parsed < 1 || parsed > 1000000) {
      fprintf(stderr, "cut: field must be a positive integer\n"); return 2;
    }
    field = (int)parsed;
  } else if (!parse_cut_ranges(character_value, ranges, &range_count)) {
    fprintf(stderr, "cut: character list must contain N, N-M, -M, or N- ranges\n"); return 2;
  }
  if (ac - i > 1) { fprintf(stderr, "cut: only one input file is supported\n"); return 2; }
  const char *name = i < ac ? av[i] : "-"; FILE *f = open_input(name); if (!f) return errorf(name);
  char line[65536];
  while (fgets(line, sizeof line, f)) {
    size_t length = strlen(line); int newline = length > 0 && line[length - 1] == '\n';
    size_t content = length - (size_t)newline;
    if (character_value) {
      size_t offset = 0, position = 1;
      while (offset < content) {
        size_t character = utf8_character_size((unsigned char *)line + offset, content - offset);
        if (cut_position_selected(position, ranges, range_count)) fwrite(line + offset, 1, character, stdout);
        offset += character; position++;
      }
    } else {
      char *first_delimiter = memchr(line, delim, content);
      if (!first_delimiter) fwrite(line, 1, content, stdout);
      else {
        char *p = line, *start = p, *end = line + content; int current = 1;
        while (p < end && current < field) if (*p++ == delim) { current++; start = p; }
        if (current == field) { p = start; while (p < end && *p != delim) p++; fwrite(start, 1, (size_t)(p - start), stdout); }
      }
    }
    if (newline) putchar('\n');
  }
  int rc = 0;
  if (ferror(f)) { if (!errno) errno = EIO; rc = errorf(name); }
  else if (ferror(stdout)) rc = 1;
  if (f != stdin) fclose(f); return rc;
}

typedef struct { const unsigned char *data; size_t length; } paste_record;
typedef struct {
  char *data; paste_record *records; size_t count; size_t cursor;
} paste_input;
typedef struct { const unsigned char *data; size_t length; } paste_delimiter;

static const char *paste_input_name(const char *name) {
  return !strcmp(name, "-") ? "standard input" : name;
}

static void paste_usage(FILE *stream) {
  fprintf(stream, "usage: paste [-s] [-d DELIMS] [--] [FILE...]  # LF byte records; 32 files/16 MiB/100000 records/1 MiB each; output <=32 MiB\n");
}

static size_t paste_utf8_scalar_size(const unsigned char *text, size_t remaining) {
  if (!remaining) return 0;
  unsigned char first = text[0]; size_t size;
  if (first < 0x80) return 1;
  if (first >= 0xc2 && first <= 0xdf) size = 2;
  else if (first >= 0xe0 && first <= 0xef) size = 3;
  else if (first >= 0xf0 && first <= 0xf4) size = 4;
  else return 0;
  if (size > remaining) return 0;
  for (size_t index = 1; index < size; index++)
    if ((text[index] & 0xc0) != 0x80) return 0;
  if ((first == 0xe0 && text[1] < 0xa0) ||
      (first == 0xed && text[1] >= 0xa0) ||
      (first == 0xf0 && text[1] < 0x90) ||
      (first == 0xf4 && text[1] >= 0x90)) return 0;
  return size;
}

static int paste_parse_delimiters(const char *value, paste_delimiter *delimiters,
                                  size_t *delimiter_count) {
  const unsigned char *bytes = (const unsigned char *)value;
  size_t length = strlen(value), offset = 0, count = 0;
  while (offset < length) {
    size_t scalar = paste_utf8_scalar_size(bytes + offset, length - offset);
    if (!scalar) return -1;
    if (count >= PASTE_DELIMITERS) return 0;
    delimiters[count++] = (paste_delimiter){bytes + offset, scalar};
    offset += scalar;
  }
  *delimiter_count = count; return 1;
}

/* Read no more than the remaining aggregate allowance. An extra-byte probe
 * makes an exact 16 MiB aggregate usable while detecting the first overflow. */
static int paste_read_input(FILE *file, char **output, size_t *size, size_t remaining) {
  size_t cap = remaining < 65536 ? remaining : 65536, used = 0;
  char *data = malloc(cap + 1); if (!data) return -1;
  while (used < remaining) {
    if (used == cap) {
      size_t next = cap * 2;
      if (next > remaining) next = remaining;
      char *grown = realloc(data, next + 1);
      if (!grown) { free(data); return -1; }
      data = grown; cap = next;
    }
    size_t got = fread(data + used, 1, cap - used, file); used += got;
    if (!got) break;
  }
  if (ferror(file)) { free(data); return -1; }
  if (used == remaining) {
    int extra = fgetc(file);
    if (extra != EOF) { free(data); return 0; }
    if (ferror(file)) { free(data); return -1; }
  }
  data[used] = 0; *output = data; *size = used; return 1;
}

static void paste_input_free(paste_input *input) {
  free(input->records); free(input->data);
  input->records = NULL; input->data = NULL; input->count = input->cursor = 0;
}

static int paste_input_load(FILE *file, const char *name, paste_input *input,
                            size_t *aggregate_bytes, size_t *aggregate_records) {
  memset(input, 0, sizeof *input);
  size_t size = 0;
  int loaded = paste_read_input(file, &input->data, &size, DATA_LIMIT - *aggregate_bytes);
  if (loaded < 0) {
    fprintf(stderr, "paste: %s: cannot read\n", paste_input_name(name)); return 1;
  }
  if (!loaded) {
    fprintf(stderr, "paste: aggregate input exceeds %d bytes\n", DATA_LIMIT); return 1;
  }
  *aggregate_bytes += size;

  size_t count = 0, start = 0;
  for (size_t offset = 0; offset <= size; offset++) {
    if (offset < size && input->data[offset] != '\n') continue;
    if (offset == size && start == size) break;
    if (offset - start > RECORD_LIMIT) {
      fprintf(stderr, "paste: %s: record exceeds %d bytes\n",
              paste_input_name(name), RECORD_LIMIT);
      paste_input_free(input); return 1;
    }
    if (*aggregate_records + count >= SORT_LINES) {
      fprintf(stderr, "paste: aggregate record count exceeds %d\n", SORT_LINES);
      paste_input_free(input); return 1;
    }
    count++; start = offset + 1;
  }
  input->records = count ? malloc(count * sizeof *input->records) : NULL;
  if (count && !input->records) {
    fprintf(stderr, "paste: %s: cannot read\n", paste_input_name(name));
    paste_input_free(input); return 1;
  }
  start = 0; size_t used = 0;
  for (size_t offset = 0; offset <= size; offset++) {
    if (offset < size && input->data[offset] != '\n') continue;
    if (offset == size && start == size) break;
    input->records[used++] = (paste_record){
      (const unsigned char *)input->data + start, offset - start,
    };
    start = offset + 1;
  }
  input->count = used; *aggregate_records += used; return 0;
}

static paste_record *paste_next(paste_input *input) {
  return input->cursor < input->count ? &input->records[input->cursor++] : NULL;
}

static void paste_reset_inputs(paste_input *inputs, int input_count) {
  for (int index = 0; index < input_count; index++) inputs[index].cursor = 0;
}

static size_t paste_delimiter_length(const paste_delimiter *delimiters,
                                     size_t delimiter_count, size_t index) {
  return delimiter_count ? delimiters[index % delimiter_count].length : 0;
}

static int paste_output_add(size_t *output_size, size_t addition) {
  if (addition > RECORD_OUTPUT_LIMIT - *output_size) return 0;
  *output_size += addition; return 1;
}

static int paste_predict_parallel(paste_input *inputs, const int *operand_inputs,
                                  int operands, const paste_delimiter *delimiters,
                                  size_t delimiter_count, size_t *output_size) {
  for (;;) {
    int any = 0; size_t row_size = 1;
    for (int operand = 0; operand < operands; operand++) {
      paste_record *record = paste_next(&inputs[operand_inputs[operand]]);
      if (record) { any = 1; if (!paste_output_add(&row_size, record->length)) return 0; }
      if (operand > 0 &&
          !paste_output_add(&row_size, paste_delimiter_length(
            delimiters, delimiter_count, (size_t)(operand - 1)))) return 0;
    }
    if (!any) return 1;
    if (!paste_output_add(output_size, row_size)) return 0;
  }
}

static int paste_predict_serial(paste_input *inputs, const int *operand_inputs,
                                int operands, const paste_delimiter *delimiters,
                                size_t delimiter_count, size_t *output_size) {
  for (int operand = 0; operand < operands; operand++) {
    paste_record *record = paste_next(&inputs[operand_inputs[operand]]);
    if (!record) continue;
    size_t row_size = record->length + 1, delimiter_index = 0;
    while ((record = paste_next(&inputs[operand_inputs[operand]]))) {
      if (!paste_output_add(&row_size, paste_delimiter_length(
            delimiters, delimiter_count, delimiter_index++)) ||
          !paste_output_add(&row_size, record->length)) return 0;
    }
    if (!paste_output_add(output_size, row_size)) return 0;
  }
  return 1;
}

static int paste_write_delimiter(const paste_delimiter *delimiters,
                                 size_t delimiter_count, size_t index) {
  if (!delimiter_count) return 0;
  const paste_delimiter *delimiter = &delimiters[index % delimiter_count];
  return delimiter->length &&
    fwrite(delimiter->data, 1, delimiter->length, stdout) != delimiter->length;
}

static int paste_write_record(const paste_record *record) {
  return record && record->length &&
    fwrite(record->data, 1, record->length, stdout) != record->length;
}

static int paste_emit_parallel(paste_input *inputs, const int *operand_inputs,
                               int operands, const paste_delimiter *delimiters,
                               size_t delimiter_count) {
  paste_record *row[PASTE_FILES];
  for (;;) {
    int any = 0;
    for (int operand = 0; operand < operands; operand++) {
      row[operand] = paste_next(&inputs[operand_inputs[operand]]);
      if (row[operand]) any = 1;
    }
    if (!any) return 0;
    for (int operand = 0; operand < operands; operand++) {
      if (operand > 0 && paste_write_delimiter(
            delimiters, delimiter_count, (size_t)(operand - 1))) return 1;
      if (paste_write_record(row[operand])) return 1;
    }
    if (putchar('\n') == EOF) return 1;
  }
}

static int paste_emit_serial(paste_input *inputs, const int *operand_inputs,
                             int operands, const paste_delimiter *delimiters,
                             size_t delimiter_count) {
  for (int operand = 0; operand < operands; operand++) {
    paste_record *record = paste_next(&inputs[operand_inputs[operand]]);
    if (!record) continue;
    if (paste_write_record(record)) return 1;
    size_t delimiter_index = 0;
    while ((record = paste_next(&inputs[operand_inputs[operand]]))) {
      if (paste_write_delimiter(delimiters, delimiter_count, delimiter_index++) ||
          paste_write_record(record)) return 1;
    }
    if (putchar('\n') == EOF) return 1;
  }
  return 0;
}

static int cmd_paste(int ac, char **av) {
  int serial = 0, i = 1; const char *delimiter_value = "\t";
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (av[i][1] == '-') {
      fprintf(stderr, "paste: unsupported option: %s\n", av[i]); paste_usage(stderr); return 2;
    }
    const char *flag = av[i] + 1;
    while (*flag) {
      if (*flag == 's') { serial = 1; flag++; continue; }
      if (*flag == 'd') {
        flag++;
        if (*flag) { delimiter_value = flag; flag += strlen(flag); }
        else if (i + 1 < ac) { delimiter_value = av[++i]; }
        else {
          fprintf(stderr, "paste: -d requires a delimiter list\n");
          paste_usage(stderr); return 2;
        }
        continue;
      }
      fprintf(stderr, "paste: unsupported option: -%c\n", *flag);
      paste_usage(stderr); return 2;
    }
    i++;
  }

  int operands = ac - i;
  if (operands > PASTE_FILES) {
    fprintf(stderr, "paste: too many input files (limit %d)\n", PASTE_FILES);
    paste_usage(stderr); return 2;
  }
  const char *names[PASTE_FILES];
  if (!operands) { names[0] = "-"; operands = 1; }
  else for (int operand = 0; operand < operands; operand++) names[operand] = av[i + operand];

  paste_delimiter delimiters[PASTE_DELIMITERS]; size_t delimiter_count = 0;
  int parsed_delimiters = paste_parse_delimiters(
    delimiter_value, delimiters, &delimiter_count);
  if (parsed_delimiters < 0) {
    fprintf(stderr, "paste: delimiter list is not valid UTF-8\n");
    paste_usage(stderr); return 2;
  }
  if (!parsed_delimiters) {
    fprintf(stderr, "paste: delimiter list exceeds %d characters\n", PASTE_DELIMITERS);
    paste_usage(stderr); return 2;
  }

  FILE *files[PASTE_FILES] = {0};
  for (int operand = 0; operand < operands; operand++) {
    if (!strcmp(names[operand], "-")) continue;
    files[operand] = fopen(names[operand], "rb");
    if (!files[operand]) {
      for (int opened = 0; opened < operand; opened++) if (files[opened]) fclose(files[opened]);
      fprintf(stderr, "paste: %s: cannot read\n", names[operand]); return 1;
    }
  }

  paste_input inputs[PASTE_FILES]; memset(inputs, 0, sizeof inputs);
  int operand_inputs[PASTE_FILES], input_count = 0, standard_input = -1;
  size_t aggregate_bytes = 0, aggregate_records = 0; int rc = 0;
  for (int operand = 0; operand < operands; operand++) {
    if (!strcmp(names[operand], "-") && standard_input >= 0) {
      operand_inputs[operand] = standard_input; continue;
    }
    int input_index = input_count++;
    operand_inputs[operand] = input_index;
    if (!strcmp(names[operand], "-")) standard_input = input_index;
    FILE *file = !strcmp(names[operand], "-") ? stdin : files[operand];
    rc = paste_input_load(file, names[operand], &inputs[input_index],
                          &aggregate_bytes, &aggregate_records);
    if (rc) break;
  }
  for (int operand = 0; operand < operands; operand++) if (files[operand]) fclose(files[operand]);
  if (rc) {
    for (int input = 0; input < input_count; input++) paste_input_free(&inputs[input]);
    return rc;
  }

  size_t output_size = 0;
  int predicted = serial
    ? paste_predict_serial(inputs, operand_inputs, operands, delimiters, delimiter_count, &output_size)
    : paste_predict_parallel(inputs, operand_inputs, operands, delimiters, delimiter_count, &output_size);
  paste_reset_inputs(inputs, input_count);
  if (!predicted) {
    fprintf(stderr, "paste: output exceeds %d bytes\n", RECORD_OUTPUT_LIMIT); rc = 1;
  } else {
    rc = serial
      ? paste_emit_serial(inputs, operand_inputs, operands, delimiters, delimiter_count)
      : paste_emit_parallel(inputs, operand_inputs, operands, delimiters, delimiter_count);
    if (!rc && fflush(stdout) == EOF) rc = 1;
  }
  for (int input = 0; input < input_count; input++) paste_input_free(&inputs[input]);
  return rc;
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
  int i = 1; if (i < ac && !strcmp(av[i], "--")) i++;
  if (ac - i < 1 || ac - i > 2) { fprintf(stderr, "basename: expected PATH [SUFFIX]\n"); return 2; }
  const char *b = base(av[i]); size_t n = strlen(b);
  if (ac - i > 1) { size_t s = strlen(av[i + 1]); if (n > s && !strcmp(b + n - s, av[i + 1])) n -= s; }
  fwrite(b, 1, n, stdout); putchar('\n'); return 0;
}

static int cmd_dirname(int ac, char **av) {
  int i = 1; if (i < ac && !strcmp(av[i], "--")) i++;
  if (ac - i != 1) { fprintf(stderr, "dirname: expected one path\n"); return 2; }
  char *s = strdup(av[i]); if (!s) return 1; size_t n = strlen(s);
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

static void cmp_usage(FILE *output) {
  fputs("usage: cmp [-s] [--] FILE1 FILE2\n", output);
}

static int cmp_usage_error(int quiet) {
  if (!quiet) { fputs("cmp: ", stderr); cmp_usage(stderr); }
  return 2;
}

static int cmp_input_error(int quiet, const char *name, const char *message) {
  if (!quiet) fprintf(stderr, "cmp: %s: %s\n", name, message);
  return 2;
}

static int cmp_global_error(int quiet, const char *message) {
  if (!quiet) fprintf(stderr, "cmp: %s\n", message);
  return 2;
}

static int cmp_add_size(size_t *total, size_t addition) {
  if (*total > SIZE_MAX - addition) return 0;
  *total += addition; return 1;
}

static int cmp_write_difference(const char *left, const char *right,
                                unsigned long long position,
                                unsigned long long line, int quiet) {
  if (quiet) return 1;
  char position_text[32], line_text[32];
  int position_length = snprintf(position_text, sizeof position_text, "%llu", position);
  int line_length = snprintf(line_text, sizeof line_text, "%llu", line);
  static const char byte_label[] = " differ: byte ", line_label[] = ", line ";
  if (position_length < 1 || line_length < 1) return cmp_global_error(0, "comparison too large");
  size_t total = 0;
  if (!cmp_add_size(&total, strlen(left)) || !cmp_add_size(&total, 1) ||
      !cmp_add_size(&total, strlen(right)) ||
      !cmp_add_size(&total, sizeof byte_label - 1) ||
      !cmp_add_size(&total, (size_t)position_length) ||
      !cmp_add_size(&total, sizeof line_label - 1) ||
      !cmp_add_size(&total, (size_t)line_length) || !cmp_add_size(&total, 1))
    return cmp_global_error(0, "comparison too large");
  char *record = malloc(total); if (!record) return cmp_global_error(0, "comparison too large");
  size_t offset = 0, length = strlen(left);
  memcpy(record + offset, left, length); offset += length; record[offset++] = ' ';
  length = strlen(right); memcpy(record + offset, right, length); offset += length;
  memcpy(record + offset, byte_label, sizeof byte_label - 1); offset += sizeof byte_label - 1;
  memcpy(record + offset, position_text, (size_t)position_length); offset += (size_t)position_length;
  memcpy(record + offset, line_label, sizeof line_label - 1); offset += sizeof line_label - 1;
  memcpy(record + offset, line_text, (size_t)line_length); offset += (size_t)line_length;
  record[offset++] = '\n';
  int failed = fwrite(record, 1, total, stdout) != total || ferror(stdout);
  free(record);
  return failed ? cmp_global_error(0, "output error") : 1;
}

static int cmd_cmp(int ac, char **av) {
  int quiet = 0, terminated = 0, i = 1;
  if (i < ac && !strcmp(av[i], "-s")) { quiet = 1; i++; }
  if (i < ac && !strcmp(av[i], "--")) { terminated = 1; i++; }
  if (ac - i != 2) return cmp_usage_error(quiet);
  const char *left_name = av[i], *right_name = av[i + 1];
  if ((!terminated && ((left_name[0] == '-' && strcmp(left_name, "-")) ||
                       (right_name[0] == '-' && strcmp(right_name, "-")))) ||
      (!strcmp(left_name, "-") && !strcmp(right_name, "-")))
    return cmp_usage_error(quiet);

  FILE *left = !strcmp(left_name, "-") ? stdin : fopen(left_name, "rb");
  FILE *right = !strcmp(right_name, "-") ? stdin : fopen(right_name, "rb");
  int left_issue = left ? 0 : 1, right_issue = right ? 0 : 1;
  struct stat status;
  if (left && strcmp(left_name, "-")) {
    if (stat(left_name, &status)) left_issue = 1;
    else if (S_ISDIR(status.st_mode)) left_issue = 2;
  }
  if (right && strcmp(right_name, "-")) {
    if (stat(right_name, &status)) right_issue = 1;
    else if (S_ISDIR(status.st_mode)) right_issue = 2;
  }
  if (left_issue || right_issue) {
    if (left && left != stdin) fclose(left);
    if (right && right != stdin) fclose(right);
    if (left_issue) return cmp_input_error(quiet, left_name, left_issue == 2 ? "is a directory" : "cannot open");
    return cmp_input_error(quiet, right_name, right_issue == 2 ? "is a directory" : "cannot open");
  }

  unsigned long long position = 1, line = 1, difference_position = 0, difference_line = 0;
  int different = 0, too_large = 0;
  for (;;) {
    int left_byte = fgetc(left), right_byte = fgetc(right);
    if (left_byte == EOF && right_byte == EOF) break;
    if (!different) {
      if (left_byte != right_byte) {
        different = 1; difference_position = position; difference_line = line;
      } else if (left_byte == '\n') {
        if (line == ULLONG_MAX) too_large = 1;
        else line++;
      }
    }
    if (position == ULLONG_MAX) too_large = 1;
    else position++;
  }
  int left_read_error = ferror(left), right_read_error = ferror(right);
  int left_close_error = left != stdin && fclose(left) == EOF;
  int right_close_error = right != stdin && fclose(right) == EOF;
  if (left_read_error || left_close_error)
    return cmp_input_error(quiet, left_name, "read error");
  if (right_read_error || right_close_error)
    return cmp_input_error(quiet, right_name, "read error");
  if (too_large) return cmp_global_error(quiet, "comparison too large");
  return different
    ? cmp_write_difference(left_name, right_name, difference_position, difference_line, quiet)
    : 0;
}

typedef struct { const unsigned char *data; size_t length; int newline; } comm_record;
typedef struct { char *data; comm_record *records; size_t count; } comm_input;

static const char *comm_input_name(const char *name) {
  return !strcmp(name, "-") ? "standard input" : name;
}

static int comm_record_compare(const comm_record *left, const comm_record *right) {
  size_t common = left->length < right->length ? left->length : right->length;
  int compared = memcmp(left->data, right->data, common);
  if (compared) return compared < 0 ? -1 : 1;
  return left->length < right->length ? -1 : left->length > right->length ? 1 : 0;
}

static void comm_input_free(comm_input *input) {
  free(input->records); free(input->data);
  input->records = NULL; input->data = NULL; input->count = 0;
}

static int comm_input_load(FILE *file, const char *name, comm_input *input) {
  memset(input, 0, sizeof *input);
  size_t size = 0; int loaded = read_bounded_all(file, &input->data, &size);
  if (loaded < 0) {
    fprintf(stderr, "comm: %s: cannot read\n", comm_input_name(name)); return 1;
  }
  if (!loaded) {
    fprintf(stderr, "comm: %s: input limit exceeded\n", comm_input_name(name)); return 1;
  }

  size_t start = 0, count = 0;
  for (size_t offset = 0; offset <= size; offset++) {
    if (offset < size && input->data[offset] != '\n') continue;
    if (offset == size && start == size) break;
    if (offset - start > RECORD_LIMIT || count >= SORT_LINES) {
      fprintf(stderr, "comm: %s: input limit exceeded\n", comm_input_name(name));
      comm_input_free(input); return 1;
    }
    count++; start = offset + 1;
  }
  input->records = count ? malloc(count * sizeof *input->records) : NULL;
  if (count && !input->records) {
    fprintf(stderr, "comm: %s: cannot read\n", comm_input_name(name));
    comm_input_free(input); return 1;
  }

  start = 0; size_t used = 0;
  for (size_t offset = 0; offset <= size; offset++) {
    if (offset < size && input->data[offset] != '\n') continue;
    if (offset == size && start == size) break;
    input->records[used++] = (comm_record){
      (const unsigned char *)input->data + start,
      offset - start,
      offset < size,
    };
    start = offset + 1;
  }
  input->count = used;
  for (size_t index = 1; index < input->count; index++) {
    if (comm_record_compare(&input->records[index - 1], &input->records[index]) <= 0) continue;
    fprintf(stderr, "comm: %s: input is not sorted at record %lu\n",
            comm_input_name(name), (unsigned long)(index + 1));
    comm_input_free(input); return 1;
  }
  return 0;
}

static int comm_emit_record(const comm_record *record, int column, const int suppressed[3]) {
  if (suppressed[column]) return 0;
  for (int earlier = 0; earlier < column; earlier++) {
    if (!suppressed[earlier] && putchar('\t') == EOF) return 1;
  }
  if (record->length && fwrite(record->data, 1, record->length, stdout) != record->length) return 1;
  return record->newline && putchar('\n') == EOF;
}

static void comm_usage(FILE *stream) {
  fprintf(stream, "usage: comm [-123] [--] FILE1 FILE2  # sorted byte records; each input <=16 MiB/100000 records/1 MiB each\n");
}

static int cmd_comm(int ac, char **av) {
  int suppressed[3] = {0, 0, 0}, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (av[i][1] == '-') {
      fprintf(stderr, "comm: unsupported option: %s\n", av[i]); comm_usage(stderr); return 2;
    }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag >= '1' && *flag <= '3') suppressed[*flag - '1'] = 1;
      else {
        fprintf(stderr, "comm: unsupported option: -%c\n", *flag); comm_usage(stderr); return 2;
      }
    }
  }
  if (ac - i != 2) {
    fprintf(stderr, "comm: expected exactly two files\n"); comm_usage(stderr); return 2;
  }
  const char *left_name = av[i], *right_name = av[i + 1];
  if (!strcmp(left_name, "-") && !strcmp(right_name, "-")) {
    fprintf(stderr, "comm: both inputs cannot be standard input\n"); return 2;
  }

  FILE *left_file = open_input(left_name);
  if (!left_file) { fprintf(stderr, "comm: %s: cannot read\n", comm_input_name(left_name)); return 1; }
  FILE *right_file = open_input(right_name);
  if (!right_file) {
    if (left_file != stdin) fclose(left_file);
    fprintf(stderr, "comm: %s: cannot read\n", comm_input_name(right_name)); return 1;
  }

  comm_input left = {0}, right = {0};
  int rc = comm_input_load(left_file, left_name, &left);
  if (!rc) rc = comm_input_load(right_file, right_name, &right);
  if (left_file != stdin) fclose(left_file);
  if (right_file != stdin) fclose(right_file);
  if (rc) { comm_input_free(&left); comm_input_free(&right); return rc; }

  size_t left_index = 0, right_index = 0;
  while (left_index < left.count || right_index < right.count) {
    int column;
    const comm_record *record;
    if (left_index == left.count) { column = 1; record = &right.records[right_index++]; }
    else if (right_index == right.count) { column = 0; record = &left.records[left_index++]; }
    else {
      int compared = comm_record_compare(&left.records[left_index], &right.records[right_index]);
      if (compared < 0) { column = 0; record = &left.records[left_index++]; }
      else if (compared > 0) { column = 1; record = &right.records[right_index++]; }
      else { column = 2; record = &left.records[left_index++]; right_index++; }
    }
    if (comm_emit_record(record, column, suppressed)) { rc = 1; break; }
  }
  if (!rc && fflush(stdout) == EOF) rc = 1;
  comm_input_free(&left); comm_input_free(&right); return rc;
}

typedef struct {
  const unsigned char *data, *key;
  size_t length, key_length, field_count, nonkey_bytes;
} join_record;
typedef struct { char *data; join_record *records; size_t count; } join_input;

static const char *join_input_name(const char *name) {
  return !strcmp(name, "-") ? "standard input" : name;
}

static void join_usage(FILE *stream) {
  fprintf(stream, "usage: join [-1 FIELD] [-2 FIELD] [-t BYTE] [-a 1] [-a 2] [-v 1|2] [--] FILE1 FILE2  # fields 1..1000; sorted LF byte records; each input <=16 MiB/100000 records/1 MiB each; output <=32 MiB/100000 records/2 MiB each\n");
}

static int join_parse_field(const char *value, size_t *field) {
  if (!value[0] || (value[0] == '0' && value[1])) return 0;
  size_t parsed = 0;
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p < '0' || *p > '9') return 0;
    if (parsed > (JOIN_FIELDS - (*p - '0')) / 10) return 0;
    parsed = parsed * 10 + (*p - '0');
  }
  if (parsed < 1 || parsed > JOIN_FIELDS) return 0;
  *field = parsed; return 1;
}

static int join_key_compare(const join_record *left, const join_record *right) {
  size_t common = left->key_length < right->key_length ? left->key_length : right->key_length;
  int compared = memcmp(left->key, right->key, common);
  if (compared) return compared < 0 ? -1 : 1;
  return left->key_length < right->key_length ? -1 :
    left->key_length > right->key_length ? 1 : 0;
}

static int join_parse_record(join_record *record, size_t selected,
                             int explicit_delimiter, unsigned char delimiter) {
  record->key = NULL; record->key_length = record->field_count = record->nonkey_bytes = 0;
  if (explicit_delimiter) {
    size_t field = 1, start = 0;
    for (size_t offset = 0;; offset++) {
      if (offset < record->length && record->data[offset] != delimiter) continue;
      size_t length = offset - start;
      if (field == selected) { record->key = record->data + start; record->key_length = length; }
      else record->nonkey_bytes += length;
      record->field_count++;
      if (offset == record->length) break;
      field++; start = offset + 1;
    }
  } else {
    size_t offset = 0, field = 0;
    while (offset < record->length) {
      while (offset < record->length &&
             (record->data[offset] == ' ' || record->data[offset] == '\t')) offset++;
      if (offset == record->length) break;
      size_t start = offset;
      while (offset < record->length &&
             record->data[offset] != ' ' && record->data[offset] != '\t') offset++;
      size_t length = offset - start; field++; record->field_count++;
      if (field == selected) { record->key = record->data + start; record->key_length = length; }
      else record->nonkey_bytes += length;
    }
  }
  return record->key != NULL;
}

static void join_input_free(join_input *input) {
  free(input->records); free(input->data);
  input->records = NULL; input->data = NULL; input->count = 0;
}

static int join_input_load(FILE *file, const char *name, join_input *input,
                           size_t selected, int explicit_delimiter,
                           unsigned char delimiter) {
  memset(input, 0, sizeof *input);
  size_t size = 0; int loaded = read_bounded_all(file, &input->data, &size);
  if (loaded < 0) {
    fprintf(stderr, "join: %s: cannot read\n", join_input_name(name)); return 1;
  }
  if (!loaded) {
    fprintf(stderr, "join: %s: input limit exceeded\n", join_input_name(name)); return 1;
  }

  size_t start = 0, count = 0;
  for (size_t offset = 0; offset <= size; offset++) {
    if (offset < size && input->data[offset] != '\n') continue;
    if (offset == size && start == size) break;
    if (offset - start > RECORD_LIMIT || count >= SORT_LINES) {
      fprintf(stderr, "join: %s: input limit exceeded\n", join_input_name(name));
      join_input_free(input); return 1;
    }
    count++; start = offset + 1;
  }
  input->records = count ? malloc(count * sizeof *input->records) : NULL;
  if (count && !input->records) {
    fprintf(stderr, "join: %s: cannot read\n", join_input_name(name));
    join_input_free(input); return 1;
  }

  start = 0; size_t used = 0;
  for (size_t offset = 0; offset <= size; offset++) {
    if (offset < size && input->data[offset] != '\n') continue;
    if (offset == size && start == size) break;
    join_record *record = &input->records[used];
    *record = (join_record){
      .data = (const unsigned char *)input->data + start,
      .length = offset - start,
    };
    if (!join_parse_record(record, selected, explicit_delimiter, delimiter)) {
      fprintf(stderr, "join: %s: record %lu has no field %lu\n",
              join_input_name(name), (unsigned long)(used + 1), (unsigned long)selected);
      join_input_free(input); return 1;
    }
    used++; start = offset + 1;
  }
  input->count = used;
  for (size_t index = 1; index < input->count; index++) {
    if (join_key_compare(&input->records[index - 1], &input->records[index]) <= 0) continue;
    fprintf(stderr, "join: %s: input is not sorted at record %lu\n",
            join_input_name(name), (unsigned long)(index + 1));
    join_input_free(input); return 1;
  }
  return 0;
}

static int join_account_record(size_t payload, size_t *records, size_t *bytes) {
  if (payload > JOIN_RECORD_OUTPUT_LIMIT) {
    fprintf(stderr, "join: output record exceeds %d bytes\n", JOIN_RECORD_OUTPUT_LIMIT); return 1;
  }
  if (*records >= SORT_LINES) {
    fprintf(stderr, "join: output record count exceeds %d\n", SORT_LINES); return 1;
  }
  if (payload + 1 > RECORD_OUTPUT_LIMIT - *bytes) {
    fprintf(stderr, "join: output exceeds %d bytes\n", RECORD_OUTPUT_LIMIT); return 1;
  }
  (*records)++; *bytes += payload + 1; return 0;
}

static size_t join_output_payload(const join_record *left, const join_record *right) {
  size_t payload = left->key_length + left->nonkey_bytes + left->field_count - 1;
  if (right) payload += right->nonkey_bytes + right->field_count - 1;
  return payload;
}

static int join_write_nonkey(const join_record *record, size_t selected,
                             int explicit_delimiter, unsigned char input_delimiter,
                             unsigned char output_delimiter) {
  if (explicit_delimiter) {
    size_t field = 1, start = 0;
    for (size_t offset = 0;; offset++) {
      if (offset < record->length && record->data[offset] != input_delimiter) continue;
      if (field != selected) {
        if (putchar(output_delimiter) == EOF) return 1;
        size_t length = offset - start;
        if (length && fwrite(record->data + start, 1, length, stdout) != length) return 1;
      }
      if (offset == record->length) break;
      field++; start = offset + 1;
    }
  } else {
    size_t offset = 0, field = 0;
    while (offset < record->length) {
      while (offset < record->length &&
             (record->data[offset] == ' ' || record->data[offset] == '\t')) offset++;
      if (offset == record->length) break;
      size_t start = offset;
      while (offset < record->length &&
             record->data[offset] != ' ' && record->data[offset] != '\t') offset++;
      field++;
      if (field == selected) continue;
      if (putchar(output_delimiter) == EOF) return 1;
      size_t length = offset - start;
      if (fwrite(record->data + start, 1, length, stdout) != length) return 1;
    }
  }
  return 0;
}

static int join_emit_record(const join_record *left, size_t left_field,
                            const join_record *right, size_t right_field,
                            int explicit_delimiter, unsigned char delimiter) {
  unsigned char output_delimiter = explicit_delimiter ? delimiter : ' ';
  if (left->key_length && fwrite(left->key, 1, left->key_length, stdout) != left->key_length) return 1;
  if (join_write_nonkey(left, left_field, explicit_delimiter, delimiter, output_delimiter)) return 1;
  if (right && join_write_nonkey(
        right, right_field, explicit_delimiter, delimiter, output_delimiter)) return 1;
  return putchar('\n') == EOF;
}

static int join_process(const join_input *left, size_t left_field,
                        const join_input *right, size_t right_field,
                        int explicit_delimiter, unsigned char delimiter,
                        int include_left, int include_right, int matches, int emit) {
  size_t left_index = 0, right_index = 0, output_records = 0, output_bytes = 0;
  while (left_index < left->count || right_index < right->count) {
    int compared = left_index == left->count ? 1 : right_index == right->count ? -1 :
      join_key_compare(&left->records[left_index], &right->records[right_index]);
    if (compared < 0) {
      if (include_left) {
        if (emit) {
          if (join_emit_record(&left->records[left_index], left_field, NULL, 0,
                               explicit_delimiter, delimiter)) return 1;
        } else if (join_account_record(
                     join_output_payload(&left->records[left_index], NULL),
                     &output_records, &output_bytes)) return 1;
      }
      left_index++; continue;
    }
    if (compared > 0) {
      if (include_right) {
        if (emit) {
          if (join_emit_record(&right->records[right_index], right_field, NULL, 0,
                               explicit_delimiter, delimiter)) return 1;
        } else if (join_account_record(
                     join_output_payload(&right->records[right_index], NULL),
                     &output_records, &output_bytes)) return 1;
      }
      right_index++; continue;
    }

    size_t left_end = left_index + 1, right_end = right_index + 1;
    while (left_end < left->count &&
           join_key_compare(&left->records[left_index], &left->records[left_end]) == 0) left_end++;
    while (right_end < right->count &&
           join_key_compare(&right->records[right_index], &right->records[right_end]) == 0) right_end++;
    if (matches) {
      size_t left_group = left_end - left_index, right_group = right_end - right_index;
      if (!emit && (right_group > SORT_LINES - output_records ||
          left_group > (SORT_LINES - output_records) / right_group)) {
        fprintf(stderr, "join: output record count exceeds %d\n", SORT_LINES); return 1;
      }
      for (size_t li = left_index; li < left_end; li++) {
        for (size_t ri = right_index; ri < right_end; ri++) {
          if (emit) {
            if (join_emit_record(&left->records[li], left_field,
                                 &right->records[ri], right_field,
                                 explicit_delimiter, delimiter)) return 1;
          } else if (join_account_record(
                       join_output_payload(&left->records[li], &right->records[ri]),
                       &output_records, &output_bytes)) return 1;
        }
      }
    }
    left_index = left_end; right_index = right_end;
  }
  return 0;
}

static int cmd_join(int ac, char **av) {
  size_t fields[2] = {1, 1}; int seen_field[2] = {0, 0};
  int explicit_delimiter = 0, seen_delimiter = 0, include[2] = {0, 0}, anti = 0, i = 1;
  unsigned char delimiter = 0;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    const char *option = av[i];
    if (!strcmp(option, "--")) { i++; break; }
    if (!strcmp(option, "-1") || !strcmp(option, "-2")) {
      int side = option[1] - '1';
      if (seen_field[side]) {
        fprintf(stderr, "join: %s may be specified only once\n", option); join_usage(stderr); return 2;
      }
      if (i + 1 >= ac || !join_parse_field(av[i + 1], &fields[side])) {
        fprintf(stderr, "join: %s field must be from 1 to %d\n", option, JOIN_FIELDS);
        join_usage(stderr); return 2;
      }
      seen_field[side] = 1; i += 2; continue;
    }
    if (!strcmp(option, "-t")) {
      if (seen_delimiter) {
        fprintf(stderr, "join: -t may be specified only once\n"); join_usage(stderr); return 2;
      }
      if (i + 1 >= ac || strlen(av[i + 1]) != 1 || av[i + 1][0] == '\n') {
        fprintf(stderr, "join: -t requires one non-NUL, non-LF byte\n"); join_usage(stderr); return 2;
      }
      delimiter = (unsigned char)av[i + 1][0]; explicit_delimiter = seen_delimiter = 1;
      i += 2; continue;
    }
    if (!strcmp(option, "-a")) {
      if (i + 1 >= ac || (strcmp(av[i + 1], "1") && strcmp(av[i + 1], "2"))) {
        fprintf(stderr, "join: -a requires 1 or 2\n"); join_usage(stderr); return 2;
      }
      include[av[i + 1][0] - '1'] = 1; i += 2; continue;
    }
    if (!strcmp(option, "-v")) {
      if (anti) {
        fprintf(stderr, "join: -v may be specified only once\n"); join_usage(stderr); return 2;
      }
      if (i + 1 >= ac || (strcmp(av[i + 1], "1") && strcmp(av[i + 1], "2"))) {
        fprintf(stderr, "join: -v requires 1 or 2\n"); join_usage(stderr); return 2;
      }
      anti = av[i + 1][0] - '0'; i += 2; continue;
    }
    fprintf(stderr, "join: unsupported option: %s\n", option); join_usage(stderr); return 2;
  }
  if (anti && (include[0] || include[1])) {
    fprintf(stderr, "join: -v and -a are mutually exclusive\n"); join_usage(stderr); return 2;
  }
  if (ac - i != 2) {
    fprintf(stderr, "join: expected exactly two files\n"); join_usage(stderr); return 2;
  }
  const char *names[2] = {av[i], av[i + 1]};
  if (!strcmp(names[0], "-") && !strcmp(names[1], "-")) {
    fprintf(stderr, "join: both inputs cannot be standard input\n"); return 2;
  }

  FILE *files[2] = {open_input(names[0]), NULL};
  if (!files[0]) { fprintf(stderr, "join: %s: cannot read\n", join_input_name(names[0])); return 1; }
  files[1] = open_input(names[1]);
  if (!files[1]) {
    if (files[0] != stdin) fclose(files[0]);
    fprintf(stderr, "join: %s: cannot read\n", join_input_name(names[1])); return 1;
  }

  join_input inputs[2] = {{0}, {0}};
  int rc = join_input_load(files[0], names[0], &inputs[0], fields[0],
                           explicit_delimiter, delimiter);
  if (!rc) rc = join_input_load(files[1], names[1], &inputs[1], fields[1],
                                explicit_delimiter, delimiter);
  if (files[0] != stdin) fclose(files[0]);
  if (files[1] != stdin) fclose(files[1]);
  if (rc) { join_input_free(&inputs[0]); join_input_free(&inputs[1]); return rc; }

  int include_left = anti ? anti == 1 : include[0];
  int include_right = anti ? anti == 2 : include[1];
  int matches = !anti;
  rc = join_process(&inputs[0], fields[0], &inputs[1], fields[1],
                    explicit_delimiter, delimiter,
                    include_left, include_right, matches, 0);
  if (!rc) rc = join_process(&inputs[0], fields[0], &inputs[1], fields[1],
                             explicit_delimiter, delimiter,
                             include_left, include_right, matches, 1);
  if (!rc && fflush(stdout) == EOF) rc = 1;
  join_input_free(&inputs[0]); join_input_free(&inputs[1]); return rc;
}

static void xxd_usage(FILE *stream) {
  fprintf(stream, "usage: xxd [-g 1|2] [-c COLS] [-l LENGTH] [-s OFFSET] [--] [FILE|-]  # input <=16 MiB; output <=16 MiB\n");
}

static int xxd_parse_decimal(const char *value, size_t maximum, size_t *result) {
  if (!value[0]) return 0;
  size_t parsed = 0;
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p < '0' || *p > '9') return 0;
    size_t digit = (size_t)(*p - '0');
    if (parsed > maximum / 10 ||
        (parsed == maximum / 10 && digit > maximum % 10)) return 0;
    parsed = parsed * 10 + digit;
  }
  *result = parsed; return 1;
}

static int xxd_write_row(const unsigned char *data, size_t length, size_t offset,
                         size_t columns, size_t group) {
  if (printf("%08lx: ", (unsigned long)offset) < 0) return 1;
  size_t hexadecimal = 0;
  for (size_t index = 0; index < length; index++) {
    if (index && index % group == 0) {
      if (putchar(' ') == EOF) return 1;
      hexadecimal++;
    }
    if (printf("%02x", data[index]) < 0) return 1;
    hexadecimal += 2;
  }
  size_t width = 2 * columns + (columns + group - 1) / group - 1;
  while (hexadecimal++ < width) if (putchar(' ') == EOF) return 1;
  if (fputs("  ", stdout) == EOF) return 1;
  for (size_t index = 0; index < length; index++) {
    unsigned char byte = data[index];
    if (putchar(byte >= 0x20 && byte <= 0x7e ? byte : '.') == EOF) return 1;
  }
  return putchar('\n') == EOF;
}

static int cmd_xxd(int ac, char **av) {
  size_t group = 2, columns = 16, length = 0, offset = 0;
  int seen_group = 0, seen_columns = 0, seen_length = 0, seen_offset = 0, i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    const char *option = av[i], *value = NULL; size_t *target = NULL, maximum = 0;
    int *seen = NULL;
    if (!strcmp(option, "--")) { i++; break; }
    if (!strncmp(option, "-g", 2)) {
      target = &group; maximum = 2; seen = &seen_group;
    } else if (!strncmp(option, "-c", 2)) {
      target = &columns; maximum = 256; seen = &seen_columns;
    } else if (!strncmp(option, "-l", 2)) {
      target = &length; maximum = XXD_LIMIT; seen = &seen_length;
    } else if (!strncmp(option, "-s", 2)) {
      target = &offset; maximum = XXD_LIMIT; seen = &seen_offset;
    } else {
      fprintf(stderr, "xxd: unsupported option: %s\n", option); return 2;
    }
    if (option[2]) value = option + 2;
    else if (i + 1 < ac) value = av[++i];
    if (*seen) { fprintf(stderr, "xxd: option %.2s may be specified only once\n", option); return 2; }
    if (!value) { fprintf(stderr, "xxd: option %.2s requires a value\n", option); return 2; }
    if (!xxd_parse_decimal(value, maximum, target) ||
        (target == &group && group < 1) || (target == &columns && columns < 1)) {
      if (target == &group) fprintf(stderr, "xxd: group must be 1 or 2\n");
      else if (target == &columns) fprintf(stderr, "xxd: columns must be from 1 to 256\n");
      else fprintf(stderr, "xxd: %s must be from 0 to %d\n",
                   target == &length ? "length" : "offset", XXD_LIMIT);
      return 2;
    }
    *seen = 1; i++;
  }
  if (ac - i > 1) { fprintf(stderr, "xxd: expected at most one input\n"); return 2; }
  const char *name = i < ac ? av[i] : "-";
  FILE *file = open_input(name);
  if (!file) { fprintf(stderr, "xxd: %s: cannot read\n", !strcmp(name, "-") ? "standard input" : name); return 1; }
  char *raw = NULL; size_t size = 0; int loaded = read_bounded_all(file, &raw, &size);
  if (file != stdin) fclose(file);
  if (loaded < 0) {
    fprintf(stderr, "xxd: %s: cannot read\n", !strcmp(name, "-") ? "standard input" : name); return 1;
  }
  if (!loaded) {
    fprintf(stderr, "xxd: %s: input limit exceeded\n", !strcmp(name, "-") ? "standard input" : name); return 1;
  }

  size_t selected = offset < size ? size - offset : 0;
  if (seen_length && selected > length) selected = length;
  size_t rows = selected ? (selected + columns - 1) / columns : 0;
  size_t width = 2 * columns + (columns + group - 1) / group - 1;
  size_t fixed = 13 + width;
  if (selected > XXD_LIMIT || rows > (XXD_LIMIT - selected) / fixed) {
    fprintf(stderr, "xxd: output exceeds %d bytes\n", XXD_LIMIT); free(raw); return 1;
  }
  int rc = 0;
  for (size_t position = 0; position < selected; position += columns) {
    size_t row_length = selected - position;
    if (row_length > columns) row_length = columns;
    if (xxd_write_row((const unsigned char *)raw + offset + position, row_length,
                      offset + position, columns, group)) { rc = 1; break; }
  }
  if (!rc && fflush(stdout) == EOF) rc = 1;
  if (rc) fprintf(stderr, "xxd: cannot write output\n");
  free(raw); return rc;
}

static void base64_usage(FILE *stream) {
  fputs("usage: base64 [-d|--decode] [--] [FILE|-]  # strict RFC 4648; "
        "input <=16777216 bytes; encode <=22369624 bytes; decode <=12582912 bytes\n",
        stream);
}

static void render_bounded_name(FILE *stream, const char *name) {
  if (!strcmp(name, "-")) { fputs("standard input", stream); return; }
  const unsigned char *cursor = (const unsigned char *)name;
  size_t rendered = 0;
  while (*cursor) {
    int plain = *cursor >= 0x20 && *cursor <= 0x7e && *cursor != '\\';
    size_t width = plain ? 1 : 4;
    if (rendered + width > 384) break;
    if (plain) fputc(*cursor, stream);
    else fprintf(stream, "\\x%02x", *cursor);
    rendered += width; cursor++;
  }
  if (*cursor) fputs("...", stream);
}

static int base64_input_error(const char *name, const char *message, int status) {
  fputs("base64: ", stderr); render_bounded_name(stderr, name);
  fprintf(stderr, ": %s\n", message); return status;
}

static int base64_value(unsigned char byte) {
  if (byte >= 'A' && byte <= 'Z') return byte - 'A';
  if (byte >= 'a' && byte <= 'z') return byte - 'a' + 26;
  if (byte >= '0' && byte <= '9') return byte - '0' + 52;
  if (byte == '+') return 62;
  if (byte == '/') return 63;
  return -1;
}

static int base64_whitespace(unsigned char byte) {
  return byte == ' ' || byte == '\t' || byte == '\r' || byte == '\n';
}

/* Return 1 on success, 0 for malformed canonical input, and -1 on allocation
 * failure. The complete result is staged before stdout. */
static int base64_decode_bytes(const unsigned char *input, size_t input_size,
                               unsigned char **result, size_t *result_size) {
  size_t encoded = 0; unsigned char previous = 0, last = 0;
  for (size_t index = 0; index < input_size; index++) {
    unsigned char byte = input[index];
    if (base64_whitespace(byte)) continue;
    if (byte != '=' && base64_value(byte) < 0) return 0;
    previous = last; last = byte; encoded++;
  }
  if (encoded % 4) return 0;
  size_t padding = encoded && last == '=' ? 1 : 0;
  if (padding && previous == '=') padding++;
  size_t output_size = encoded / 4 * 3 - padding;
  if (output_size > BASE64_DECODE_OUTPUT_LIMIT) return 0;
  unsigned char *output = malloc(output_size ? output_size : 1);
  if (!output) return -1;
  if (!encoded) { *result = output; *result_size = 0; return 1; }

  int quantum[4]; int quantum_size = 0; size_t logical = 0, used = 0;
  for (size_t index = 0; index < input_size; index++) {
    unsigned char byte = input[index];
    if (base64_whitespace(byte)) continue;
    if (byte == '=') {
      if (logical < encoded - padding) { free(output); return 0; }
      quantum[quantum_size++] = 64;
    } else {
      int value = base64_value(byte);
      if (value < 0) { free(output); return 0; }
      quantum[quantum_size++] = value;
    }
    logical++;
    if (quantum_size != 4) continue;
    int final = logical == encoded;
    if (quantum[0] == 64 || quantum[1] == 64) { free(output); return 0; }
    output[used++] = (unsigned char)((quantum[0] << 2) | (quantum[1] >> 4));
    if (quantum[2] == 64) {
      if (!final || quantum[3] != 64 || (quantum[1] & 15)) { free(output); return 0; }
    } else {
      output[used++] = (unsigned char)((quantum[1] << 4) | (quantum[2] >> 2));
      if (quantum[3] == 64) {
        if (!final || (quantum[2] & 3)) { free(output); return 0; }
      } else {
        output[used++] = (unsigned char)((quantum[2] << 6) | quantum[3]);
      }
    }
    quantum_size = 0;
  }
  if (quantum_size || used != output_size) { free(output); return 0; }
  *result = output; *result_size = used; return 1;
}

static int base64_encode_bytes(const unsigned char *input, size_t input_size,
                               unsigned char **result, size_t *result_size) {
  static const unsigned char alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t output_size = (input_size + 2) / 3 * 4;
  if (output_size > BASE64_ENCODE_OUTPUT_LIMIT) return 0;
  unsigned char *output = malloc(output_size ? output_size : 1);
  if (!output) return -1;
  size_t used = 0;
  for (size_t index = 0; index < input_size; index += 3) {
    size_t remaining = input_size - index;
    unsigned int value = (unsigned int)input[index] << 16;
    if (remaining > 1) value |= (unsigned int)input[index + 1] << 8;
    if (remaining > 2) value |= input[index + 2];
    output[used++] = alphabet[(value >> 18) & 63];
    output[used++] = alphabet[(value >> 12) & 63];
    output[used++] = remaining > 1 ? alphabet[(value >> 6) & 63] : '=';
    output[used++] = remaining > 2 ? alphabet[value & 63] : '=';
  }
  *result = output; *result_size = used; return 1;
}

static int cmd_base64(int ac, char **av) {
  int decode = 0, help = 0, i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "-d") || !strcmp(av[i], "--decode")) decode = 1;
    else if (!strcmp(av[i], "-h") || !strcmp(av[i], "--help")) help = 1;
    else { fputs("base64: unsupported option\n", stderr); return 2; }
    i++;
  }
  if (help) {
    if (ac != 2) { fputs("base64: help accepts no other option or operand\n", stderr); return 2; }
    base64_usage(stdout); return 0;
  }
  if (ac - i > 1) { fputs("base64: expected at most one input\n", stderr); return 2; }
  const char *name = i < ac ? av[i] : "-";
  if (!*name) { fputs("base64: input path must not be empty\n", stderr); return 2; }
  if (strlen(name) > BASE64_PATH_LIMIT) {
    fprintf(stderr, "base64: input path exceeds %d bytes\n", BASE64_PATH_LIMIT); return 4;
  }

  FILE *file = !strcmp(name, "-") ? stdin : fopen(name, "rb");
  if (!file) return base64_input_error(name, "cannot read", 1);
  char *raw = NULL; size_t input_size = 0;
  int loaded = read_bounded_all(file, &raw, &input_size);
  int close_failed = file != stdin && fclose(file) != 0;
  if (!loaded) return base64_input_error(name, "input exceeds 16777216 bytes", 4);
  if (loaded < 0 || close_failed) {
    free(raw); return base64_input_error(name, "cannot read", 1);
  }

  unsigned char *output = NULL; size_t output_size = 0;
  int transformed = decode
    ? base64_decode_bytes((const unsigned char *)raw, input_size, &output, &output_size)
    : base64_encode_bytes((const unsigned char *)raw, input_size, &output, &output_size);
  free(raw);
  if (!transformed) { fputs("base64: malformed input\n", stderr); return decode ? 3 : 4; }
  if (transformed < 0) { fputs("base64: memory unavailable\n", stderr); return 1; }
  int rc = 0;
  if ((output_size && fwrite(output, 1, output_size, stdout) != output_size) ||
      fflush(stdout) == EOF) {
    fputs("base64: cannot write output\n", stderr); rc = 1;
  }
  free(output); return rc;
}

static void strings_usage(FILE *stream) {
  fputs("usage: strings [-n MIN] [--] [FILE...]  # ASCII 0x20..0x7e; "
        "MIN 1..65536; 100 files; 16 MiB/file+stdin+output; 64 MiB files total\n",
        stream);
}

static int strings_parse_minimum(const char *text, size_t *result) {
  if (!*text) return 0;
  size_t value = 0;
  for (const unsigned char *cursor = (const unsigned char *)text; *cursor; cursor++) {
    if (*cursor < '0' || *cursor > '9') return 0;
    size_t digit = (size_t)(*cursor - '0');
    if (value > (STRINGS_MIN_LIMIT - digit) / 10) return 0;
    value = value * 10 + digit;
  }
  if (!value || value > STRINGS_MIN_LIMIT) return 0;
  *result = value; return 1;
}

static int strings_input_error(const char *name, const char *message) {
  fputs("strings: ", stderr); render_bounded_name(stderr, name);
  fprintf(stderr, ": %s\n", message); return 1;
}

typedef struct {
  unsigned char *data;
  unsigned char *pending;
  size_t used, capacity, pending_used, minimum;
  int qualified;
} strings_spool;

/* Return 1 on success, 0 for the output bound, and -1 for allocation. */
static int strings_reserve(strings_spool *spool, size_t needed) {
  if (needed > STRINGS_OUTPUT_LIMIT) return 0;
  if (needed <= spool->capacity) return 1;
  size_t capacity = spool->capacity ? spool->capacity : COPY_BUF;
  while (capacity < needed) {
    size_t next = capacity * 2;
    if (next > STRINGS_OUTPUT_LIMIT) next = STRINGS_OUTPUT_LIMIT;
    if (next == capacity) return 0;
    capacity = next;
  }
  unsigned char *grown = realloc(spool->data, capacity);
  if (!grown) return -1;
  spool->data = grown; spool->capacity = capacity; return 1;
}

static int strings_finish_run(strings_spool *spool) {
  if (spool->qualified) {
    int reserved = strings_reserve(spool, spool->used + 1);
    if (reserved <= 0) return reserved;
    spool->data[spool->used++] = '\n';
  }
  spool->pending_used = 0; spool->qualified = 0; return 1;
}

static int strings_take_byte(strings_spool *spool, unsigned char byte) {
  if (byte < 0x20 || byte > 0x7e) return strings_finish_run(spool);
  if (spool->qualified) {
    /* Keep one byte reserved for the newline that closes this run. */
    if (spool->used >= STRINGS_OUTPUT_LIMIT - 1) return 0;
    int reserved = strings_reserve(spool, spool->used + 1);
    if (reserved <= 0) return reserved;
    spool->data[spool->used++] = byte; return 1;
  }
  spool->pending[spool->pending_used++] = byte;
  if (spool->pending_used < spool->minimum) return 1;
  if (spool->used > STRINGS_OUTPUT_LIMIT - spool->minimum - 1) return 0;
  int reserved = strings_reserve(spool, spool->used + spool->minimum);
  if (reserved <= 0) return reserved;
  memcpy(spool->data + spool->used, spool->pending, spool->minimum);
  spool->used += spool->minimum; spool->pending_used = 0; spool->qualified = 1;
  return 1;
}

static int strings_scan_input(FILE *file, const char *name, strings_spool *spool,
                              size_t *explicit_total) {
  unsigned char chunk[COPY_BUF]; size_t input_used = 0;
  for (;;) {
    if (input_used == DATA_LIMIT) {
      int extra = fgetc(file);
      if (extra != EOF) return strings_input_error(name, "input limit exceeded");
      if (ferror(file)) return strings_input_error(name, "cannot read");
      break;
    }
    size_t wanted = DATA_LIMIT - input_used;
    if (wanted > sizeof chunk) wanted = sizeof chunk;
    size_t got = fread(chunk, 1, wanted, file);
    if (!got) {
      if (ferror(file)) return strings_input_error(name, "cannot read");
      break;
    }
    input_used += got;
    if (explicit_total) {
      if (*explicit_total > STRINGS_EXPLICIT_INPUT_LIMIT - got) {
        fputs("strings: aggregate explicit input limit exceeded\n", stderr); return 1;
      }
      *explicit_total += got;
    }
    for (size_t index = 0; index < got; index++) {
      int accepted = strings_take_byte(spool, chunk[index]);
      if (!accepted) { fputs("strings: output limit exceeded\n", stderr); return 1; }
      if (accepted < 0) { fputs("strings: memory unavailable\n", stderr); return 1; }
    }
  }
  int finished = strings_finish_run(spool);
  if (!finished) { fputs("strings: output limit exceeded\n", stderr); return 1; }
  if (finished < 0) { fputs("strings: memory unavailable\n", stderr); return 1; }
  return 0;
}

static int cmd_strings(int ac, char **av) {
  size_t minimum = 4; int seen_minimum = 0, i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (strcmp(av[i], "-n")) { fputs("strings: unsupported option\n", stderr); return 2; }
    if (seen_minimum) { fputs("strings: -n may be specified only once\n", stderr); return 2; }
    if (i + 1 >= ac) { fputs("strings: -n requires MIN\n", stderr); return 2; }
    if (!strings_parse_minimum(av[i + 1], &minimum)) {
      fputs("strings: MIN must be decimal from 1 to 65536\n", stderr); return 2;
    }
    seen_minimum = 1; i += 2;
  }
  int operand_count = ac - i;
  if (operand_count > STRINGS_OPERAND_LIMIT) {
    fputs("strings: too many inputs (max 100)\n", stderr); return 2;
  }

  int stdin_count = operand_count ? 0 : 1;
  for (int input = 0; input < operand_count; input++) {
    const char *name = av[i + input]; size_t length = strlen(name);
    if (!length) { fputs("strings: input path must not be empty\n", stderr); return 2; }
    if (length > STRINGS_PATH_LIMIT) {
      fputs("strings: input path exceeds 4096 bytes\n", stderr); return 2;
    }
    if (!strcmp(name, "-")) stdin_count++;
  }
  if (stdin_count > 1) { fputs("strings: standard input may be used only once\n", stderr); return 1; }

  char *resolved[STRINGS_OPERAND_LIMIT]; memset(resolved, 0, sizeof resolved);
  size_t known_total = 0; int preflight_status = 0;
  for (int input = 0; input < operand_count; input++) {
    const char *name = av[i + input];
    if (!strcmp(name, "-")) continue;
    resolved[input] = canonical_existing_path(name);
    if (!resolved[input]) { preflight_status = strings_input_error(name, "cannot open"); break; }
    struct stat status;
    if (stat(resolved[input], &status)) {
      preflight_status = strings_input_error(name, "cannot open"); break;
    }
    if (!S_ISREG(status.st_mode)) {
      preflight_status = strings_input_error(name, "not a regular file"); break;
    }
    if (status.st_size < 0 || status.st_size > (off_t)DATA_LIMIT) {
      preflight_status = strings_input_error(name, "input limit exceeded"); break;
    }
    size_t size = (size_t)status.st_size;
    if (known_total > STRINGS_EXPLICIT_INPUT_LIMIT - size) {
      fputs("strings: aggregate explicit input limit exceeded\n", stderr);
      preflight_status = 1; break;
    }
    known_total += size;
  }
  if (preflight_status) {
    for (int input = 0; input < operand_count; input++) free(resolved[input]);
    return preflight_status;
  }

  strings_spool spool; memset(&spool, 0, sizeof spool); spool.minimum = minimum;
  spool.pending = malloc(minimum);
  if (!spool.pending) {
    for (int input = 0; input < operand_count; input++) free(resolved[input]);
    fputs("strings: memory unavailable\n", stderr); return 1;
  }
  int rc = 0; size_t explicit_total = 0;
  int input_count = operand_count ? operand_count : 1;
  for (int input = 0; input < input_count; input++) {
    const char *name = operand_count ? av[i + input] : "-";
    FILE *file = !strcmp(name, "-") ? stdin : fopen(resolved[input], "rb");
    if (!file) { rc = strings_input_error(name, "cannot open"); break; }
    rc = strings_scan_input(file, name, &spool,
                            !strcmp(name, "-") ? NULL : &explicit_total);
    int close_failed = file != stdin && fclose(file) == EOF;
    if (!rc && close_failed) rc = strings_input_error(name, "cannot read");
    if (rc) break;
  }
  if (!rc && ((spool.used && fwrite(spool.data, 1, spool.used, stdout) != spool.used) ||
              fflush(stdout) == EOF)) {
    fputs("strings: cannot write output\n", stderr); rc = 1;
  }
  free(spool.pending); free(spool.data);
  for (int input = 0; input < operand_count; input++) free(resolved[input]);
  return rc;
}

static void truncate_usage(FILE *stream) {
  fputs("usage: truncate -s SIZE [--] FILE  # decimal bytes 0..67108864; "
        "one regular file; final symlinks rejected\n", stream);
}

static int truncate_input_error(const char *name, const char *message) {
  fputs("truncate: ", stderr); render_bounded_name(stderr, name);
  fprintf(stderr, ": %s\n", message); return 1;
}

static int truncate_parse_size(const char *text, off_t *result) {
  size_t length = strlen(text);
  if (!length || length > 20) return 0;
  uint64_t value = 0;
  for (const unsigned char *cursor = (const unsigned char *)text; *cursor; cursor++) {
    if (*cursor < '0' || *cursor > '9') return 0;
    uint64_t digit = (uint64_t)(*cursor - '0');
    if (value > ((uint64_t)TRUNCATE_SIZE_LIMIT - digit) / 10) return 0;
    value = value * 10 + digit;
  }
  *result = (off_t)value; return 1;
}

static int cmd_truncate(int ac, char **av) {
  if (ac < 2 || strcmp(av[1], "-s")) {
    fputs("truncate: expected -s SIZE and one FILE\n", stderr); return 2;
  }
  if (ac < 3) { fputs("truncate: -s requires SIZE\n", stderr); return 2; }
  off_t size;
  if (!truncate_parse_size(av[2], &size)) {
    fputs("truncate: SIZE must be decimal from 0 to 67108864\n", stderr); return 2;
  }
  int delimited = ac > 3 && !strcmp(av[3], "--");
  int file_index = delimited ? 4 : 3;
  if (ac - file_index != 1) {
    fputs("truncate: expected exactly one FILE\n", stderr); return 2;
  }
  const char *name = av[file_index]; size_t length = strlen(name);
  if (!length) { fputs("truncate: FILE must not be empty\n", stderr); return 2; }
  if (!delimited && name[0] == '-' && name[1]) {
    fputs("truncate: dash-leading FILE requires --\n", stderr); return 2;
  }
  if (length > TRUNCATE_PATH_LIMIT) {
    fputs("truncate: FILE exceeds 4096 bytes\n", stderr); return 2;
  }
  if (!cp_path_component_limit(name)) {
    fputs("truncate: FILE exceeds 128 components\n", stderr); return 2;
  }
  if (length > 1 && name[length - 1] == '/') {
    return truncate_input_error(name, "not a regular file");
  }

  char *physical = mv_canonical_entry_path(name);
  if (!physical) return truncate_input_error(name, "cannot resolve parent");
  struct stat before;
  int existed = lstat(physical, &before) == 0;
  if (!existed && errno != ENOENT) {
    free(physical); return truncate_input_error(name, "cannot inspect");
  }
  if (existed && !S_ISREG(before.st_mode)) {
    free(physical); return truncate_input_error(name, "not a regular file");
  }

  int fd = open(physical, O_WRONLY | O_CREAT | O_NOFOLLOW, 0666);
  if (fd < 0) { free(physical); return truncate_input_error(name, "cannot open"); }
  struct stat opened;
  if (fstat(fd, &opened) || !S_ISREG(opened.st_mode)) {
    close(fd); free(physical); return truncate_input_error(name, "not a regular file");
  }
  if (ftruncate(fd, size)) {
    close(fd); free(physical); return truncate_input_error(name, "cannot resize");
  }
  if (close(fd)) { free(physical); return truncate_input_error(name, "cannot close"); }
  free(physical); return 0;
}

typedef struct { char *data; size_t length; int newline; } diff_line;

static diff_line *diff_split(char *data, size_t size, size_t *count) {
  size_t lines = 0;
  for (size_t i = 0; i < size; i++) if (data[i] == '\n') lines++;
  if (size && data[size - 1] != '\n') lines++;
  if (lines > DIFF_LINES) { errno = E2BIG; return NULL; }
  diff_line *result = lines ? malloc(lines * sizeof *result) : NULL;
  if (lines && !result) return NULL;
  size_t start = 0, used = 0;
  for (size_t i = 0; i < size; i++) {
    if (data[i] != '\n') continue;
    result[used++] = (diff_line){data + start, i - start, 1}; start = i + 1;
  }
  if (start < size) result[used++] = (diff_line){data + start, size - start, 0};
  *count = used; return result;
}

static int diff_line_equal(const diff_line *a, const diff_line *b) {
  return a->length == b->length && a->newline == b->newline &&
         memcmp(a->data, b->data, a->length) == 0;
}

static void diff_emit(char prefix, const diff_line *line) {
  putchar(prefix); fwrite(line->data, 1, line->length, stdout);
  putchar('\n');
  if (!line->newline) puts("\\ No newline at end of file");
}

static unsigned long diff_range_start(size_t index, size_t count) {
  return (unsigned long)(count ? index + 1 : index);
}

static int cmd_diff(int ac, char **av) {
  int brief = 0, context = 3, i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "-u") || !strcmp(av[i], "--unified")) { brief = 0; i++; continue; }
    if (!strcmp(av[i], "-q") || !strcmp(av[i], "--brief")) { brief = 1; i++; continue; }
    const char *value = NULL;
    if (!strcmp(av[i], "-U") && i + 1 < ac) { value = av[i + 1]; i += 2; }
    else if (!strncmp(av[i], "-U", 2) && av[i][2]) { value = av[i] + 2; i++; }
    else if (!strncmp(av[i], "--unified=", 10)) { value = av[i] + 10; i++; }
    if (value) {
      char *end = NULL; long parsed = strtol(value, &end, 10);
      if (!*value || *end || parsed < 0 || parsed > 1000) {
        fprintf(stderr, "diff: invalid context: %s\n", value); return 2;
      }
      context = (int)parsed; brief = 0; continue;
    }
    fprintf(stderr, "diff: unsupported option: %s\n", av[i]); return 2;
  }
  if (ac - i != 2) { fprintf(stderr, "diff: expected exactly two files\n"); return 2; }
  const char *left_name = av[i], *right_name = av[i + 1];
  if (!strcmp(left_name, "-") && !strcmp(right_name, "-")) {
    fprintf(stderr, "diff: both inputs cannot be stdin\n"); return 2;
  }
  FILE *left = open_input(left_name); if (!left) { errorf(left_name); return 2; }
  FILE *right = open_input(right_name);
  if (!right) { if (left != stdin) fclose(left); errorf(right_name); return 2; }
  size_t left_size = 0, right_size = 0;
  errno = 0;
  char *left_data = read_all(left, &left_size);
  int left_error = ferror(left), left_errno = errno; if (left != stdin) fclose(left);
  errno = 0;
  char *right_data = read_all(right, &right_size);
  int right_error = ferror(right), right_errno = errno; if (right != stdin) fclose(right);
  if (!left_data || left_error) {
    errno = left_errno ? left_errno : left_error ? EIO : ENOMEM;
    errorf(left_name); free(left_data); free(right_data); return 2;
  }
  if (!right_data || right_error) {
    errno = right_errno ? right_errno : right_error ? EIO : ENOMEM;
    errorf(right_name); free(left_data); free(right_data); return 2;
  }
  if (left_size == right_size && !memcmp(left_data, right_data, left_size)) {
    free(left_data); free(right_data); return 0;
  }
  if (brief) {
    printf("Files %s and %s differ\n", left_name, right_name);
    free(left_data); free(right_data); return 1;
  }
  size_t left_count = 0, right_count = 0;
  diff_line *left_lines = diff_split(left_data, left_size, &left_count);
  diff_line *right_lines = diff_split(right_data, right_size, &right_count);
  if ((left_count && !left_lines) || (right_count && !right_lines)) {
    fprintf(stderr, "diff: input exceeds %d lines or memory is unavailable\n", DIFF_LINES);
    free(left_lines); free(right_lines); free(left_data); free(right_data); return 2;
  }
  size_t prefix = 0;
  while (prefix < left_count && prefix < right_count &&
         diff_line_equal(&left_lines[prefix], &right_lines[prefix])) prefix++;
  size_t suffix = 0;
  while (suffix < left_count - prefix && suffix < right_count - prefix &&
         diff_line_equal(&left_lines[left_count - suffix - 1],
                         &right_lines[right_count - suffix - 1])) suffix++;
  size_t before = prefix < (size_t)context ? prefix : (size_t)context;
  size_t after = suffix < (size_t)context ? suffix : (size_t)context;
  size_t left_start = prefix - before, right_start = prefix - before;
  size_t left_changed = left_count - prefix - suffix;
  size_t right_changed = right_count - prefix - suffix;
  size_t left_hunk = before + left_changed + after;
  size_t right_hunk = before + right_changed + after;
  printf("--- %s\n+++ %s\n", left_name, right_name);
  printf("@@ -%lu,%lu +%lu,%lu @@\n",
         diff_range_start(left_start, left_hunk), (unsigned long)left_hunk,
         diff_range_start(right_start, right_hunk), (unsigned long)right_hunk);
  for (size_t n = prefix - before; n < prefix; n++) diff_emit(' ', &left_lines[n]);
  for (size_t n = prefix; n < left_count - suffix; n++) diff_emit('-', &left_lines[n]);
  for (size_t n = prefix; n < right_count - suffix; n++) diff_emit('+', &right_lines[n]);
  for (size_t n = left_count - suffix; n < left_count - suffix + after; n++)
    diff_emit(' ', &left_lines[n]);
  free(left_lines); free(right_lines); free(left_data); free(right_data); return 1;
}

static void path_parent(char *path) {
  char *slash = strrchr(path, '/');
  if (!slash || slash == path) path[0] = 0;
  else *slash = 0;
}

static char *canonical_path(
  const char *input,
  int allow_missing_final,
  int allow_missing_suffix,
  int component_limit,
  int *exists,
  int *link_count
) {
  enum { PATH_CAP = 65536, LINK_LIMIT = 40 };
  if (!input || !*input) { errno = ENOENT; return NULL; }
  if (exists) *exists = 1;
  char *todo = malloc(PATH_CAP), *resolved = malloc(PATH_CAP), *scratch = malloc(PATH_CAP);
  if (!todo || !resolved || !scratch) {
    free(todo); free(resolved); free(scratch); errno = ENOMEM; return NULL;
  }
  if (strlen(input) >= PATH_CAP) { errno = ENAMETOOLONG; goto fail; }
  strcpy(todo, input);
  if (*input == '/') resolved[0] = 0;
  else {
    const char *cwd = getenv("PIODIDE_CWD");
    if (!cwd || !*cwd) cwd = getenv("PWD");
    if (!cwd || *cwd != '/') cwd = "/home/web";
    if (strlen(cwd) >= PATH_CAP) { errno = ENAMETOOLONG; goto fail; }
    strcpy(resolved, cwd);
    if (!strcmp(resolved, "/")) resolved[0] = 0;
  }
  int links = link_count ? *link_count : 0, components = 0, missing_components = 0;
  for (;;) {
    char *start = todo; while (*start == '/') start++;
    if (!*start) break;
    char *end = start; while (*end && *end != '/') end++;
    size_t component_len = (size_t)(end - start);
    if (component_limit && ++components > component_limit) {
      errno = ENAMETOOLONG; goto fail;
    }
    if (component_len + 1 > PATH_CAP) { errno = ENAMETOOLONG; goto fail; }
    memcpy(scratch, start, component_len); scratch[component_len] = 0;
    memmove(todo, end, strlen(end) + 1);
    if (!strcmp(scratch, ".")) continue;
    if (!strcmp(scratch, "..")) {
      path_parent(resolved);
      if (missing_components) missing_components--;
      continue;
    }

    size_t base_len = strlen(resolved);
    if (base_len + component_len + 2 > PATH_CAP) { errno = ENAMETOOLONG; goto fail; }
    resolved[base_len] = '/';
    memcpy(resolved + base_len + 1, scratch, component_len + 1);
    if (missing_components) { missing_components++; continue; }
    struct stat st;
    if (lstat(resolved, &st)) {
      char *remaining = todo; while (*remaining == '/') remaining++;
      if (allow_missing_suffix && errno == ENOENT) {
        missing_components = 1;
        if (exists) *exists = 0;
        continue;
      }
      if (allow_missing_final && errno == ENOENT && !*remaining &&
          input[strlen(input) - 1] != '/') {
        if (exists) *exists = 0;
        break;
      }
      goto fail;
    }
    if (!S_ISLNK(st.st_mode)) {
      char *remaining = todo; while (*remaining == '/') remaining++;
      if (*remaining && !S_ISDIR(st.st_mode)) { errno = ENOTDIR; goto fail; }
      continue;
    }
    if (++links > LINK_LIMIT) { errno = ELOOP; goto fail; }

    ssize_t length = readlink(resolved, scratch, PATH_CAP - 1);
    if (length < 0) goto fail;
    scratch[length] = 0;
    path_parent(resolved);
    if (scratch[0] == '/') resolved[0] = 0;
    size_t link_len = (size_t)length, todo_len = strlen(todo);
    if (link_len + todo_len + 2 > PATH_CAP) { errno = ENAMETOOLONG; goto fail; }
    if (todo_len && todo[0] != '/' && link_len && scratch[link_len - 1] != '/') {
      scratch[link_len++] = '/'; scratch[link_len] = 0;
    }
    memmove(todo + link_len, todo, todo_len + 1);
    memcpy(todo, scratch, link_len);
  }
  if (!*resolved) strcpy(resolved, "/");
  if (input[strlen(input) - 1] == '/' && !missing_components) {
    struct stat st;
    if (stat(resolved, &st)) goto fail;
    if (!S_ISDIR(st.st_mode)) { errno = ENOTDIR; goto fail; }
  }
  if (link_count) *link_count = links;
  free(todo); free(scratch); return resolved;
fail:
  free(todo); free(resolved); free(scratch); return NULL;
}

static char *canonical_existing_path(const char *input) {
  return canonical_path(input, 0, 0, 0, NULL, NULL);
}

static char *canonical_existing_path_counted(const char *input, int *link_count) {
  return canonical_path(input, 0, 0, 0, NULL, link_count);
}

static char *canonical_touch_target(const char *input, int *exists) {
  return canonical_path(input, 1, 0, 0, exists, NULL);
}

static char *canonical_missing_path(const char *input) {
  enum { PATH_CAP = 65536 };
  if (!input || !*input) { errno = ENOENT; return NULL; }
  if (*input == '/')
    return canonical_path(input, 0, 1, REALPATH_MISSING_COMPONENT_LIMIT, NULL, NULL);
  const char *cwd = getenv("PIODIDE_CWD");
  if (!cwd || !*cwd) cwd = getenv("PWD");
  if (!cwd || *cwd != '/') cwd = "/home/web";
  size_t cwd_length = strlen(cwd), input_length = strlen(input);
  if (cwd_length + input_length + 2 > PATH_CAP) { errno = ENAMETOOLONG; return NULL; }
  char *absolute = malloc(cwd_length + input_length + 2);
  if (!absolute) { errno = ENOMEM; return NULL; }
  memcpy(absolute, cwd, cwd_length);
  if (!cwd_length || absolute[cwd_length - 1] != '/') absolute[cwd_length++] = '/';
  memcpy(absolute + cwd_length, input, input_length + 1);
  char *resolved = canonical_path(
    absolute, 0, 1, REALPATH_MISSING_COMPONENT_LIMIT, NULL, NULL
  );
  free(absolute); return resolved;
}

static int cmd_readlink(int ac, char **av) {
  int canonical = 0, i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "-f") || !strcmp(av[i], "--canonicalize")) canonical = 1;
    else if (!strcmp(av[i], "--")) { i++; break; }
    else { fprintf(stderr, "readlink: unsupported option: %s\n", av[i]); return 2; }
    i++;
  }
  if (ac - i != 1) { fprintf(stderr, "readlink: expected one path\n"); return 2; }
  if (canonical) {
    char *resolved = canonical_existing_path(av[i]);
    if (!resolved) return errorf(av[i]);
    puts(resolved); free(resolved); return 0;
  }
  char buf[65536]; ssize_t n = readlink(av[i], buf, sizeof buf - 1);
  if (n < 0) return errorf(av[i]); buf[n] = 0; puts(buf); return 0;
}

static int cmd_realpath(int ac, char **av) {
  int i = 1, existing_mode = 0, missing_mode = 0;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "-e") || !strcmp(av[i], "--canonicalize-existing")) {
      if (missing_mode) { fprintf(stderr, "realpath: -e and -m are mutually exclusive\n"); return 2; }
      existing_mode = 1; i++; continue;
    }
    if (!strcmp(av[i], "-m") || !strcmp(av[i], "--canonicalize-missing")) {
      if (existing_mode) { fprintf(stderr, "realpath: -e and -m are mutually exclusive\n"); return 2; }
      missing_mode = 1; i++; continue;
    }
    if (!strcmp(av[i], "-P") || !strcmp(av[i], "--physical")) { i++; continue; }
    fprintf(stderr, "realpath: unsupported option: %s\n", av[i]); return 2;
  }
  if (i == ac) { fprintf(stderr, "realpath: missing operand\n"); return 2; }
  if (missing_mode) {
    int operand_count = ac - i;
    if (operand_count > REALPATH_MISSING_OPERANDS) {
      fprintf(stderr, "realpath: more than %d operands\n", REALPATH_MISSING_OPERANDS); return 2;
    }
    char *results[REALPATH_MISSING_OPERANDS]; memset(results, 0, sizeof results);
    int rc = 0;
    for (int operand = 0; operand < operand_count; operand++) {
      const char *input = av[i + operand];
      if (strlen(input) > REALPATH_MISSING_PATH_LIMIT) {
        fprintf(stderr, "realpath: %s: input exceeds %d bytes\n",
                input, REALPATH_MISSING_PATH_LIMIT);
        rc = 1; continue;
      }
      results[operand] = canonical_missing_path(input);
      if (!results[operand]) { errorf(input); rc = 1; continue; }
      if (strlen(results[operand]) > REALPATH_MISSING_PATH_LIMIT) {
        fprintf(stderr, "realpath: %s: result exceeds %d bytes\n",
                input, REALPATH_MISSING_PATH_LIMIT);
        free(results[operand]); results[operand] = NULL; rc = 1;
      }
    }
    if (rc) {
      for (int operand = 0; operand < operand_count; operand++) free(results[operand]);
      return 1;
    }
    size_t output_length = 0;
    for (int operand = 0; operand < operand_count; operand++)
      output_length += strlen(results[operand]) + 1;
    char *output = malloc(output_length ? output_length : 1);
    if (!output) {
      errno = ENOMEM; errorf("output");
      for (int operand = 0; operand < operand_count; operand++) free(results[operand]);
      return 1;
    }
    size_t used = 0;
    for (int operand = 0; operand < operand_count; operand++) {
      size_t length = strlen(results[operand]);
      memcpy(output + used, results[operand], length); used += length;
      output[used++] = '\n'; free(results[operand]);
    }
    if (output_length && fwrite(output, 1, output_length, stdout) != output_length)
      rc = errorf("stdout");
    free(output); return rc;
  }
  int rc = 0;
  for (; i < ac; i++) {
    char *resolved = canonical_existing_path(av[i]);
    if (!resolved) { errorf(av[i]); rc = 1; continue; }
    puts(resolved); free(resolved);
  }
  return rc;
}

struct du_output {
  char *data;
  size_t length;
  size_t capacity;
  int records;
};

struct du_context {
  struct du_output output;
  int seen;
  int output_depth;
};

static int du_append_record(struct du_context *context, uint64_t size, const char *path) {
  if (context->output.records >= DU_RECORDS) {
    fprintf(stderr, "du: output exceeds %d records\n", DU_RECORDS); return 1;
  }
  char number[32];
  int number_length = snprintf(number, sizeof number, "%llu", (unsigned long long)size);
  size_t path_length = strlen(path);
  if (number_length < 0 || path_length > SIZE_MAX - (size_t)number_length - 2) {
    fprintf(stderr, "du: output size overflow\n"); return 1;
  }
  size_t record_length = (size_t)number_length + path_length + 2;
  if (record_length > DU_OUTPUT_LIMIT - context->output.length) {
    fprintf(stderr, "du: output exceeds %d bytes\n", DU_OUTPUT_LIMIT); return 1;
  }
  size_t needed = context->output.length + record_length;
  if (needed > context->output.capacity) {
    size_t capacity = context->output.capacity ? context->output.capacity : 4096;
    while (capacity < needed) {
      if (capacity > DU_OUTPUT_LIMIT / 2) { capacity = DU_OUTPUT_LIMIT; break; }
      capacity *= 2;
    }
    char *grown = realloc(context->output.data, capacity);
    if (!grown) { errno = ENOMEM; return errorf("output"); }
    context->output.data = grown; context->output.capacity = capacity;
  }
  memcpy(context->output.data + context->output.length, number, (size_t)number_length);
  context->output.length += (size_t)number_length;
  context->output.data[context->output.length++] = '\t';
  memcpy(context->output.data + context->output.length, path, path_length);
  context->output.length += path_length;
  context->output.data[context->output.length++] = '\n';
  context->output.records++;
  return 0;
}

static int du_name_compare(const void *left, const void *right) {
  return strcmp(*(const char *const *)left, *(const char *const *)right);
}

static void du_free_names(char **names, size_t count) {
  for (size_t i = 0; i < count; i++) free(names[i]);
  free(names);
}

static char *du_join_path(const char *parent, const char *name) {
  size_t parent_length = strlen(parent), name_length = strlen(name);
  int separator = parent_length && parent[parent_length - 1] != '/';
  if (parent_length > DU_PATH_LIMIT || name_length > DU_PATH_LIMIT ||
      parent_length + (size_t)separator > DU_PATH_LIMIT - name_length) {
    errno = ENAMETOOLONG; return NULL;
  }
  size_t length = parent_length + (size_t)separator + name_length;
  char *joined = malloc(length + 1); if (!joined) { errno = ENOMEM; return NULL; }
  memcpy(joined, parent, parent_length);
  if (separator) joined[parent_length++] = '/';
  memcpy(joined + parent_length, name, name_length + 1);
  return joined;
}

static int du_walk(struct du_context *context, const char *lookup_path,
                   const char *display_path, int depth, uint64_t *total) {
  if (depth > DU_DEPTH_LIMIT) {
    fprintf(stderr, "du: traversal exceeds %d levels: %s\n", DU_DEPTH_LIMIT, display_path);
    return 1;
  }
  if (context->seen++ >= DU_ENTRIES) {
    fprintf(stderr, "du: traversal exceeds %d entries\n", DU_ENTRIES); return 1;
  }

  struct stat status;
  if (lstat(lookup_path, &status)) return errorf(display_path);
  uint64_t size = 0;
  if (S_ISREG(status.st_mode)) {
    if (status.st_size < 0) {
      fprintf(stderr, "du: negative file size: %s\n", display_path); return 1;
    }
    size = (uint64_t)status.st_size;
  } else if (S_ISDIR(status.st_mode)) {
    DIR *directory = opendir(lookup_path); if (!directory) return errorf(display_path);
    char **names = NULL; size_t count = 0, capacity = 0; int rc = 0;
    for (;;) {
      errno = 0; struct dirent *entry = readdir(directory);
      if (!entry) {
        if (errno) rc = errorf(display_path);
        break;
      }
      if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
      if (count >= (size_t)(DU_ENTRIES - context->seen)) {
        fprintf(stderr, "du: traversal exceeds %d entries\n", DU_ENTRIES); rc = 1; break;
      }
      if (count == capacity) {
        size_t next = capacity ? capacity * 2 : 32;
        if (next > DU_ENTRIES) next = DU_ENTRIES;
        char **grown = realloc(names, next * sizeof *names);
        if (!grown) { errno = ENOMEM; rc = errorf(display_path); break; }
        names = grown; capacity = next;
      }
      names[count] = strdup(entry->d_name);
      if (!names[count]) { errno = ENOMEM; rc = errorf(display_path); break; }
      count++;
    }
    if (closedir(directory) && !rc) rc = errorf(display_path);
    if (!rc) qsort(names, count, sizeof *names, du_name_compare);
    for (size_t i = 0; i < count && !rc; i++) {
      char *child_lookup = du_join_path(lookup_path, names[i]);
      char *child_display = du_join_path(display_path, names[i]);
      if (!child_lookup || !child_display) {
        free(child_lookup); free(child_display); rc = errorf(display_path); break;
      }
      uint64_t child_size = 0;
      if (du_walk(context, child_lookup, child_display, depth + 1, &child_size)) rc = 1;
      else if (UINT64_MAX - size < child_size) {
        fprintf(stderr, "du: size overflow: %s\n", display_path); rc = 1;
      } else size += child_size;
      free(child_lookup); free(child_display);
    }
    du_free_names(names, count);
    if (rc) return 1;
  }

  if (depth <= context->output_depth && du_append_record(context, size, display_path)) return 1;
  *total = size; return 0;
}

static int du_parse_depth(const char *text, int *depth) {
  if (!*text) return 0;
  int value = 0;
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (!isdigit(*p)) return 0;
    value = value * 10 + (*p - '0');
    if (value > DU_DEPTH_LIMIT) return 0;
  }
  *depth = value; return 1;
}

static int cmd_du(int ac, char **av) {
  int i = 1, all = 0, depth_set = 0, output_depth = 0, terminated = 0;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { terminated = 1; i++; break; }
    if (!strcmp(av[i], "-a")) {
      if (all) { fprintf(stderr, "du: duplicate -a\n"); return 2; }
      all = 1; i++; continue;
    }
    if (!strcmp(av[i], "-d")) {
      if (depth_set) { fprintf(stderr, "du: duplicate -d\n"); return 2; }
      if (i + 1 >= ac || !du_parse_depth(av[i + 1], &output_depth)) {
        fprintf(stderr, "du: depth must be a decimal integer from 0 to %d\n", DU_DEPTH_LIMIT);
        return 2;
      }
      depth_set = 1; i += 2; continue;
    }
    fprintf(stderr, "du: unsupported option: %s\n", av[i]); return 2;
  }
  if (!all || !depth_set) {
    fprintf(stderr, "du: required form is du -a -d DEPTH [--] PATH...\n"); return 2;
  }
  int path_count = ac - i;
  if (path_count < 1 || path_count > DU_PATHS) {
    fprintf(stderr, "du: expected 1 to %d paths\n", DU_PATHS); return 2;
  }
  size_t path_bytes = 0;
  for (int path_index = i; path_index < ac; path_index++) {
    if (!terminated && av[path_index][0] == '-' && av[path_index][1]) {
      fprintf(stderr, "du: option-looking path requires --: %s\n", av[path_index]); return 2;
    }
    size_t length = strlen(av[path_index]);
    if (length > DU_PATH_LIMIT) {
      fprintf(stderr, "du: path exceeds %d bytes\n", DU_PATH_LIMIT); return 2;
    }
    if (length > DU_PATH_TOTAL_LIMIT - path_bytes) {
      fprintf(stderr, "du: path operands exceed %d bytes\n", DU_PATH_TOTAL_LIMIT); return 2;
    }
    path_bytes += length;
  }

  struct du_context context = {.output_depth = output_depth};
  int rc = 0;
  for (int path_index = i; path_index < ac; path_index++) {
    size_t length = strlen(av[path_index]);
    char *lookup = strdup(av[path_index]);
    if (!lookup) { errno = ENOMEM; errorf(av[path_index]); rc = 1; break; }
    while (length > 1 && lookup[length - 1] == '/') lookup[--length] = 0;
    uint64_t total = 0;
    if (du_walk(&context, lookup, av[path_index], 0, &total)) rc = 1;
    free(lookup);
    if (rc) break;
  }
  if (!rc && context.output.length &&
      fwrite(context.output.data, 1, context.output.length, stdout) != context.output.length) {
    rc = errorf("stdout");
  }
  free(context.output.data); return rc;
}

static void find_print(const char *path, int nul) {
  fwrite(path, 1, strlen(path), stdout);
  putchar(nul ? '\0' : '\n');
}

enum find_action {
  FIND_ACTION_PRINT,
  FIND_ACTION_PRINT0,
  FIND_ACTION_DELETE,
};

static int find_seen, find_limit_reported;

static int find_walk(const char *path, const char *name_pattern, const char *path_pattern,
                     int wanted, int depth, int min_depth, int max_depth,
                     enum find_action action) {
  if (depth > 128) { fprintf(stderr, "find: recursion exceeds 128 levels: %s\n", path); return 1; }
  if (find_seen++ >= FIND_ENTRIES) {
    if (!find_limit_reported++) fprintf(stderr, "find: traversal exceeds %d entries\n", FIND_ENTRIES);
    return 1;
  }
  struct stat st; if (lstat(path, &st)) return errorf(path);
  int type = S_ISDIR(st.st_mode) ? 'd' : S_ISREG(st.st_mode) ? 'f' : S_ISLNK(st.st_mode) ? 'l' : 0;
  int selected = depth >= min_depth && (!wanted || wanted == type) &&
    (!name_pattern || fnmatch(name_pattern, base(path), 0) == 0) &&
    (!path_pattern || fnmatch(path_pattern, path, 0) == 0);
  if (selected && action != FIND_ACTION_DELETE)
    find_print(path, action == FIND_ACTION_PRINT0);

  int rc = 0;
  if (type == 'd' && (max_depth < 0 || depth < max_depth)) {
    DIR *d = opendir(path); if (!d) return errorf(path);
    struct dirent *e;
    while ((e = readdir(d))) {
      if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
      size_t n = strlen(path) + strlen(e->d_name) + 2;
      char *child = malloc(n); if (!child) { errno = ENOMEM; errorf(path); rc = 1; break; }
      snprintf(child, n, "%s/%s", path, e->d_name);
      if (find_walk(child, name_pattern, path_pattern, wanted, depth + 1,
                    min_depth, max_depth, action)) rc = 1;
      free(child);
    }
    closedir(d);
  }
  if (action == FIND_ACTION_DELETE && selected && !rc) {
    if (type == 'd' ? rmdir(path) : unlink(path)) return errorf(path);
  }
  return rc;
}

static int cmd_find(int ac, char **av) {
  int i = 1; const char *paths[FIND_PATHS]; int np = 0;
  while (i < ac && av[i][0] != '-') {
    if (np == FIND_PATHS) {
      fprintf(stderr, "find: more than %d starting paths\n", FIND_PATHS); return 2;
    }
    paths[np++] = av[i++];
  }
  if (!np) paths[np++] = "."; const char *name_pattern = NULL, *path_pattern = NULL;
  int wanted = 0, min_depth = 0, max_depth = -1, explicit_action = 0;
  enum find_action action = FIND_ACTION_PRINT;
  while (i < ac) {
    if (!strcmp(av[i], "-name") && i + 1 < ac) { name_pattern = av[i + 1]; i += 2; }
    else if (!strcmp(av[i], "-path") && i + 1 < ac) { path_pattern = av[i + 1]; i += 2; }
    else if (!strcmp(av[i], "-type") && i + 1 < ac) {
      if (strlen(av[i + 1]) != 1 || !strchr("fdl", av[i + 1][0])) {
        fprintf(stderr, "find: invalid -type: %s\n", av[i + 1]); return 2;
      }
      wanted = av[i + 1][0]; i += 2;
    }
    else if ((!strcmp(av[i], "-maxdepth") || !strcmp(av[i], "-mindepth")) && i + 1 < ac) {
      int is_minimum = !strcmp(av[i], "-mindepth");
      char *end = NULL; long value = strtol(av[i + 1], &end, 10);
      if (*end || value < 0 || value > 128) {
        fprintf(stderr, "find: invalid %s: %s\n", av[i], av[i + 1]); return 2;
      }
      if (is_minimum) min_depth = (int)value; else max_depth = (int)value;
      i += 2;
    }
    else if (!strcmp(av[i], "-print") || !strcmp(av[i], "-print0") ||
             !strcmp(av[i], "-delete")) {
      if (explicit_action) {
        fprintf(stderr, "find: multiple actions are unsupported\n"); return 2;
      }
      if (i + 1 != ac) {
        fprintf(stderr, "find: action must be final: %s\n", av[i]); return 2;
      }
      action = !strcmp(av[i], "-delete") ? FIND_ACTION_DELETE :
        !strcmp(av[i], "-print0") ? FIND_ACTION_PRINT0 : FIND_ACTION_PRINT;
      explicit_action = 1; i++;
    }
    else { fprintf(stderr, "find: unsupported expression: %s\n", av[i]); return 2; }
  }
  int rc = 0; find_seen = find_limit_reported = 0;
  for (i = 0; i < np; i++)
    if (find_walk(paths[i], name_pattern, path_pattern, wanted, 0,
                  min_depth, max_depth, action)) rc = 1;
  return rc;
}

static int cmd_mktemp(int ac, char **av) {
  int directory = 0, temporary_directory = 0, i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "-d")) directory = 1;
    else if (!strcmp(av[i], "-t")) temporary_directory = 1;
    else if (!strcmp(av[i], "-dt") || !strcmp(av[i], "-td")) {
      directory = 1; temporary_directory = 1;
    }
    else { fprintf(stderr, "mktemp: unsupported option: %s\n", av[i]); return 2; }
    i++;
  }
  if (ac - i > 1) { fprintf(stderr, "mktemp: expected at most one template\n"); return 2; }
  const char *template = i < ac ? av[i] : "tmp.XXXXXX";
  if (!*template) { fprintf(stderr, "mktemp: empty template\n"); return 2; }
  if (temporary_directory && strchr(template, '/')) {
    fprintf(stderr, "mktemp: -t template must not contain '/'\n"); return 2;
  }
  const char *template_component = base(template);
  if (!*template_component || strlen(template_component) > MKTEMP_TEMPLATE_LIMIT) {
    fprintf(stderr, "mktemp: template component exceeds %d bytes\n", MKTEMP_TEMPLATE_LIMIT);
    return 2;
  }
  if (!strstr(template_component, "XXXXXX")) {
    fprintf(stderr, "mktemp: template must contain XXXXXX in its final component\n"); return 2;
  }

  char *pattern = NULL;
  if (temporary_directory) {
    const char *parent = getenv("TMPDIR"); if (!parent || !*parent) parent = "/tmp";
    size_t parent_length = strlen(parent), template_length = strlen(template);
    size_t separator_length = parent[parent_length - 1] == '/' ? 0 : 1;
    if (parent_length > MKTEMP_PATH_LIMIT ||
        separator_length > MKTEMP_PATH_LIMIT - parent_length ||
        template_length > MKTEMP_PATH_LIMIT - parent_length - separator_length) {
      fprintf(stderr, "mktemp: final path exceeds %d bytes\n", MKTEMP_PATH_LIMIT); return 2;
    }
    size_t n = parent_length + template_length + 2; pattern = malloc(n);
    if (pattern) snprintf(pattern, n, "%s%s%s", parent, parent[strlen(parent) - 1] == '/' ? "" : "/", template);
  } else pattern = strdup(template);
  if (!pattern) { errno = ENOMEM; return errorf(template); }
  if (strlen(pattern) > MKTEMP_PATH_LIMIT) {
    fprintf(stderr, "mktemp: final path exceeds %d bytes\n", MKTEMP_PATH_LIMIT);
    free(pattern); return 2;
  }
  if (!cp_path_component_limit(pattern)) {
    fprintf(stderr, "mktemp: path has more than %d components\n", MKTEMP_COMPONENT_LIMIT);
    free(pattern); return 2;
  }
  char *physical_pattern = mv_canonical_entry_path(pattern);
  if (!physical_pattern) { int rc = errorf(pattern); free(pattern); return rc; }

  char *xs = strstr((char *)base(pattern), "XXXXXX");
  char *physical_xs = strstr((char *)base(physical_pattern), "XXXXXX");
  int made = 0;
  for (unsigned attempt = 0; attempt < MKTEMP_ATTEMPT_LIMIT && !made; attempt++) {
    unsigned value = (unsigned)time(NULL) ^ (attempt * 2654435761u);
    static const char hex[] = "0123456789abcdef";
    for (int k = 0; k < 6; k++) {
      xs[k] = physical_xs[k] = hex[value & 15]; value >>= 4;
    }
    if (directory) made = mkdir(physical_pattern, 0700) == 0;
    else {
      FILE *f = fopen(physical_pattern, "wx");
      if (f) { if (fclose(f)) break; made = 1; }
    }
    if (!made && errno != EEXIST) break;
  }
  if (!made) {
    int rc = errorf(pattern); free(physical_pattern); free(pattern); return rc;
  }
  if (puts(pattern) == EOF) {
    if (!errno) errno = EIO;
    int rc = errorf("standard output"); free(physical_pattern); free(pattern); return rc;
  }
  free(physical_pattern); free(pattern); return 0;
}

static const char *stat_type(mode_t mode) {
  if (S_ISREG(mode)) return "regular file";
  if (S_ISDIR(mode)) return "directory";
  if (S_ISLNK(mode)) return "symbolic link";
  return "other";
}

static int stat_format_valid(const char *format) {
  for (const char *p = format; *p; p++) {
    if (*p != '%') continue;
    p++;
    if (!*p || !strchr("%snFidhY", *p)) {
      fprintf(stderr, "stat: unsupported format directive: %%%c\n", *p ? *p : '%');
      return 0;
    }
  }
  return 1;
}

static void stat_print(const char *format, const char *name, const struct stat *st) {
  for (const char *p = format; *p; p++) {
    if (*p != '%') { putchar(*p); continue; }
    switch (*++p) {
      case '%': putchar('%'); break;
      case 's': printf("%llu", (unsigned long long)st->st_size); break;
      case 'n': fputs(name, stdout); break;
      case 'F': fputs(stat_type(st->st_mode), stdout); break;
      case 'i': printf("%llu", (unsigned long long)st->st_ino); break;
      case 'd': printf("%llu", (unsigned long long)st->st_dev); break;
      case 'h': printf("%llu", (unsigned long long)st->st_nlink); break;
      case 'Y': printf("%lld", (long long)st->st_mtime); break;
    }
  }
  putchar('\n');
}

static int cmd_stat(int ac, char **av) {
  const char *format = "%n: %F, %s bytes"; int follow = 0, i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "-L") || !strcmp(av[i], "--dereference")) { follow = 1; i++; continue; }
    if ((!strcmp(av[i], "-c") || !strcmp(av[i], "--format")) && i + 1 < ac) {
      format = av[i + 1]; i += 2; continue;
    }
    if (!strncmp(av[i], "--format=", 9)) { format = av[i] + 9; i++; continue; }
    if (!strncmp(av[i], "-c", 2) && av[i][2]) { format = av[i] + 2; i++; continue; }
    fprintf(stderr, "stat: unsupported option: %s\n", av[i]); return 2;
  }
  if (i == ac) { fprintf(stderr, "stat: missing operand\n"); return 2; }
  if (!stat_format_valid(format)) return 2;
  int rc = 0;
  for (; i < ac; i++) {
    struct stat st; int result; char *resolved = NULL;
    if (follow) {
      resolved = canonical_existing_path(av[i]);
      result = resolved ? lstat(resolved, &st) : -1;
    } else result = lstat(av[i], &st);
    if (result) { errorf(av[i]); free(resolved); rc = 1; continue; }
    stat_print(format, av[i], &st);
    free(resolved);
  }
  return rc;
}

static int cmd_install(int ac, char **av) {
  int directory = 0, options_terminated = 0, i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "-d")) { directory = 1; i++; }
    else if (!strcmp(av[i], "-m") || !strcmp(av[i], "-o") || !strcmp(av[i], "-g")) {
      fprintf(stderr, "install: option %s is unsupported because metadata changes are unavailable\n", av[i]);
      return 2;
    }
    else if (!strcmp(av[i], "--")) { options_terminated = 1; i++; break; }
    else { fprintf(stderr, "install: unsupported option: %s\n", av[i]); return 2; }
  }
  for (int operand = i; !options_terminated && operand < ac; operand++) {
    if (av[operand][0] != '-' || !av[operand][1]) continue;
    fprintf(stderr, "install: unsupported option: %s\n", av[operand]); return 2;
  }

  int operand_count = ac - i;
  int operand_limit = directory ? INSTALL_DIRECTORY_LIMIT : INSTALL_SOURCE_LIMIT + 1;
  if ((!directory && operand_count < 2) || (directory && operand_count < 1)) {
    fprintf(stderr, "install: %s\n", directory ? "missing directory operand" : "source and destination required");
    return 2;
  }
  if (operand_count > operand_limit) {
    fprintf(stderr, "install: too many %s (max %d)\n",
            directory ? "directories" : "sources",
            directory ? INSTALL_DIRECTORY_LIMIT : INSTALL_SOURCE_LIMIT);
    return 2;
  }
  size_t path_bytes = 0;
  for (int operand = i; operand < ac; operand++) {
    size_t length = strlen(av[operand]);
    if (length > INSTALL_PATH_LIMIT) {
      fprintf(stderr, "install: path operand exceeds %d bytes\n", INSTALL_PATH_LIMIT); return 2;
    }
    if (length > INSTALL_PATH_TOTAL_LIMIT - path_bytes) {
      fprintf(stderr, "install: path operands exceed %d bytes\n", INSTALL_PATH_TOTAL_LIMIT); return 2;
    }
    path_bytes += length;
    if (!cp_path_component_limit(av[operand])) {
      fprintf(stderr, "install: path has more than %d components\n", INSTALL_COMPONENT_LIMIT); return 2;
    }
  }

  if (directory) {
    char *targets[INSTALL_DIRECTORY_LIMIT]; memset(targets, 0, sizeof targets);
    int preflight_error = 0;
    for (int operand = 0; operand < operand_count; operand++) {
      char *entry = mv_canonical_entry_path(av[i + operand]);
      if (entry) {
        struct stat entry_status;
        if (lstat(entry, &entry_status) == 0) {
          if (S_ISLNK(entry_status.st_mode)) {
            fprintf(stderr, "install: destination may not be a symbolic link: %s\n", av[i + operand]);
            free(entry); preflight_error = 1; break;
          }
        } else if (errno != ENOENT) {
          errorf(av[i + operand]); free(entry); preflight_error = 1; break;
        }
        free(entry);
      } else if (errno != ENOENT) {
        errorf(av[i + operand]); preflight_error = 1; break;
      }
      targets[operand] = cp_canonical_target_path(av[i + operand]);
      if (!targets[operand]) { errorf(av[i + operand]); preflight_error = 1; break; }
      struct stat status;
      if (stat(targets[operand], &status) == 0) {
        if (!S_ISDIR(status.st_mode)) {
          errno = ENOTDIR; errorf(av[i + operand]); preflight_error = 1; break;
        }
      } else if (errno != ENOENT) {
        errorf(av[i + operand]); preflight_error = 1; break;
      }
    }
    int rc = preflight_error;
    if (!preflight_error) {
      for (int operand = 0; operand < operand_count; operand++) {
        if (mkdir_parents(targets[operand])) { rc = 1; break; }
      }
    }
    for (int operand = 0; operand < operand_count; operand++) free(targets[operand]);
    return rc;
  }

  int source_count = operand_count - 1;
  const char *destination = av[ac - 1];
  struct install_plan {
    const char *source;
    char *target;
    char *physical_source;
    char *physical_target;
    struct stat source_status;
  } plans[INSTALL_SOURCE_LIMIT];
  memset(plans, 0, sizeof plans);

  int preflight_error = 0;
  for (int source_index = 0; source_index < source_count; source_index++) {
    struct install_plan *plan = &plans[source_index];
    plan->source = av[i + source_index];
    plan->physical_source = canonical_existing_path(plan->source);
    if (!plan->physical_source || stat(plan->physical_source, &plan->source_status)) {
      errorf(plan->source); preflight_error = 1; break;
    }
    if (!S_ISREG(plan->source_status.st_mode)) {
      errno = S_ISDIR(plan->source_status.st_mode) ? EISDIR : EINVAL;
      errorf(plan->source); preflight_error = 1; break;
    }
  }

  int destination_is_dir = 0;
  if (!preflight_error) {
    char *physical_destination = mv_canonical_entry_path(destination);
    if (!physical_destination) {
      errorf(destination); preflight_error = 1;
    } else {
      struct stat destination_status;
      if (lstat(physical_destination, &destination_status) == 0) {
        if (S_ISLNK(destination_status.st_mode)) {
          fprintf(stderr, "install: destination may not be a symbolic link: %s\n", destination);
          preflight_error = 1;
        } else if (S_ISDIR(destination_status.st_mode)) destination_is_dir = 1;
        else if (!S_ISREG(destination_status.st_mode)) {
          errno = EINVAL; errorf(destination); preflight_error = 1;
        }
      } else if (errno != ENOENT) {
        errorf(destination); preflight_error = 1;
      }
      free(physical_destination);
    }
  }
  if (!preflight_error && source_count > 1 && !destination_is_dir) {
    fprintf(stderr, "install: destination must be a directory\n"); preflight_error = 1;
  }

  for (int source_index = 0; source_index < source_count && !preflight_error; source_index++) {
    struct install_plan *plan = &plans[source_index];
    plan->target = cp_effective_target(plan->source, destination, destination_is_dir);
    if (!plan->target) { errorf(destination); preflight_error = 1; break; }
    plan->physical_target = mv_canonical_entry_path(plan->target);
    if (!plan->physical_target) { errorf(plan->target); preflight_error = 1; break; }

    struct stat target_status;
    if (lstat(plan->physical_target, &target_status) == 0) {
      if (S_ISLNK(target_status.st_mode)) {
        fprintf(stderr, "install: destination may not be a symbolic link: %s\n", plan->target);
        preflight_error = 1; break;
      }
      if (!S_ISREG(target_status.st_mode)) {
        errno = S_ISDIR(target_status.st_mode) ? EISDIR : EINVAL;
        errorf(plan->target); preflight_error = 1; break;
      }
      if (target_status.st_dev == plan->source_status.st_dev &&
          target_status.st_ino == plan->source_status.st_ino) {
        fprintf(stderr, "install: '%s' and '%s' are the same file\n", plan->source, plan->target);
        preflight_error = 1; break;
      }
    } else if (errno != ENOENT) {
      errorf(plan->target); preflight_error = 1; break;
    }
  }

  if (!preflight_error) {
    for (int left = 0; left < source_count && !preflight_error; left++) {
      for (int right = left + 1; right < source_count; right++) {
        if (!strcmp(plans[left].physical_target, plans[right].physical_target)) {
          fprintf(stderr, "install: multiple sources map to the same target\n");
          preflight_error = 1; break;
        }
      }
    }
  }

  int rc = preflight_error;
  if (!preflight_error) {
    for (int plan_index = 0; plan_index < source_count; plan_index++) {
      if (copy_file(plans[plan_index].physical_source, plans[plan_index].physical_target)) {
        rc = 1; break;
      }
    }
  }
  for (int plan_index = 0; plan_index < source_count; plan_index++) {
    free(plans[plan_index].target);
    free(plans[plan_index].physical_source);
    free(plans[plan_index].physical_target);
  }
  return rc;
}

static int cmd_chmod(int ac, char **av) {
  if (ac < 3) { fprintf(stderr, "usage: chmod MODE FILE...\n"); return 2; }
  char *end = NULL; long parsed = strtol(av[1], &end, 8);
  if (!*av[1] || *end || parsed < 0 || parsed > 07777) {
    fprintf(stderr, "chmod: invalid mode: %s\n", av[1]); return 2;
  }
  mode_t mode = (mode_t)parsed;
#ifdef __wasi__
  for (int i = 2; i < ac; i++) {
    struct stat st;
    if (stat(av[i], &st) != 0) {
      fprintf(stderr, "chmod: %s: %s\n", av[i], strerror(errno));
      return 1;
    }
  }
  (void)mode;
  fprintf(stderr, "chmod: mode changes are unsupported on this filesystem\n");
  return 2;
#else
  int rc = 0;
  for (int i = 2; i < ac; i++) {
    struct stat st;
    if (stat(av[i], &st) != 0) { fprintf(stderr, "chmod: %s: %s\n", av[i], strerror(errno)); rc = 1; continue; }
    if (chmod(av[i], mode) != 0) { fprintf(stderr, "chmod: %s: %s\n", av[i], strerror(errno)); rc = 1; }
  }
  return rc;
#endif
}

typedef struct { const unsigned char *data; size_t length; } uniq_record;

static int uniq_record_equal(const uniq_record *left, const uniq_record *right) {
  return left->length == right->length &&
    (!left->length || !memcmp(left->data, right->data, left->length));
}

static int uniq_split_records(char *data, size_t size, unsigned char delimiter,
                              uniq_record *records, size_t *record_count) {
  size_t count = 0, offset = 0;
  while (offset < size) {
    if (count >= SORT_LINES) {
      fprintf(stderr, "uniq: too many records (limit %d)\n", SORT_LINES); return 2;
    }
    size_t start = offset;
    while (offset < size && (unsigned char)data[offset] != delimiter) offset++;
    size_t length = offset - start;
    if (length > RECORD_LIMIT) {
      fprintf(stderr, "uniq: record exceeds %d bytes\n", RECORD_LIMIT); return 2;
    }
    records[count++] = (uniq_record){(const unsigned char *)data + start, length};
    if (offset < size) offset++;
  }
  *record_count = count; return 0;
}

static int uniq_group_selected(size_t count, int repeated, int unique) {
  if (!repeated && !unique) return 1;
  return (repeated && count >= 2) || (unique && count == 1);
}

static int cmd_uniq(int ac, char **av) {
  int show_count = 0, repeated = 0, unique = 0, zero = 0, i = 1;
  for (; i < ac && av[i][0] == '-' && av[i][1]; i++) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (av[i][1] == '-') { fprintf(stderr, "uniq: unsupported option: %s\n", av[i]); return 2; }
    for (const char *flag = av[i] + 1; *flag; flag++) {
      if (*flag == 'c') show_count = 1;
      else if (*flag == 'd') repeated = 1;
      else if (*flag == 'u') unique = 1;
      else if (*flag == 'z') zero = 1;
      else { fprintf(stderr, "uniq: unsupported option: -%c\n", *flag); return 2; }
    }
  }
  if (ac - i > 1) { fprintf(stderr, "uniq: only one input file is supported\n"); return 2; }
  const char *name = i < ac ? av[i] : "-"; FILE *in = open_input(name);
  if (!in) return errorf(name);
  char *data = NULL; size_t size = 0; int loaded = read_bounded_all(in, &data, &size);
  if (in != stdin) fclose(in);
  if (loaded < 0) return errorf(name);
  if (!loaded) { fprintf(stderr, "uniq: input exceeds %d bytes\n", DATA_LIMIT); return 2; }
  uniq_record *records = malloc(SORT_LINES * sizeof *records);
  if (!records) { free(data); return 1; }
  size_t count = 0;
  int rc = uniq_split_records(data, size, zero ? 0 : '\n', records, &count);
  if (rc) { free(records); free(data); return rc; }

  size_t output_size = 0;
  for (size_t first = 0; first < count;) {
    size_t next = first + 1;
    while (next < count && uniq_record_equal(&records[first], &records[next])) next++;
    size_t group_count = next - first;
    if (uniq_group_selected(group_count, repeated, unique)) {
      size_t addition = records[first].length + 1 + (show_count ? 8 : 0);
      if (addition > RECORD_OUTPUT_LIMIT - output_size) {
        fprintf(stderr, "uniq: output exceeds %d bytes\n", RECORD_OUTPUT_LIMIT);
        free(records); free(data); return 2;
      }
      output_size += addition;
    }
    first = next;
  }

  for (size_t first = 0; first < count;) {
    size_t next = first + 1;
    while (next < count && uniq_record_equal(&records[first], &records[next])) next++;
    size_t group_count = next - first;
    if (uniq_group_selected(group_count, repeated, unique)) {
      if (show_count && printf("%7zu ", group_count) < 0) { rc = 1; break; }
      if ((records[first].length && fwrite(
             records[first].data, 1, records[first].length, stdout) != records[first].length) ||
          putchar(zero ? 0 : '\n') == EOF) { rc = 1; break; }
    }
    first = next;
  }
  if (!rc && fflush(stdout) == EOF) rc = 1;
  free(records); free(data); return rc;
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

static int xargs_replace_arg(const char *source, const char *token, const char *value,
                             char *pool, size_t *used, char **output) {
  size_t token_length = strlen(token), value_length = strlen(value);
  *output = pool + *used;
  const char *cursor = source;
  for (;;) {
    const char *match = strstr(cursor, token);
    size_t literal = match ? (size_t)(match - cursor) : strlen(cursor);
    size_t addition = literal + (match ? value_length : 0);
    if (*used + addition + 1 > XARGS_BLOB) return 0;
    memcpy(pool + *used, cursor, literal); *used += literal;
    if (!match) break;
    memcpy(pool + *used, value, value_length); *used += value_length;
    cursor = match + token_length;
  }
  pool[(*used)++] = 0; return 1;
}

static int xargs_run_replaced(const char *cmd, char **fixed, int fixed_count,
                              const char *token, const char *item) {
  static char pool[XARGS_BLOB]; static char *expanded[XARGS_MAX];
  size_t used = 0; char *expanded_cmd = NULL;
  if (!xargs_replace_arg(cmd, token, item, pool, &used, &expanded_cmd)) {
    fprintf(stderr, "xargs: replacement exceeds %d bytes\n", XARGS_BLOB); return 1;
  }
  for (int index = 0; index < fixed_count; index++) {
    if (!xargs_replace_arg(fixed[index], token, item, pool, &used, &expanded[index])) {
      fprintf(stderr, "xargs: replacement exceeds %d bytes\n", XARGS_BLOB); return 1;
    }
  }
  return xargs_run(expanded_cmd, expanded, fixed_count, NULL, 0);
}

static int cmd_xargs(int ac, char **av) {
  const char *cmd = "echo";
  const char *replace = NULL;
  int n_cmd_args = 0;
  int max_args = 0;
  int nul = 0, no_run_empty = 0;
  static char *cmd_args[XARGS_MAX];
  int i = 1;
  while (i < ac && av[i][0] == '-') {
    const char *count = NULL;
    if (!strcmp(av[i], "-n") && i + 1 < ac) { count = av[i + 1]; i += 2; }
    else if (!strncmp(av[i], "-n", 2) && av[i][2]) { count = av[i] + 2; i++; }
    else if (!strncmp(av[i], "--max-args=", 11)) { count = av[i] + 11; i++; }
    if (count) {
      char *end_count = NULL; long parsed = strtol(count, &end_count, 10);
      if (!*count || *end_count || parsed < 1 || parsed > XARGS_MAX) {
        fprintf(stderr, "xargs: -n requires a number from 1 to %d\n", XARGS_MAX); return 2;
      }
      max_args = (int)parsed;
    }
    else if (!strcmp(av[i], "-I") && i + 1 < ac) { replace = av[i + 1]; i += 2; }
    else if (!strncmp(av[i], "-I", 2) && av[i][2]) { replace = av[i] + 2; i++; }
    else if (!strncmp(av[i], "--replace=", 10)) { replace = av[i] + 10; i++; }
    else if (!strcmp(av[i], "--replace") && i + 1 < ac) { replace = av[i + 1]; i += 2; }
    else if (!strcmp(av[i], "-I") || !strcmp(av[i], "--replace")) {
      fprintf(stderr, "xargs: %s requires a replacement token\n", av[i]); return 2;
    }
    else if (!strcmp(av[i], "--null")) { nul = 1; i++; }
    else if (!strcmp(av[i], "--no-run-if-empty")) { no_run_empty = 1; i++; }
    else if (av[i][0] == '-' && av[i][1] &&
             strspn(av[i] + 1, "0r") == strlen(av[i] + 1)) {
      for (const char *flag = av[i] + 1; *flag; flag++) {
        if (*flag == '0') nul = 1;
        else no_run_empty = 1;
      }
      i++;
    }
    else if (!strcmp(av[i], "--")) { i++; break; }
    else { fprintf(stderr, "xargs: unsupported option: %s\n", av[i]); return 2; }
  }
  if (replace && !*replace) { fprintf(stderr, "xargs: replacement token must not be empty\n"); return 2; }
  if (replace && max_args) { fprintf(stderr, "xargs: -I and -n are mutually exclusive\n"); return 2; }
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

  if (replace) {
    char *p = buf, *end = buf + total; int rc = 0;
    while (p < end) {
      char *start = p;
      if (nul) while (p < end && *p) p++;
      else while (p < end && *p != '\n') p++;
      char *finish = p;
      if (!nul && finish > start && finish[-1] == '\r') finish--;
      if (p < end) *p++ = 0;
      *finish = 0;
      if (!*start) continue;
      int status = xargs_run_replaced(cmd, cmd_args, n_cmd_args, replace, start);
      if (status) rc = status;
    }
    return rc;
  }

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

static void printf_escape(const char **format) {
  const char *p = *format;
  if (!*p) { putchar('\\'); return; }
  if (*p == 'n') putchar('\n');
  else if (*p == 't') putchar('\t');
  else if (*p == 'r') putchar('\r');
  else if (*p == 'b') putchar('\b');
  else if (*p == 'f') putchar('\f');
  else if (*p == 'v') putchar('\v');
  else if (*p == 'a') putchar('\a');
  else putchar(*p);
  *format = p + 1;
}

static int cmd_printf(int ac, char **av) {
  int first = 1;
  if (first < ac && !strcmp(av[first], "--")) first++;
  if (first >= ac) return 0;
  const char *format = av[first++]; int argument = first;
  for (;;) {
    int before = argument;
    for (const char *p = format; *p;) {
      if (*p == '\\') { p++; printf_escape(&p); continue; }
      if (*p != '%' || !p[1]) { putchar(*p++); continue; }
      char specifier = *++p; p++;
      if (specifier == '%') putchar('%');
      else if (specifier == 's') fputs(argument < ac ? av[argument++] : "", stdout);
      else if (specifier == 'd' || specifier == 'i')
        printf("%ld", argument < ac ? strtol(av[argument++], NULL, 0) : 0L);
      else if (specifier == 'u')
        printf("%lu", argument < ac ? strtoul(av[argument++], NULL, 0) : 0UL);
      else if (specifier == 'x' || specifier == 'X') {
        unsigned long value = argument < ac ? strtoul(av[argument++], NULL, 0) : 0UL;
        printf(specifier == 'x' ? "%lx" : "%lX", value);
      } else if (specifier == 'o')
        printf("%lo", argument < ac ? strtoul(av[argument++], NULL, 0) : 0UL);
      else if (specifier == 'c') putchar(argument < ac ? av[argument++][0] : 0);
      else { putchar('%'); putchar(specifier); }
    }
    if (argument == before || argument >= ac) break;
  }
  return ferror(stdout) ? 1 : 0;
}

typedef struct {
  uint32_t state[8];
  uint64_t bits;
  unsigned char block[64];
  size_t used;
} sha256_ctx;

static uint32_t sha256_rotr(uint32_t value, unsigned int count) {
  return (value >> count) | (value << (32 - count));
}

static void sha256_transform(sha256_ctx *ctx, const unsigned char block[64]) {
  static const uint32_t constants[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  };
  uint32_t words[64];
  for (int i = 0; i < 16; i++) {
    words[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
               ((uint32_t)block[i * 4 + 2] << 8) | (uint32_t)block[i * 4 + 3];
  }
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = sha256_rotr(words[i - 15], 7) ^ sha256_rotr(words[i - 15], 18) ^ (words[i - 15] >> 3);
    uint32_t s1 = sha256_rotr(words[i - 2], 17) ^ sha256_rotr(words[i - 2], 19) ^ (words[i - 2] >> 10);
    words[i] = words[i - 16] + s0 + words[i - 7] + s1;
  }
  uint32_t a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
  uint32_t e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];
  for (int i = 0; i < 64; i++) {
    uint32_t upper = sha256_rotr(e, 6) ^ sha256_rotr(e, 11) ^ sha256_rotr(e, 25);
    uint32_t choose = (e & f) ^ (~e & g);
    uint32_t temp1 = h + upper + choose + constants[i] + words[i];
    uint32_t lower = sha256_rotr(a, 2) ^ sha256_rotr(a, 13) ^ sha256_rotr(a, 22);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temp2 = lower + majority;
    h = g; g = f; f = e; e = d + temp1; d = c; c = b; b = a; a = temp1 + temp2;
  }
  ctx->state[0] += a; ctx->state[1] += b; ctx->state[2] += c; ctx->state[3] += d;
  ctx->state[4] += e; ctx->state[5] += f; ctx->state[6] += g; ctx->state[7] += h;
}

static void sha256_init(sha256_ctx *ctx) {
  static const uint32_t initial[8] = {
    0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19,
  };
  memcpy(ctx->state, initial, sizeof initial); ctx->bits = 0; ctx->used = 0;
}

static void sha256_update(sha256_ctx *ctx, const unsigned char *data, size_t length) {
  ctx->bits += (uint64_t)length * 8;
  while (length) {
    size_t space = sizeof ctx->block - ctx->used;
    size_t take = length < space ? length : space;
    memcpy(ctx->block + ctx->used, data, take); ctx->used += take; data += take; length -= take;
    if (ctx->used == sizeof ctx->block) { sha256_transform(ctx, ctx->block); ctx->used = 0; }
  }
}

static void sha256_final(sha256_ctx *ctx, unsigned char digest[32]) {
  uint64_t bits = ctx->bits;
  ctx->block[ctx->used++] = 0x80;
  if (ctx->used > 56) {
    memset(ctx->block + ctx->used, 0, sizeof ctx->block - ctx->used);
    sha256_transform(ctx, ctx->block); ctx->used = 0;
  }
  memset(ctx->block + ctx->used, 0, 56 - ctx->used);
  for (int i = 0; i < 8; i++) ctx->block[63 - i] = (unsigned char)(bits >> (i * 8));
  sha256_transform(ctx, ctx->block);
  for (int i = 0; i < 8; i++) {
    digest[i * 4] = (unsigned char)(ctx->state[i] >> 24);
    digest[i * 4 + 1] = (unsigned char)(ctx->state[i] >> 16);
    digest[i * 4 + 2] = (unsigned char)(ctx->state[i] >> 8);
    digest[i * 4 + 3] = (unsigned char)ctx->state[i];
  }
}

static int sha256_stream(FILE *input, unsigned char digest[32]) {
  sha256_ctx ctx; sha256_init(&ctx); unsigned char buffer[8192]; size_t length;
  while ((length = fread(buffer, 1, sizeof buffer, input)) > 0) sha256_update(&ctx, buffer, length);
  if (ferror(input)) return 0; sha256_final(&ctx, digest); return 1;
}

typedef struct {
  unsigned char expected[32];
  char *path;
} sha256_manifest_record;

static int sha256_path_needs_escape(const char *path) {
  return strchr(path, '\\') != NULL || strchr(path, '\n') != NULL;
}

static size_t sha256_encoded_path_length(const char *path) {
  size_t length = 0;
  for (const unsigned char *cursor = (const unsigned char *)path; *cursor; cursor++) {
    size_t add = *cursor == '\\' || *cursor == '\n' ? 2 : 1;
    if (length > SIZE_MAX - add) return SIZE_MAX;
    length += add;
  }
  return length;
}

static int sha256_emit_encoded_path(FILE *output, const char *path) {
  for (const unsigned char *cursor = (const unsigned char *)path; *cursor; cursor++) {
    if (*cursor == '\\') {
      if (fputs("\\\\", output) == EOF) return 0;
    } else if (*cursor == '\n') {
      if (fputs("\\n", output) == EOF) return 0;
    } else if (fputc(*cursor, output) == EOF) return 0;
  }
  return 1;
}

static int sha256_emit_rendered_path(FILE *output, const char *path) {
  if (sha256_path_needs_escape(path) && fputc('\\', output) == EOF) return 0;
  return sha256_emit_encoded_path(output, path);
}

static int sha256_path_error(const char *path) {
  int saved = errno;
  if (fputs("sha256sum: ", stderr) == EOF ||
      !sha256_emit_rendered_path(stderr, path) ||
      fprintf(stderr, ": %s\n", strerror(saved)) < 0) return 1;
  return 1;
}

static int sha256_hex_value(unsigned char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

static int sha256_manifest_error(const char *manifest, const char *message) {
  if (fputs("sha256sum: ", stderr) != EOF &&
      sha256_emit_rendered_path(stderr, manifest))
    fprintf(stderr, ": %s\n", message);
  return 2;
}

static int sha256_check_manifest(const char *manifest) {
  FILE *input = open_input(manifest);
  if (!input) { errorf(manifest); return 2; }
  unsigned char *data = malloc(SHA256_MANIFEST_LIMIT + 2);
  sha256_manifest_record *records = calloc(SHA256_MANIFEST_RECORDS, sizeof *records);
  if (!data || !records) {
    if (input != stdin) fclose(input);
    free(data); free(records);
    fprintf(stderr, "sha256sum: checksum manifest allocation failed\n"); return 2;
  }

  size_t used = 0;
  while (used <= SHA256_MANIFEST_LIMIT) {
    size_t room = SHA256_MANIFEST_LIMIT + 1 - used;
    size_t got = fread(data + used, 1, room, input); used += got;
    if (used > SHA256_MANIFEST_LIMIT) {
      if (input != stdin) fclose(input);
      free(data); free(records);
      return sha256_manifest_error(manifest, "checksum manifest exceeds 1048576 bytes");
    }
    if (got < room) {
      if (ferror(input)) {
        if (input != stdin) fclose(input);
        free(data); free(records);
        return sha256_manifest_error(manifest, "checksum manifest read error");
      }
      break;
    }
  }
  if (input != stdin && fclose(input)) {
    free(data); free(records);
    return sha256_manifest_error(manifest, "checksum manifest read error");
  }
  if (!used) {
    free(data); free(records);
    return sha256_manifest_error(manifest, "empty checksum manifest");
  }
  data[used] = 0;

  size_t position = 0, count = 0, line_number = 0;
  while (position < used) {
    size_t start = position;
    while (position < used && data[position] != '\n') position++;
    size_t length = position - start; line_number++;
    if (count == SHA256_MANIFEST_RECORDS) {
      free(data); free(records);
      return sha256_manifest_error(manifest, "checksum manifest exceeds 4096 records");
    }
    if (length > SHA256_MANIFEST_LINE) {
      char message[96]; snprintf(message, sizeof message, "checksum line %zu exceeds 4096 bytes", line_number);
      free(data); free(records); return sha256_manifest_error(manifest, message);
    }
    int escaped = length > 0 && data[start] == '\\';
    size_t digest_start = start + (escaped ? 1 : 0);
    size_t path_start = digest_start + 66;
    int malformed = length < (escaped ? 68 : 67) ||
      data[digest_start + 64] != ' ' ||
      (data[digest_start + 65] != ' ' && data[digest_start + 65] != '*');
    for (size_t offset = 0; !malformed && offset < 64; offset++)
      if (sha256_hex_value(data[digest_start + offset]) < 0) malformed = 1;
    for (size_t offset = path_start - start; !malformed && offset < length; offset++)
      if (data[start + offset] == 0) malformed = 1;
    size_t decoded_length = 0;
    if (!malformed && escaped) {
      size_t read_offset = path_start, write_offset = path_start;
      size_t end = start + length;
      while (read_offset < end) {
        unsigned char value = data[read_offset++];
        if (value == '\\') {
          if (read_offset == end) { malformed = 1; break; }
          unsigned char escaped_value = data[read_offset++];
          if (escaped_value == 'n') value = '\n';
          else if (escaped_value == '\\') value = '\\';
          else { malformed = 1; break; }
        }
        data[write_offset++] = value;
      }
      decoded_length = write_offset - path_start;
      data[write_offset] = 0;
    } else if (!malformed) {
      decoded_length = length - (path_start - start);
      data[start + length] = 0;
    }
    if (!malformed && (!decoded_length || decoded_length > CP_PATH_LIMIT ||
                       !strcmp((char *)data + path_start, "-"))) malformed = 1;
    if (malformed) {
      char message[96]; snprintf(message, sizeof message, "malformed checksum line %zu", line_number);
      free(data); free(records); return sha256_manifest_error(manifest, message);
    }
    for (int byte = 0; byte < 32; byte++) {
      int upper = sha256_hex_value(data[digest_start + byte * 2]);
      int lower = sha256_hex_value(data[digest_start + byte * 2 + 1]);
      records[count].expected[byte] = (unsigned char)((upper << 4) | lower);
    }
    records[count++].path = (char *)data + path_start;
    if (position < used) position++;
  }

  int mismatches = 0, unreadable = 0;
  for (size_t index = 0; index < count; index++) {
    const char *path = records[index].path;
    unsigned char digest[32]; int readable = 1;
    struct stat status;
    if (stat(path, &status) || !S_ISREG(status.st_mode)) readable = 0;
    FILE *target = readable ? fopen(path, "rb") : NULL;
    if (!target) readable = 0;
    if (readable) {
      readable = sha256_stream(target, digest);
      if (fclose(target)) readable = 0;
    }
    if (!readable) {
      unreadable++;
      if (!sha256_emit_rendered_path(stdout, path) ||
          fputs(": FAILED open or read\n", stdout) == EOF) goto output_error;
    } else if (memcmp(digest, records[index].expected, sizeof digest)) {
      mismatches++;
      if (!sha256_emit_rendered_path(stdout, path) ||
          fputs(": FAILED\n", stdout) == EOF) goto output_error;
    } else if (!sha256_emit_rendered_path(stdout, path) ||
               fputs(": OK\n", stdout) == EOF) goto output_error;
  }
  if (mismatches && fprintf(stderr,
      "sha256sum: WARNING: %d computed checksum(s) did NOT match\n", mismatches) < 0) goto output_error;
  if (unreadable && fprintf(stderr,
      "sha256sum: WARNING: %d listed file(s) could not be read\n", unreadable) < 0) goto output_error;
  if (ferror(stdout) || ferror(stderr)) goto output_error;
  free(data); free(records); return mismatches || unreadable ? 1 : 0;

output_error:
  free(data); free(records);
  fprintf(stderr, "sha256sum: output error\n"); return 2;
}

static int cmd_sha256sum(int ac, char **av) {
  for (int option = 1; option < ac; option++) {
    if (!strcmp(av[option], "--")) break;
    if (option > 1 && (!strcmp(av[option], "-c") || !strcmp(av[option], "--check"))) {
      fprintf(stderr, "sha256sum: check mode must precede its manifest\n"); return 2;
    }
  }
  if (ac > 1 && (!strcmp(av[1], "-c") || !strcmp(av[1], "--check"))) {
    int i = 2, delimited = 0;
    if (i < ac && !strcmp(av[i], "--")) { delimited = 1; i++; }
    if (ac - i > 1 || (delimited && i == ac)) {
      fprintf(stderr, "sha256sum: check mode accepts exactly one manifest\n"); return 2;
    }
    const char *manifest = i < ac ? av[i] : "-";
    if (!delimited && manifest[0] == '-' && strcmp(manifest, "-")) {
      fprintf(stderr, "sha256sum: unsupported option: %s\n", manifest); return 2;
    }
    return sha256_check_manifest(manifest);
  }
  int i = 1;
  if (i < ac && !strcmp(av[i], "--")) i++;
  else if (i < ac && av[i][0] == '-' && strcmp(av[i], "-")) {
    fprintf(stderr, "sha256sum: unsupported option: %s\n", av[i]); return 2;
  }
  int rc = 0, end = ac; char *standard_input[] = {av[0], "-"};
  if (i == ac) { av = standard_input; i = 1; end = 2; }
  for (; i < end; i++) {
    size_t encoded_path_length = sha256_encoded_path_length(av[i]);
    size_t record_length = 64 + 2 + encoded_path_length +
      (sha256_path_needs_escape(av[i]) ? 1 : 0);
    if (encoded_path_length == SIZE_MAX || record_length > SHA256_MANIFEST_LINE) {
      fputs("sha256sum: ", stderr);
      sha256_emit_rendered_path(stderr, av[i]);
      fprintf(stderr, ": encoded checksum record exceeds %d bytes\n", SHA256_MANIFEST_LINE);
      rc = 1; continue;
    }
    FILE *input = open_input(av[i]);
    if (!input) { sha256_path_error(av[i]); rc = 1; continue; }
    unsigned char digest[32]; int ok = sha256_stream(input, digest);
    if (input != stdin) fclose(input);
    if (!ok) { if (!errno) errno = EIO; sha256_path_error(av[i]); rc = 1; continue; }
    if (sha256_path_needs_escape(av[i])) putchar('\\');
    for (int byte = 0; byte < 32; byte++) printf("%02x", digest[byte]);
    fputs("  ", stdout);
    sha256_emit_encoded_path(stdout, av[i]);
    putchar('\n');
  }
  return ferror(stdout) ? 1 : rc;
}

static int date_format_utc(const char *format, time_t now, const struct tm *utc) {
  char expanded[4096]; size_t used = 0;
  for (size_t i = 0; format[i]; i++) {
    if (format[i] == '%' && format[i + 1] == '%') {
      if (used + 2 >= sizeof expanded) { fprintf(stderr, "date: format is too long\n"); return 2; }
      expanded[used++] = '%'; expanded[used++] = '%'; i++;
    } else if (format[i] == '%' && format[i + 1] == 's') {
      char epoch[32]; int length = snprintf(epoch, sizeof epoch, "%lld", (long long)now);
      if (length < 0 || used + (size_t)length >= sizeof expanded) {
        fprintf(stderr, "date: formatted output is too long\n"); return 2;
      }
      memcpy(expanded + used, epoch, (size_t)length); used += (size_t)length; i++;
    } else {
      if (used + 1 >= sizeof expanded) { fprintf(stderr, "date: format is too long\n"); return 2; }
      expanded[used++] = format[i];
    }
  }
  expanded[used] = 0;
  if (!used) { putchar('\n'); return 0; }
  char output[4096]; size_t length = strftime(output, sizeof output, expanded, utc);
  if (!length) { fprintf(stderr, "date: formatted output is too long\n"); return 2; }
  puts(output); return 0;
}

static int cmd_date(int ac, char **av) {
  int i = 1;
  while (i < ac && av[i][0] == '-' && av[i][1]) {
    if (!strcmp(av[i], "--")) { i++; break; }
    if (!strcmp(av[i], "-u") || !strcmp(av[i], "--utc") || !strcmp(av[i], "--universal")) {
      i++; continue;
    }
    fprintf(stderr, "date: unsupported option: %s\n", av[i]); return 2;
  }
  if (ac - i > 1 || (i < ac && av[i][0] != '+')) {
    fprintf(stderr, "date: expected at most one +FORMAT; setting the clock is unavailable\n"); return 2;
  }
  const char *format = i < ac ? av[i] + 1 : "%Y-%m-%dT%H:%M:%SZ";
  time_t now = time(NULL); if (now == (time_t)-1) return errorf("clock");
  struct tm utc;
  if (!gmtime_r(&now, &utc)) return errorf("clock");
  return date_format_utc(format, now, &utc);
}

static int cmd_sleep(int ac, char **av) {
  int i = 1; if (i < ac && !strcmp(av[i], "--")) i++;
  if (ac - i != 1) { fprintf(stderr, "sleep: expected exactly one duration\n"); return 2; }
  const char *duration = av[i]; char *end = NULL; errno = 0;
  double seconds = strtod(duration, &end);
  if (end != duration && end[0] && !end[1] && strchr("smh", *end)) {
    char suffix = *end++;
    if (suffix == 'm') seconds *= 60.0;
    else if (suffix == 'h') seconds *= 3600.0;
  }
  if (errno || end == duration || *end ||
      seconds != seconds || seconds < 0.0 || seconds > 60.0) {
    fprintf(stderr, "sleep: duration must be a finite value from 0 to 60 seconds (suffix s, m, or h)\n"); return 2;
  }
  time_t whole = (time_t)seconds;
  long nanoseconds = (long)((seconds - (double)whole) * 1000000000.0 + 0.5);
  if (nanoseconds >= 1000000000L) { whole++; nanoseconds -= 1000000000L; }
  struct timespec request = {.tv_sec = whole, .tv_nsec = nanoseconds};
  int result;
  do { result = nanosleep(&request, &request); } while (result && errno == EINTR);
  return result ? errorf(duration) : 0;
}

static void print_help(const char *name) {
  if (!strcmp(name, "rm")) puts("usage: rm [-f] [-r|-R] [--] PATH...  # compact -rf/-fr; complete recursive preflight; missing ignored only with -f; nonzero preflight leaves selected paths unchanged; max 100 operands, 4096 bytes per path, 65536 path bytes, 128 components, 40 symlinks, depth 128, 100000 scanned/planned entries");
  else if (!strcmp(name, "cp")) puts("usage: cp [-r|-R] [-f|-n|--force|--no-clobber] [--] SOURCE... DEST  # no-clobber skips existing destinations; -a/-p unavailable; max 100 sources, 4096 bytes per path, 65536 path bytes, 128 components, 40 symlinks");
  else if (!strcmp(name, "mv")) puts("usage: mv [-f|-n|--force|--no-clobber] [--] SOURCE... DEST  # ordered flags; multi-source preflight; max 100 sources, 4096 bytes per path, 65536 path bytes, 128 components, 40 symlinks");
  else if (!strcmp(name, "mkdir")) puts("usage: mkdir [-p] [--] DIRECTORY...  # options precede operands; invocation preflight; max 100 operands, 4096 bytes per path, 65536 path bytes, 128 components, 40 symlinks, 1024 planned creations");
  else if (!strcmp(name, "rmdir")) puts("usage: rmdir [--] DIRECTORY...  # complete ordered multi-operand preflight; nonzero preflight leaves selected directories unchanged; max 100 operands, 4096 bytes per path, 65536 path bytes, 128 components, 40 symlinks");
  else if (!strcmp(name, "touch")) puts("usage: touch [-c] [--] FILE...  # options precede operands; invocation preflight; max 100 operands, 4096 bytes/path, 65536 path bytes, 128 components, 40 symlinks");
  else if (!strcmp(name, "ln")) puts("usage: ln -s [-f] [--] TARGET LINK  # initial options only; hard links unavailable; target/link <=4096 bytes; link <=128 components; parent traversal <=40 symlinks");
  else if (!strcmp(name, "head")) puts("usage: head [-n LINES|-nLINES|-c BYTES|-cBYTES] [FILE...] | head (-z|--zero-terminated) [-n N|-nN] [--] [FILE...]  # NUL records: 100 files, N 0..100000, 1 MiB each, 16 MiB/file, 64 MiB total");
  else if (!strcmp(name, "tail")) puts("usage: tail [-n LINES|-nLINES|-c BYTES|-cBYTES] [--] [FILE]  # +N starts at line N; byte counts 0..16777216");
  else if (!strcmp(name, "wc")) puts("usage: wc [-lwc|--lines|--words|--bytes] [--] [FILE...]");
  else if (!strcmp(name, "sort")) puts("usage: sort [-rznu] [-k KEY|-kKEY|--key KEY|--key=KEY] [-t BYTE|-tBYTE|--field-separator=BYTE] [--] [FILE]  # KEY=N[n] or N,N[n]; byte fields; -z uses NUL records; bounded to 16 MiB/100000 records/1 MiB each");
  else if (!strcmp(name, "cut")) puts("usage: cut [-d DELIMITER] -f FIELD [FILE] | cut -c LIST [FILE] | cut (-z|--zero-terminated) [-d BYTE] -f FIELD [--] [FILE]  # NUL records: 16 MiB input/output, 100000 records, 1 MiB each");
  else if (!strcmp(name, "paste")) paste_usage(stdout);
  else if (!strcmp(name, "tr")) puts("usage: tr [-d] [-s] SET1 [SET2]");
  else if (!strcmp(name, "tee")) puts("usage: tee [-a] [FILE...]");
  else if (!strcmp(name, "basename")) puts("usage: basename [--] PATH [SUFFIX]");
  else if (!strcmp(name, "dirname")) puts("usage: dirname [--] PATH");
  else if (!strcmp(name, "seq")) puts("usage: seq [FIRST [STEP]] LAST");
  else if (!strcmp(name, "cmp")) cmp_usage(stdout);
  else if (!strcmp(name, "comm")) comm_usage(stdout);
  else if (!strcmp(name, "join")) join_usage(stdout);
  else if (!strcmp(name, "xxd")) xxd_usage(stdout);
  else if (!strcmp(name, "base64")) base64_usage(stdout);
  else if (!strcmp(name, "strings")) strings_usage(stdout);
  else if (!strcmp(name, "truncate")) truncate_usage(stdout);
  else if (!strcmp(name, "diff")) puts("usage: diff [-u|-q] [-U CONTEXT] [--] FILE1 FILE2  # unified by default; files <=16 MiB/100000 lines");
  else if (!strcmp(name, "install")) puts("usage: install [--] SOURCE... DEST | install -d [--] DIRECTORY...  # regular files; invocation preflight; final destination symlinks rejected; metadata flags unavailable; max 100 sources/directories, 4096 bytes per path, 65536 path bytes, 128 components, 40 symlinks");
  else if (!strcmp(name, "readlink")) puts("usage: readlink [-f|--canonicalize] [--] PATH  # -f requires an existing path");
  else if (!strcmp(name, "realpath")) puts("usage: realpath [-e|--canonicalize-existing|-m|--canonicalize-missing] [-P|--physical] [--] PATH...  # -e requires existing paths; -m stages 1..100 physical results with missing suffixes, <=4096 input/result bytes, 256 processed components, 40 symlinks");
  else if (!strcmp(name, "du")) puts("usage: du -a -d DEPTH [--] PATH...  # logical regular-file bytes; symlinks are zero/not followed; deterministic postorder; 64 paths, depth 0..128, 128 levels, 100000 entries/records, 16 MiB staged output, 4096 bytes/path, 65536 operand bytes");
  else if (!strcmp(name, "find")) puts("usage: find [PATH...] [-mindepth N] [-maxdepth N] [-name GLOB] [-path GLOB] [-type f|d|l] [-print|-print0|-delete]  # one optional final action; default print; -delete is silent/postorder and may partially apply after runtime failure; 100 paths, 128 levels, 100000 entries");
  else if (!strcmp(name, "mktemp")) puts("usage: mktemp [-d] [-t] [-dt|-td] [--] [TEMPLATE.XXXXXX]  # -t uses TMPDIR or /tmp; final component <=1024 bytes, path <=4096 bytes/128 components/40 symlinks; 128 collision attempts; permission modes are host-managed");
  else if (!strcmp(name, "stat")) puts("usage: stat [-L] [-c FORMAT] [--] FILE...  # formats: %%, %s %n %F %i %d %h %Y; permission modes unavailable");
  else if (!strcmp(name, "chmod")) puts("usage: chmod OCTAL_MODE FILE...  # validates, then fails: WASI modes unavailable");
  else if (!strcmp(name, "uniq")) puts("usage: uniq [-cduz] [--] [FILE]  # -d repeated groups; -u unique groups; -z NUL records; 16 MiB/100000 records/1 MiB each");
  else if (!strcmp(name, "xargs")) puts("usage: xargs [-0r] [-n COUNT | -I TOKEN] [COMMAND [ARGS...]]  # -I runs once per nonempty line/record; 64 KiB input");
  else if (!strcmp(name, "printf")) puts("usage: printf FORMAT [ARG...]  # formats: %% %s %d %i %u %x %X %o %c");
  else if (!strcmp(name, "true")) puts("usage: true");
  else if (!strcmp(name, "false")) puts("usage: false");
  else if (!strcmp(name, "sha256sum")) puts("usage: sha256sum [--] [FILE...] | sha256sum -c|--check [--] [MANIFEST]  # canonical LF/backslash escaping; records <=4096 encoded bytes; manifests <=1 MiB/4096 records; status 0 match, 1 mismatch/read failure, 2 invalid manifest/invocation");
  else if (!strcmp(name, "date")) puts("usage: date [-u|--utc] [+FORMAT]  # UTC only; default RFC 3339 seconds; %s is Unix time; clock setting unavailable");
  else if (!strcmp(name, "sleep")) puts("usage: sleep [--] DURATION  # finite 0..60 seconds; optional s, m, or h suffix");
  else puts("bounded Slop utility");
}

int main(int argc, char **argv) {
  prog = base(argv[0]);
  if (argc == 2 && !strcmp(argv[1], "--help")) { print_help(prog); return 0; }
  if (!strcmp(prog, "xxd")) return cmd_xxd(argc, argv);
  if (!strcmp(prog, "base64")) return cmd_base64(argc, argv);
  if (!strcmp(prog, "strings")) return cmd_strings(argc, argv);
  if (!strcmp(prog, "truncate")) return cmd_truncate(argc, argv);
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
  if (!strcmp(prog, "paste")) return cmd_paste(argc, argv);
  if (!strcmp(prog, "tr")) return cmd_tr(argc, argv);
  if (!strcmp(prog, "tee")) return cmd_tee(argc, argv);
  if (!strcmp(prog, "basename")) return cmd_basename(argc, argv);
  if (!strcmp(prog, "dirname")) return cmd_dirname(argc, argv);
  if (!strcmp(prog, "seq")) return cmd_seq(argc, argv);
  if (!strcmp(prog, "cmp")) return cmd_cmp(argc, argv);
  if (!strcmp(prog, "comm")) return cmd_comm(argc, argv);
  if (!strcmp(prog, "join")) return cmd_join(argc, argv);
  if (!strcmp(prog, "diff")) return cmd_diff(argc, argv);
  if (!strcmp(prog, "install")) return cmd_install(argc, argv);
  if (!strcmp(prog, "readlink")) return cmd_readlink(argc, argv);
  if (!strcmp(prog, "realpath")) return cmd_realpath(argc, argv);
  if (!strcmp(prog, "du")) return cmd_du(argc, argv);
  if (!strcmp(prog, "find")) return cmd_find(argc, argv);
  if (!strcmp(prog, "mktemp")) return cmd_mktemp(argc, argv);
  if (!strcmp(prog, "stat")) return cmd_stat(argc, argv);
  if (!strcmp(prog, "chmod")) return cmd_chmod(argc, argv);
  if (!strcmp(prog, "uniq")) return cmd_uniq(argc, argv);
  if (!strcmp(prog, "xargs")) return cmd_xargs(argc, argv);
  if (!strcmp(prog, "printf")) return cmd_printf(argc, argv);
  if (!strcmp(prog, "true")) return 0;
  if (!strcmp(prog, "false")) return 1;
  if (!strcmp(prog, "sha256sum")) return cmd_sha256sum(argc, argv);
  if (!strcmp(prog, "date")) return cmd_date(argc, argv);
  if (!strcmp(prog, "sleep")) return cmd_sleep(argc, argv);
  fprintf(stderr, "coreutils: unknown applet '%s'\n", prog); return 127;
}
