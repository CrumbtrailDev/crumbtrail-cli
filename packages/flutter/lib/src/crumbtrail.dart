import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'event.dart';
import 'redaction.dart';
import 'session.dart';
import 'transport.dart';

const CrumbtrailSdkDescriptor crumbtrailSdk =
    CrumbtrailSdkDescriptor(name: 'crumbtrail-flutter', version: '0.1.0');

/// A window of capture that was lost, and why.
class CrumbtrailCaptureGap {
  const CrumbtrailCaptureGap({
    required this.eventCount,
    required this.reason,
    required this.at,
  });

  final int eventCount;
  final String reason;
  final int at;
}

class CrumbtrailCollectors {
  const CrumbtrailCollectors({
    this.errors = true,
    this.appLifecycle = true,
    this.environment = true,
  });

  final bool errors;
  final bool appLifecycle;
  final bool environment;
}

class CrumbtrailConfig {
  const CrumbtrailConfig({
    required this.endpoint,
    this.ingestKey,
    this.service,
    // Thirty minutes matches the browser SDK: long enough that a user who
    // backgrounds the app to read an email resumes the same session, short
    // enough that yesterday's is never stitched onto today's bug.
    this.sessionIdleMs = 30 * 60 * 1000,
    this.queueCapacity = 2000,
    this.flushBatchSize = 50,
    this.flushInterval = const Duration(seconds: 10),
    this.collectors = const CrumbtrailCollectors(),
  });

  final String endpoint;

  /// Ingest key (`ctkey_`). Write only by design.
  final String? ingestKey;

  /// Which app in the project this is. One key covers a whole project, so
  /// without this every app in it ingests as an anonymous sender.
  final String? service;

  final int sessionIdleMs;
  final int queueCapacity;
  final int flushBatchSize;
  final Duration flushInterval;
  final CrumbtrailCollectors collectors;
}

/// A bounded, thread-safe-enough buffer of pending events.
///
/// Bounded on purpose. An app that logs in a tight loop, or spends ten minutes
/// offline in a lift, out-produces the transport. An unbounded queue answers
/// that by growing until the OS kills the app for memory, turning a telemetry
/// SDK into the crash it was installed to explain. Dropping the oldest keeps the
/// most recent window, which is the window a bug is in — and drops are counted,
/// because a session that quietly lost events reads exactly like a session where
/// nothing happened.
class CrumbtrailEventQueue {
  CrumbtrailEventQueue({int capacity = 2000})
      : _capacity = capacity < 1 ? 1 : capacity;

  final int _capacity;
  final List<CrumbtrailEvent> _events = [];
  int _dropped = 0;

  int get dropped => _dropped;
  int get length => _events.length;

  void append(CrumbtrailEvent event) {
    _events.add(event);
    _trim();
  }

  List<CrumbtrailEvent> drain() {
    final taken = List<CrumbtrailEvent>.from(_events);
    _events.clear();
    return taken;
  }

  /// Put a failed batch back at the FRONT, preserving order. Re-appending at the
  /// back would reorder a retried batch behind events that happened after it,
  /// and an out-of-order timeline invents causality that never occurred.
  void requeue(List<CrumbtrailEvent> batch) {
    if (batch.isEmpty) return;
    _events.insertAll(0, batch);
    _trim();
  }

  void _trim() {
    while (_events.length > _capacity) {
      _events.removeAt(0);
      _dropped++;
    }
  }
}

/// The capture session.
class Crumbtrail with WidgetsBindingObserver {
  Crumbtrail({
    required this.config,
    required CrumbtrailTransport transport,
    CrumbtrailSessionStore? store,
    Map<String, Object?>? deviceInfo,
    List<String> capabilities = const [],
    int Function()? clock,
    bool startTimer = true,
  })  : _transport = transport,
        _store = store ?? MemorySessionStore(),
        _capabilities = capabilities,
        _clock = clock ?? (() => DateTime.now().millisecondsSinceEpoch),
        _queue = CrumbtrailEventQueue(capacity: config.queueCapacity) {
    final session = CrumbtrailSessionResolver.resolve(
      store: _store,
      idleMs: config.sessionIdleMs,
      now: _clock(),
    );
    sessionId = session.id;

    final device = deviceInfo ?? describePlatform();
    unawaited(_transport.startSession(sessionId, compactJson({
      'service': config.service,
      'platform': CrumbtrailPlatform.flutter.wireValue,
      'device': device,
    })));

    if (config.collectors.environment) {
      addEvent(
        CrumbtrailEventKind.environment,
        compactJson({'kind': 'snapshot', 'device': device}),
      );
    }

    if (startTimer && config.flushInterval > Duration.zero) {
      _flushTimer = Timer.periodic(config.flushInterval, (_) => flush());
    }
  }

  final CrumbtrailConfig config;
  final CrumbtrailTransport _transport;
  final CrumbtrailSessionStore _store;
  final CrumbtrailEventQueue _queue;
  final List<String> _capabilities;
  final int Function() _clock;

  late final String sessionId;
  Timer? _flushTimer;
  bool _stopped = false;
  final List<CrumbtrailCaptureGap> _gaps = [];
  final List<void Function()> _cleanups = [];

  List<CrumbtrailCaptureGap> get gaps => List.unmodifiable(_gaps);
  int get droppedEventCount => _queue.dropped;

  static Crumbtrail? _shared;
  static Crumbtrail? get instance => _shared;

  /// Start capture.
  ///
  /// Awaits `SharedPreferences` before resolving the session, so a session id
  /// from a previous launch is actually restored. Without that await every cold
  /// start opens a new session and a once-a-day intermittent bug never
  /// accumulates into one recurring signature.
  static Future<Crumbtrail> start(CrumbtrailConfig config) async {
    WidgetsFlutterBinding.ensureInitialized();
    final preferences = await SharedPreferences.getInstance();
    final logger = Crumbtrail(
      config: config,
      transport: CrumbtrailHttpTransport(
        endpoint: config.endpoint,
        ingestKey: config.ingestKey,
      ),
      store: SharedPreferencesSessionStore(preferences),
    );
    if (config.collectors.errors) logger.installErrorHandlers();
    if (config.collectors.appLifecycle) {
      WidgetsBinding.instance.addObserver(logger);
      logger._cleanups.add(
        () => WidgetsBinding.instance.removeObserver(logger),
      );
    }
    _shared = logger;
    return logger;
  }

  // MARK: recording

  void addEvent(
    CrumbtrailEventKind kind,
    Map<String, Object?> data, {
    CrumbtrailTarget? target,
  }) {
    if (_stopped) return;
    _queue.append(CrumbtrailEvent.of(
      timestamp: _clock(),
      kind: kind,
      data: data,
      sdk: crumbtrailSdk,
      capabilities: _capabilities,
      target: target,
    ));
    // Touch the session so a resumed one does not expire mid-use.
    _store.write(PersistedSession(id: sessionId, lastActivity: _clock()));
    if (_queue.length >= config.flushBatchSize) unawaited(flush());
  }

  /// Record a caught error. `fatal` stays false: the app survived.
  void recordError(
    Object error,
    StackTrace? stack, {
    bool fatal = false,
    String source = 'manual',
  }) {
    addEvent(
      CrumbtrailEventKind.error,
      compactJson({
        'msg': error.toString(),
        'stk': stack?.toString(),
        'fatal': fatal,
        'source': source,
      }),
    );
  }

  /// Record a completed request. The URL goes through redaction first.
  void recordRequest({
    required String url,
    required String method,
    int? status,
    required int durationMs,
    String source = 'manual',
    String? error,
  }) {
    addEvent(
      CrumbtrailEventKind.network,
      compactJson({
        'url': CrumbtrailRedaction.redactUrl(url),
        'method': method.toUpperCase(),
        'status': status,
        'ok': status == null ? null : status >= 200 && status < 300,
        'dur': durationMs,
        'source': source,
        'error': error,
      }),
    );
  }

  // MARK: error handlers

  /// Capture both halves of Flutter's error surface.
  ///
  /// `FlutterError.onError` catches errors inside the framework — a failed
  /// build, layout or paint. `PlatformDispatcher.onError` catches everything
  /// else that reaches the root zone, which is where an unawaited Future's
  /// failure lands. Installing only the first is the common mistake, and it
  /// misses precisely the async failures that produce the hardest bugs.
  void installErrorHandlers() {
    final previousFlutterError = FlutterError.onError;
    FlutterError.onError = (details) {
      addEvent(
        CrumbtrailEventKind.error,
        compactJson({
          'msg': details.exceptionAsString(),
          'stk': details.stack?.toString(),
          // The framework caught this and kept going, so the app survived.
          'fatal': false,
          'library': details.library,
          'source': 'flutter-error',
        }),
      );
      // Chain, rather than replace. An app already using a crash reporter would
      // otherwise silently lose it the moment Crumbtrail is added.
      previousFlutterError?.call(details);
    };

    final previousPlatformError = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (error, stack) {
      addEvent(
        CrumbtrailEventKind.error,
        compactJson({
          'msg': error.toString(),
          'stk': stack.toString(),
          'fatal': true,
          'source': 'platform-dispatcher',
        }),
      );
      unawaited(flush());
      return previousPlatformError?.call(error, stack) ?? false;
    };

    _cleanups.add(() {
      FlutterError.onError = previousFlutterError;
      PlatformDispatcher.instance.onError = previousPlatformError;
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    addEvent(
      CrumbtrailEventKind.appLifecycle,
      {'state': state.name, 'source': 'widgets-binding'},
    );
    // Backgrounding is the last reliable moment to deliver: the OS may suspend
    // or kill the process seconds later and never resume it, so a batch still
    // sitting in the queue would go with the app.
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(flush());
    }
  }

  // MARK: delivery

  /// Send everything buffered.
  ///
  /// A refusal is not retried: the server already answered, and the identical
  /// batch would be refused identically, so it becomes a declared gap. A network
  /// failure IS retried, with the batch put back at the front so the timeline
  /// keeps its order.
  Future<void> flush() async {
    final batch = _queue.drain();
    if (batch.isEmpty) return;
    try {
      await _transport.sendEvents(sessionId, batch);
    } on CrumbtrailRefused catch (error) {
      _gaps.add(CrumbtrailCaptureGap(
        eventCount: error.eventCount,
        reason: 'refused-${error.status}',
        at: _clock(),
      ));
    } on Object {
      _queue.requeue(batch);
    }
  }

  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    _flushTimer?.cancel();
    _flushTimer = null;
    for (final cleanup in _cleanups.reversed) {
      cleanup();
    }
    _cleanups.clear();
    await flush();
    await _transport.endSession(sessionId);
    if (identical(_shared, this)) _shared = null;
  }

  /// Device and OS facts from `dart:io`.
  ///
  /// Deliberately not `device_info_plus`. That would add a dependency (and a
  /// platform channel) to learn the marketing device name, while the OS and
  /// version — which is what actually narrows a bug — are already here for free.
  /// Nothing collected identifies a person.
  static Map<String, Object?> describePlatform() {
    if (kIsWeb) return {'os': 'web'};
    try {
      return compactJson({
        'os': Platform.operatingSystem,
        'osVersion': Platform.operatingSystemVersion,
        'locale': Platform.localeName,
        'dartVersion': Platform.version.split(' ').first,
      });
    } on Object {
      return const {};
    }
  }
}

/// `SharedPreferences`-backed session store.
class SharedPreferencesSessionStore implements CrumbtrailSessionStore {
  SharedPreferencesSessionStore(this._preferences,
      {this.key = 'ai.crumbtrail.session'});

  final SharedPreferences _preferences;
  final String key;

  @override
  PersistedSession? read() =>
      PersistedSession.tryParse(_preferences.getString(key));

  @override
  void write(PersistedSession session) {
    // Fire and forget: a failed durable write must never break capture. The
    // current session stays coherent in memory; only cross-launch stitching
    // is lost.
    unawaited(
      _preferences.setString(key, canonicalJsonEncode(session.toJson())),
    );
  }

  @override
  void clear() => unawaited(_preferences.remove(key));
}
