#ifndef CRUMBTRAIL_WATCHDOG_CLOCK_H
#define CRUMBTRAIL_WATCHDOG_CLOCK_H

#include <stdint.h>

static inline uint64_t CTWatchdogElapsedMilliseconds(
    uint64_t now, uint64_t heartbeat, uint32_t numerator, uint32_t denominator) {
  if (now <= heartbeat || denominator == 0) return 0;
  long double milliseconds = (long double)(now - heartbeat) * numerator / denominator / 1000000.0L;
  return milliseconds >= 86400000.0L ? 86400000ULL : (uint64_t)milliseconds;
}

#endif
