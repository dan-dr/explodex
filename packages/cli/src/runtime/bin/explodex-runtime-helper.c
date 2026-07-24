#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/message.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <time.h>
#include <unistd.h>

#define PROC_PIDUNIQIDENTIFIERINFO 17

static int pause_watchdog(void);

struct proc_uniqidentifierinfo_local {
  uint8_t p_uuid[16];
  uint64_t p_uniqueid;
  uint64_t p_puniqueid;
  int32_t p_idversion;
  uint32_t p_reserve2;
  uint64_t p_reserve3;
  uint64_t p_reserve4;
};

static int read_unique_info(pid_t pid, struct proc_uniqidentifierinfo_local *info) {
  errno = 0;
  int result = proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, info, sizeof(*info));
  if (result == (int)sizeof(*info)) return 0;
  return errno == ESRCH ? 3 : 70;
}

static int identify(pid_t pid) {
  struct proc_uniqidentifierinfo_local info = {0};
  int status = read_unique_info(pid, &info);
  if (status != 0) return status;
  printf("%llu.%u\n", (unsigned long long)info.p_uniqueid, (unsigned int)info.p_idversion);
  return 0;
}

static int signal_exact(pid_t pid, const char *expected, int signal_number) {
  struct proc_uniqidentifierinfo_local info = {0};
  int status = read_unique_info(pid, &info);
  if (status != 0) return status;
  char actual[64];
  int length = snprintf(
    actual,
    sizeof(actual),
    "%llu.%u",
    (unsigned long long)info.p_uniqueid,
    (unsigned int)info.p_idversion
  );
  if (length <= 0 || (size_t)length >= sizeof(actual)) return 70;
  if (strcmp(actual, expected) != 0) return 3;
  audit_token_t token = {{0}};
  token.val[5] = (unsigned int)pid;
  token.val[7] = (unsigned int)info.p_idversion;
  int result = proc_signal_with_audittoken(&token, signal_number);
  if (result == 0) return 0;
  return result == ESRCH ? 3 : 70;
}

static int read_exact_fd(int fd, const char *expected) {
  size_t expected_length = strlen(expected);
  char *contents = malloc(expected_length + 1);
  if (contents == NULL) return 70;
  size_t total = 0;
  while (total < expected_length + 1) {
    ssize_t count = read(fd, contents + total, expected_length + 1 - total);
    if (count < 0) {
      if (errno == EINTR) continue;
      free(contents);
      return 70;
    }
    if (count == 0) break;
    total += (size_t)count;
  }
  int matches = total == expected_length && memcmp(contents, expected, expected_length) == 0;
  free(contents);
  return matches ? 0 : 3;
}

static int exact_lock_directory(
  const char *path,
  const char *record_name,
  const char *expected,
  struct stat *identity
) {
  int directory_fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0) {
    return errno == ENOENT || errno == ENOTDIR || errno == ELOOP ? 3 : 70;
  }
  struct stat directory_stat;
  if (fstat(directory_fd, &directory_stat) != 0 || !S_ISDIR(directory_stat.st_mode)) {
    close(directory_fd);
    return 70;
  }

  int record_fd = openat(directory_fd, record_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (record_fd < 0) {
    int status = errno == ENOENT || errno == ELOOP ? 3 : 70;
    close(directory_fd);
    return status;
  }
  struct stat record_stat;
  if (fstat(record_fd, &record_stat) != 0 || !S_ISREG(record_stat.st_mode)) {
    close(record_fd);
    close(directory_fd);
    return 3;
  }
  int status = read_exact_fd(record_fd, expected);
  close(record_fd);
  if (status != 0) {
    close(directory_fd);
    return status;
  }

  int listing_fd = dup(directory_fd);
  if (listing_fd < 0) {
    close(directory_fd);
    return 70;
  }
  DIR *listing = fdopendir(listing_fd);
  if (listing == NULL) {
    close(listing_fd);
    close(directory_fd);
    return 70;
  }
  int record_count = 0;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(listing)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (strcmp(entry->d_name, record_name) == 0) {
      record_count += 1;
      continue;
    }
    status = 3;
    break;
  }
  if (entry == NULL && errno != 0) status = 70;
  closedir(listing);
  close(directory_fd);
  if (status != 0) return status;
  if (record_count != 1) return 3;
  if (identity != NULL) *identity = directory_stat;
  return 0;
}

static int same_directory_identity(const char *path, const struct stat *expected) {
  struct stat current;
  if (lstat(path, &current) != 0) return 0;
  return S_ISDIR(current.st_mode) && current.st_dev == expected->st_dev && current.st_ino == expected->st_ino;
}

static int restore_owner_record(
  const char *directory,
  const char *record_name,
  const char *expected
) {
  int directory_fd = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0) return 70;
  int record_fd = openat(
    directory_fd,
    record_name,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    0600
  );
  if (record_fd < 0) {
    close(directory_fd);
    return 70;
  }
  size_t expected_length = strlen(expected);
  size_t total = 0;
  while (total < expected_length) {
    ssize_t count = write(record_fd, expected + total, expected_length - total);
    if (count < 0) {
      if (errno == EINTR) continue;
      close(record_fd);
      close(directory_fd);
      return 70;
    }
    total += (size_t)count;
  }
  int status = close(record_fd) == 0 ? 0 : 70;
  close(directory_fd);
  return status;
}

static int compare_remove_directory(const char *path, const char *record_name, const char *expected) {
  const char *slash = strrchr(path, '/');
  if (slash == NULL) return 64;
  size_t parent_length = (size_t)(slash - path);
  char guard_path[4096];
  int length = snprintf(
    guard_path,
    sizeof(guard_path),
    "%.*s/.explodex-lock-guard-%d-XXXXXX",
    (int)parent_length,
    path,
    getpid()
  );
  if (length <= 0 || (size_t)length >= sizeof(guard_path)) return 70;
  if (mkdtemp(guard_path) == NULL) return 70;
  if (chmod(guard_path, 0700) != 0) {
    rmdir(guard_path);
    return 70;
  }
  struct stat guard_identity;
  if (lstat(guard_path, &guard_identity) != 0 || !S_ISDIR(guard_identity.st_mode)) {
    rmdir(guard_path);
    return 70;
  }

  int status = exact_lock_directory(path, record_name, expected, NULL);
  if (status != 0) {
    rmdir(guard_path);
    return status;
  }

  if (pause_watchdog() != 0) {
    rmdir(guard_path);
    return 70;
  }
  signal(SIGTERM, SIG_IGN);
  signal(SIGINT, SIG_IGN);

  errno = 0;
  if (renamex_np(path, guard_path, RENAME_SWAP) != 0) {
    status = errno == ENOENT ? 3 : 70;
    rmdir(guard_path);
    return status;
  }

  status = exact_lock_directory(guard_path, record_name, expected, NULL);
  if (!same_directory_identity(path, &guard_identity) || status != 0) {
    if (!same_directory_identity(path, &guard_identity)) return 70;
    if (renamex_np(path, guard_path, RENAME_SWAP) != 0) return 70;
    if (rmdir(guard_path) != 0) return 70;
    return status == 0 ? 3 : status;
  }

  char released_guard_path[4096];
  length = snprintf(
    released_guard_path,
    sizeof(released_guard_path),
    "%.*s/.explodex-lock-released-%d-%llu",
    (int)parent_length,
    path,
    getpid(),
    (unsigned long long)arc4random()
  );
  if (length <= 0 || (size_t)length >= sizeof(released_guard_path)) return 70;

  if (!same_directory_identity(path, &guard_identity)) return 70;
  errno = 0;
  if (renamex_np(path, released_guard_path, RENAME_EXCL) != 0) {
    if (same_directory_identity(path, &guard_identity)) {
      if (renamex_np(path, guard_path, RENAME_SWAP) == 0) rmdir(guard_path);
    }
    return 70;
  }

  int cleanup_status = 0;
  if (rmdir(released_guard_path) != 0) cleanup_status = 70;

  int directory_fd = open(guard_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0) return 70;
  if (unlinkat(directory_fd, record_name, 0) != 0) {
    close(directory_fd);
    return 70;
  }
  close(directory_fd);
  if (rmdir(guard_path) != 0) {
    restore_owner_record(guard_path, record_name, expected);
    return 70;
  }
  return cleanup_status;
}

static int parse_pid(const char *text, pid_t *pid) {
  char *end = NULL;
  long value = strtol(text, &end, 10);
  if (end == text || *end != '\0' || value <= 0 || value > INT32_MAX) return 64;
  *pid = (pid_t)value;
  return 0;
}

static void *watchdog_main(void *context) {
  long milliseconds = *(long *)context;
  free(context);
  struct timespec delay = {
    .tv_sec = milliseconds / 1000,
    .tv_nsec = (milliseconds % 1000) * 1000000L,
  };
  while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
  _exit(124);
}

static pthread_t watchdog_thread;
static int watchdog_started = 0;

static void start_watchdog(void) {
  const char *value = getenv("EXPLODEX_RUNTIME_HELPER_TIMEOUT_MS");
  if (value == NULL) return;
  char *end = NULL;
  long milliseconds = strtol(value, &end, 10);
  if (end == value || *end != '\0' || milliseconds <= 0 || milliseconds > 600000) return;
  long *context = malloc(sizeof(*context));
  if (context == NULL) _exit(70);
  *context = milliseconds;
  if (pthread_create(&watchdog_thread, NULL, watchdog_main, context) != 0) {
    free(context);
    _exit(70);
  }
  watchdog_started = 1;
}

static int pause_watchdog(void) {
  if (!watchdog_started) return 0;
  if (pthread_cancel(watchdog_thread) != 0) return 70;
  if (pthread_join(watchdog_thread, NULL) != 0) return 70;
  watchdog_started = 0;
  return 0;
}

int main(int argc, char **argv) {
  start_watchdog();
  if (argc < 2) return 64;
  if (strcmp(argv[1], "identify") == 0 && argc == 3) {
    pid_t pid;
    int status = parse_pid(argv[2], &pid);
    return status == 0 ? identify(pid) : status;
  }
  if (strcmp(argv[1], "signal") == 0 && argc == 5) {
    pid_t pid;
    int status = parse_pid(argv[2], &pid);
    if (status != 0) return status;
    int signal_number =
      strcmp(argv[4], "SIGTERM") == 0
        ? SIGTERM
        : strcmp(argv[4], "SIGINT") == 0
          ? SIGINT
          : 0;
    return signal_number == 0 ? 64 : signal_exact(pid, argv[3], signal_number);
  }
  if (strcmp(argv[1], "compare-remove-directory") == 0 && argc == 5) {
    return compare_remove_directory(argv[2], argv[3], argv[4]);
  }
  if (strcmp(argv[1], "rename-exclusive") == 0 && argc == 4) {
    errno = 0;
    if (renamex_np(argv[2], argv[3], RENAME_EXCL) == 0) return 0;
    return errno == EEXIST || errno == ENOTEMPTY ? 3 : 70;
  }
  return 64;
}
