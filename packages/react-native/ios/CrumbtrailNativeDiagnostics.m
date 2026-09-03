#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <mach/mach_time.h>

static NSString * const CTNativeDiagnosticsPendingKey = @"native-diagnostics";
static NSString * const CTNativeDiagnosticsSuite = @"ai.crumbtrail.react-native";
static NSUInteger const CTNativeDiagnosticsMaxEvents = 32;
static NSUInteger const CTNativeDiagnosticsMaxText = 8192;
static NSUInteger const CTNativeDiagnosticsMaxPersistenceAttempts = 3;
static NSTimeInterval const CTNativeDiagnosticsHangThreshold = 5.0;

@class CrumbtrailNativeDiagnostics;
static NSHashTable<CrumbtrailNativeDiagnostics *> *CTActiveNativeDiagnostics;
static NSUncaughtExceptionHandler *CTPreviousExceptionHandler;
static NSLock *CTExceptionHandlerLock;
static NSLock *CTPendingEventsLock;
static NSString *CTInFlightDiagnosticsToken;
static NSArray<NSDictionary *> *CTInFlightDiagnosticsEvents;

@interface CrumbtrailNativeDiagnostics : NSObject <RCTBridgeModule> {
  dispatch_source_t _watchdog;
  uint64_t _lastHeartbeat;
  BOOL _watchdogPending;
  BOOL _enabled;
  BOOL _collectorsStarted;
  NSMutableArray *_observerTokens;
}
- (void)appendPendingKind:(NSString *)kind data:(NSDictionary *)data;
- (void)startCollectors;
- (void)stopCollectors;
- (NSDictionary *)responseEvent:(id)value;
- (NSDictionary *)emptyDiagnosticsBatch;
@end

static void CTNativeDiagnosticsUncaughtException(NSException *exception) {
  NSArray<CrumbtrailNativeDiagnostics *> *modules;
  NSUncaughtExceptionHandler *previous;
  [CTExceptionHandlerLock lock];
  modules = CTActiveNativeDiagnostics.allObjects;
  previous = CTPreviousExceptionHandler;
  [CTExceptionHandlerLock unlock];
  CrumbtrailNativeDiagnostics *module = modules.firstObject;
  if (module) {
    [module appendPendingKind:@"native-crash" data:@{
      @"msg": exception.reason ?: exception.name ?: @"uncaught exception",
      @"stk": [[exception callStackSymbols] componentsJoinedByString:@"\n"],
      @"signal": exception.name ?: @"unknown",
      @"source": @"previous-launch",
    }];
  }
  if (previous) previous(exception);
}

static void CTRegisterNativeDiagnostics(CrumbtrailNativeDiagnostics *module) {
  [CTExceptionHandlerLock lock];
  if (CTActiveNativeDiagnostics.count == 0 ||
      NSGetUncaughtExceptionHandler() != CTNativeDiagnosticsUncaughtException) {
    CTPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
    NSSetUncaughtExceptionHandler(CTNativeDiagnosticsUncaughtException);
  }
  [CTActiveNativeDiagnostics addObject:module];
  [CTExceptionHandlerLock unlock];
}

static void CTUnregisterNativeDiagnostics(CrumbtrailNativeDiagnostics *module) {
  [CTExceptionHandlerLock lock];
  [CTActiveNativeDiagnostics removeObject:module];
  if (CTActiveNativeDiagnostics.count == 0) {
    if (NSGetUncaughtExceptionHandler() == CTNativeDiagnosticsUncaughtException) {
      NSSetUncaughtExceptionHandler(CTPreviousExceptionHandler);
    }
    CTPreviousExceptionHandler = NULL;
  }
  [CTExceptionHandlerLock unlock];
}

@implementation CrumbtrailNativeDiagnostics

RCT_EXPORT_MODULE(CrumbtrailNativeDiagnostics)

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (!self) return nil;
  _observerTokens = [NSMutableArray array];
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    CTActiveNativeDiagnostics = [NSHashTable weakObjectsHashTable];
    CTExceptionHandlerLock = [NSLock new];
    CTPendingEventsLock = [NSLock new];
  });
  return self;
}

RCT_EXPORT_METHOD(getCapabilities:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@{
    @"nativeDiagnostics": [self capability],
    @"nativeHang": [self capability],
    @"nativeCrash": [self capability],
    @"appLifecycle": [self capability],
  });
}

RCT_EXPORT_METHOD(setEnabled:(BOOL)enabled) {
  if (enabled) [self startCollectors];
  else [self stopCollectors];
}

RCT_EXPORT_METHOD(drainDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    [CTPendingEventsLock lock];
    @try {
      if (!_enabled) {
        resolve([self emptyDiagnosticsBatch]);
        return;
      }
      if (CTInFlightDiagnosticsToken && CTInFlightDiagnosticsEvents) {
        NSMutableArray *events = [NSMutableArray arrayWithCapacity:CTInFlightDiagnosticsEvents.count];
        for (NSDictionary *value in CTInFlightDiagnosticsEvents) {
          NSDictionary *event = [self responseEvent:value];
          if (!event) {
            resolve([self emptyDiagnosticsBatch]);
            return;
          }
          [events addObject:event];
        }
        resolve(@{ @"token": CTInFlightDiagnosticsToken, @"events": events });
        return;
      }
      NSArray *raw = [[self defaults] arrayForKey:CTNativeDiagnosticsPendingKey] ?: @[];
      if (raw.count == 0) {
        resolve([self emptyDiagnosticsBatch]);
        return;
      }
      NSMutableArray *events = [NSMutableArray arrayWithCapacity:raw.count];
      for (id value in raw) {
        NSDictionary *event = [self responseEvent:value];
        if (!event) {
          resolve([self emptyDiagnosticsBatch]);
          return;
        }
        [events addObject:event];
      }
      CTInFlightDiagnosticsToken = [NSUUID UUID].UUIDString;
      CTInFlightDiagnosticsEvents = [raw copy];
      resolve(@{ @"token": CTInFlightDiagnosticsToken, @"events": events });
    } @finally {
      [CTPendingEventsLock unlock];
    }
  } @catch (__unused NSException *exception) {
    resolve([self emptyDiagnosticsBatch]);
  }
}

RCT_EXPORT_METHOD(acknowledgeDiagnostics:(NSString *)token
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  BOOL accepted = NO;
  [CTPendingEventsLock lock];
  @try {
    if (token.length > 0 && [token isEqualToString:CTInFlightDiagnosticsToken]) {
      NSArray *snapshot = CTInFlightDiagnosticsEvents;
      NSArray *current = [[self defaults] arrayForKey:CTNativeDiagnosticsPendingKey];
      if (snapshot && current.count >= snapshot.count) {
        accepted = YES;
        for (NSUInteger index = 0; index < snapshot.count; index++) {
          if (![current[index] isEqual:snapshot[index]]) {
            accepted = NO;
            break;
          }
        }
        if (accepted) {
          NSArray *remaining = [current subarrayWithRange:NSMakeRange(snapshot.count, current.count - snapshot.count)];
          NSUserDefaults *defaults = [self defaults];
          BOOL committed = NO;
          for (NSUInteger attempt = 0; attempt < CTNativeDiagnosticsMaxPersistenceAttempts; attempt++) {
            if (remaining.count == 0) [defaults removeObjectForKey:CTNativeDiagnosticsPendingKey];
            else [defaults setObject:remaining forKey:CTNativeDiagnosticsPendingKey];
            if ([defaults synchronize]) {
              committed = YES;
              break;
            }
          }
          if (!committed) {
            [defaults setObject:current forKey:CTNativeDiagnosticsPendingKey];
            accepted = NO;
          }
        }
      }
    }
    if (accepted) {
      CTInFlightDiagnosticsToken = nil;
      CTInFlightDiagnosticsEvents = nil;
    }
  } @catch (__unused NSException *exception) {
    accepted = NO;
  } @finally {
    [CTPendingEventsLock unlock];
  }
  resolve(@(accepted));
}

- (NSDictionary<NSString *, NSNumber *> *)capability {
  return @{ @"supported": @YES, @"enabled": @(_enabled), @"observed": @NO };
}

- (NSUserDefaults *)defaults {
  return [[NSUserDefaults alloc] initWithSuiteName:CTNativeDiagnosticsSuite] ?: [NSUserDefaults standardUserDefaults];
}

- (void)startCollectors {
  if (_collectorsStarted) return;
  _enabled = YES;
  _collectorsStarted = YES;
  CTRegisterNativeDiagnostics(self);
  [self installLifecycleCollector];
  [self startWatchdog];
}

- (void)stopCollectors {
  _enabled = NO;
  if (_watchdog) {
    dispatch_source_cancel(_watchdog);
    _watchdog = nil;
  }
  for (id token in _observerTokens) {
    [[NSNotificationCenter defaultCenter] removeObserver:token];
  }
  [_observerTokens removeAllObjects];
  if (_collectorsStarted) CTUnregisterNativeDiagnostics(self);
  _collectorsStarted = NO;
  _watchdogPending = NO;
}

- (void)installLifecycleCollector {
  NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
  NSArray<NSDictionary *> *notifications = @[
    @{ @"name": UIApplicationDidBecomeActiveNotification, @"state": @"active" },
    @{ @"name": UIApplicationWillResignActiveNotification, @"state": @"inactive" },
    @{ @"name": UIApplicationDidEnterBackgroundNotification, @"state": @"background" },
    @{ @"name": UIApplicationWillEnterForegroundNotification, @"state": @"foreground" },
    @{ @"name": UIApplicationDidReceiveMemoryWarningNotification, @"state": @"memory-warning" },
  ];
  __weak typeof(self) weakSelf = self;
  for (NSDictionary *entry in notifications) {
    id token = [center addObserverForName:entry[@"name"] object:nil queue:[NSOperationQueue mainQueue]
                    usingBlock:^(__unused NSNotification *notification) {
      [weakSelf appendPendingKind:@"app-lifecycle" data:@{
        @"state": entry[@"state"], @"source": @"uiapplication"
      }];
    }];
    if (token) [_observerTokens addObject:token];
  }
}

- (void)startWatchdog {
  _lastHeartbeat = mach_absolute_time();
  _watchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                      dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
  if (!_watchdog) return;
  dispatch_source_set_timer(_watchdog, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
                            NSEC_PER_SEC, NSEC_PER_MSEC * 50);
  __weak typeof(self) weakSelf = self;
  dispatch_source_set_event_handler(_watchdog, ^{
    CrumbtrailNativeDiagnostics *strongSelf = weakSelf;
    if (!strongSelf) return;
    if (!strongSelf->_enabled) return;
    uint64_t now = mach_absolute_time();
    mach_timebase_info_data_t info;
    mach_timebase_info(&info);
    uint64_t elapsed = (now - strongSelf->_lastHeartbeat) * info.numer / info.denom / NSEC_PER_MSEC;
    if (elapsed > (uint64_t)(CTNativeDiagnosticsHangThreshold * 1000.0) &&
        !strongSelf->_watchdogPending && ![strongSelf debuggerAttached]) {
      strongSelf->_watchdogPending = YES;
      [strongSelf appendPendingKind:@"native-hang" data:@{
        @"source": @"main-thread", @"thresholdMs": @5000,
        @"observedDurationMs": @(MIN(elapsed, 86400000ULL)),
        @"recovered": @NO, @"previousLaunch": @NO,
      }];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      strongSelf->_lastHeartbeat = mach_absolute_time();
    });
  });
  dispatch_resume(_watchdog);
}

- (BOOL)debuggerAttached {
#if DEBUG
  return YES;
#else
  return NO;
#endif
}

- (void)appendPendingKind:(NSString *)kind data:(NSDictionary *)data {
  [CTPendingEventsLock lock];
  @try {
    if (!_enabled) {
      return;
    }
    NSUserDefaults *defaults = [self defaults];
    NSMutableArray *events = [[defaults arrayForKey:CTNativeDiagnosticsPendingKey] mutableCopy] ?: [NSMutableArray array];
    NSArray *previous = [events copy];
    while (events.count >= CTNativeDiagnosticsMaxEvents) [events removeObjectAtIndex:0];
    [events addObject:@{ @"kind": kind, @"data": [self boundedData:data] }];
    BOOL committed = NO;
    for (NSUInteger attempt = 0; attempt < CTNativeDiagnosticsMaxPersistenceAttempts; attempt++) {
      [defaults setObject:events forKey:CTNativeDiagnosticsPendingKey];
      if ([defaults synchronize]) {
        committed = YES;
        break;
      }
    }
    if (!committed) {
      if (previous.count == 0) [defaults removeObjectForKey:CTNativeDiagnosticsPendingKey];
      else [defaults setObject:previous forKey:CTNativeDiagnosticsPendingKey];
    }
  } @catch (__unused NSException *exception) {
    // A diagnostics write is best effort and never a host failure.
  } @finally {
    [CTPendingEventsLock unlock];
  }
}

- (NSDictionary *)responseEvent:(id)value {
  if (![value isKindOfClass:[NSDictionary class]]) return nil;
  NSDictionary *item = (NSDictionary *)value;
  NSString *kind = item[@"kind"];
  NSDictionary *data = item[@"data"];
  if (![kind isKindOfClass:[NSString class]] || ![data isKindOfClass:[NSDictionary class]]) return nil;
  return @{ @"kind": kind, @"data": [self boundedData:data] };
}

- (NSDictionary *)emptyDiagnosticsBatch {
  return @{ @"token": @"", @"events": @[] };
}

- (NSDictionary *)boundedData:(NSDictionary *)data {
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  for (NSString *key in data) {
    if (![key isKindOfClass:[NSString class]] || key.length > 64) continue;
    id value = data[key];
    if ([value isKindOfClass:[NSString class]]) result[key] = [self bounded:value];
    else if ([value isKindOfClass:[NSNumber class]]) result[key] = value;
  }
  return result;
}

- (NSString *)bounded:(NSString *)value {
  return value.length > CTNativeDiagnosticsMaxText ? [value substringToIndex:CTNativeDiagnosticsMaxText] : value;
}

- (void)dealloc {
  [self stopCollectors];
}

@end
