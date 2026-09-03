#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <mach/mach_time.h>

static NSString * const CTNativeDiagnosticsPendingKey = @"native-diagnostics";
static NSString * const CTNativeDiagnosticsSuite = @"ai.crumbtrail.react-native";
static NSUInteger const CTNativeDiagnosticsMaxEvents = 32;
static NSUInteger const CTNativeDiagnosticsMaxText = 8192;
static NSTimeInterval const CTNativeDiagnosticsHangThreshold = 5.0;

@class CrumbtrailNativeDiagnostics;
static __weak CrumbtrailNativeDiagnostics *CTActiveNativeDiagnostics;
static NSUncaughtExceptionHandler *CTPreviousExceptionHandler;

@interface CrumbtrailNativeDiagnostics : NSObject <RCTBridgeModule> {
  dispatch_source_t _watchdog;
  uint64_t _lastHeartbeat;
  BOOL _watchdogPending;
  NSUncaughtExceptionHandler *_previousExceptionHandler;
  NSMutableArray *_observerTokens;
}
- (void)appendPendingKind:(NSString *)kind data:(NSDictionary *)data;
@end

static void CTNativeDiagnosticsUncaughtException(NSException *exception) {
  CrumbtrailNativeDiagnostics *module = CTActiveNativeDiagnostics;
  if (module) {
    [module appendPendingKind:@"native-crash" data:@{
      @"msg": exception.reason ?: exception.name ?: @"uncaught exception",
      @"stk": [[exception callStackSymbols] componentsJoinedByString:@"\n"],
      @"signal": exception.name ?: @"unknown",
      @"source": @"previous-launch",
    }];
  }
  if (CTPreviousExceptionHandler) CTPreviousExceptionHandler(exception);
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
  [self installCrashHandler];
  [self installLifecycleCollector];
  [self startWatchdog];
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

RCT_EXPORT_METHOD(drainDiagnostics:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    NSUserDefaults *defaults = [self defaults];
    NSArray *events = [defaults arrayForKey:CTNativeDiagnosticsPendingKey] ?: @[];
    [defaults removeObjectForKey:CTNativeDiagnosticsPendingKey];
    NSMutableArray *result = [NSMutableArray arrayWithCapacity:events.count];
    for (id value in events) {
      if (![value isKindOfClass:[NSDictionary class]]) continue;
      NSDictionary *item = (NSDictionary *)value;
      NSString *kind = item[@"kind"];
      NSDictionary *data = item[@"data"];
      if (![kind isKindOfClass:[NSString class]] ||
          ![data isKindOfClass:[NSDictionary class]]) continue;
      [result addObject:@{ @"kind": kind, @"data": [self boundedData:data] }];
    }
    resolve(result);
  } @catch (__unused NSException *exception) {
    resolve(@[]);
  }
}

- (NSDictionary<NSString *, NSNumber *> *)capability {
  return @{ @"supported": @YES, @"enabled": @YES, @"observed": @NO };
}

- (NSUserDefaults *)defaults {
  return [[NSUserDefaults alloc] initWithSuiteName:CTNativeDiagnosticsSuite] ?: [NSUserDefaults standardUserDefaults];
}

- (void)installCrashHandler {
  _previousExceptionHandler = NSGetUncaughtExceptionHandler();
  CTPreviousExceptionHandler = _previousExceptionHandler;
  CTActiveNativeDiagnostics = self;
  NSSetUncaughtExceptionHandler(CTNativeDiagnosticsUncaughtException);
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
  for (NSDictionary *entry in notifications) {
    id token = [center addObserverForName:entry[@"name"] object:nil queue:[NSOperationQueue mainQueue]
                    usingBlock:^(__unused NSNotification *notification) {
      [self appendPendingKind:@"app-lifecycle" data:@{
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
  @try {
    NSUserDefaults *defaults = [self defaults];
    NSMutableArray *events = [[defaults arrayForKey:CTNativeDiagnosticsPendingKey] mutableCopy] ?: [NSMutableArray array];
    while (events.count >= CTNativeDiagnosticsMaxEvents) [events removeObjectAtIndex:0];
    [events addObject:@{ @"kind": kind, @"data": [self boundedData:data] }];
    [defaults setObject:events forKey:CTNativeDiagnosticsPendingKey];
    [defaults synchronize];
  } @catch (__unused NSException *exception) {
    // A diagnostics write is best effort and never a host failure.
  }
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
  if (_watchdog) dispatch_source_cancel(_watchdog);
  for (id token in _observerTokens) {
    [[NSNotificationCenter defaultCenter] removeObserver:token];
  }
  if (CTActiveNativeDiagnostics == self) {
    if (NSGetUncaughtExceptionHandler() == CTNativeDiagnosticsUncaughtException) {
      NSSetUncaughtExceptionHandler(_previousExceptionHandler);
    }
    CTActiveNativeDiagnostics = nil;
    CTPreviousExceptionHandler = nil;
  }
}

@end
