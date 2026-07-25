#include <errno.h>
#include <libproc.h>
#include <mach/message.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define PROC_PIDUNIQIDENTIFIERINFO 17

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
  return 64;
}
