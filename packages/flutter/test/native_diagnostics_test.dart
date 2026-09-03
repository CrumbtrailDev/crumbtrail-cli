import 'dart:async';

import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeNativeDiagnostics implements CrumbtrailNativeDiagnosticsPlatform {
  FakeNativeDiagnostics({this.events = const []});

  final List<CrumbtrailNativeDiagnosticEvent> events;
  bool acknowledged = false;

  @override
  Future<CrumbtrailNativeCapabilities> getCapabilities() async =>
      const CrumbtrailNativeCapabilities(
        nativeDiagnostics: CrumbtrailNativeCapabilityDetail(
          supported: true,
          enabled: true,
          observed: false,
        ),
        nativeHang: CrumbtrailNativeCapabilityDetail(
          supported: true,
          enabled: true,
          observed: false,
        ),
        nativeCrash: CrumbtrailNativeCapabilityDetail(
          supported: true,
          enabled: true,
          observed: false,
        ),
        appLifecycle: CrumbtrailNativeCapabilityDetail(
          supported: true,
          enabled: true,
          observed: false,
        ),
      );

  @override
  Future<CrumbtrailNativeDiagnosticBatch> drainDiagnostics() async =>
      CrumbtrailNativeDiagnosticBatch(
          token: events.isEmpty ? '' : 'fake', events: events);

  @override
  Future<bool> acknowledgeDiagnostics(String token) async {
    acknowledged = token == 'fake';
    return acknowledged;
  }
}

class ConfigurableNativeDiagnostics
    implements
        CrumbtrailNativeDiagnosticsPlatform,
        CrumbtrailNativeDiagnosticsConfigurable {
  bool? enabled;
  bool drained = false;

  @override
  Future<void> setEnabled(bool value) async {
    enabled = value;
  }

  @override
  Future<CrumbtrailNativeCapabilities> getCapabilities() async =>
      const CrumbtrailNativeCapabilities(
        nativeDiagnostics: CrumbtrailNativeCapabilityDetail(
          supported: true,
          enabled: true,
          observed: false,
        ),
        nativeHang: CrumbtrailNativeCapabilityDetail(
          supported: true,
          enabled: true,
          observed: false,
        ),
        nativeCrash: CrumbtrailNativeCapabilityDetail(
          supported: true,
          enabled: true,
          observed: false,
        ),
        appLifecycle: CrumbtrailNativeCapabilityDetail(
          supported: true,
          enabled: true,
          observed: false,
        ),
      );

  @override
  Future<CrumbtrailNativeDiagnosticBatch> drainDiagnostics() async {
    drained = true;
    return const CrumbtrailNativeDiagnosticBatch(token: '', events: []);
  }

  @override
  Future<bool> acknowledgeDiagnostics(String token) async => false;
}

class DelayedNativeDiagnostics implements CrumbtrailNativeDiagnosticsPlatform {
  final Completer<void> capabilityGate = Completer<void>();
  bool capabilityRead = false;

  @override
  Future<CrumbtrailNativeCapabilities> getCapabilities() async {
    await capabilityGate.future;
    capabilityRead = true;
    return CrumbtrailNativeCapabilities.absent;
  }

  @override
  Future<CrumbtrailNativeDiagnosticBatch> drainDiagnostics() async =>
      const CrumbtrailNativeDiagnosticBatch(token: '', events: []);

  @override
  Future<bool> acknowledgeDiagnostics(String token) async => false;
}

class RecordingTransport implements CrumbtrailTransport {
  final List<List<CrumbtrailEvent>> batches = [];

  @override
  Future<void> startSession(String id, Map<String, Object?> metadata) async {}

  @override
  Future<void> sendEvents(
      String sessionId, List<CrumbtrailEvent> events) async {
    batches.add(events);
  }

  @override
  Future<void> endSession(String id) async {}
}

void main() {
  test('native bridge drains shared events and reports capability state',
      () async {
    final transport = RecordingTransport();
    final logger = Crumbtrail(
      config: const CrumbtrailConfig(
        endpoint: 'https://ingest.example.com',
        flushBatchSize: 100,
      ),
      transport: transport,
      nativeDiagnosticsPlatform: FakeNativeDiagnostics(
        events: [
          const CrumbtrailNativeDiagnosticEvent(
            kind: 'native-crash',
            data: {'msg': 'boom', 'source': 'previous-launch'},
          ),
          const CrumbtrailNativeDiagnosticEvent(
            kind: 'app-lifecycle',
            data: {'state': 'background', 'source': 'uiapplication'},
          ),
        ],
      ),
      startTimer: false,
    );

    await logger.startNativeDiagnostics();
    await logger.flush();

    final events = transport.batches.expand((batch) => batch);
    expect(
      events.any(
        (event) =>
            event.kind == 'env' && event.data['kind'] == 'native-capabilities',
      ),
      isTrue,
    );
    expect(events.where((event) => event.kind == 'native-crash'), hasLength(1));
    expect(
      events.where((event) => event.kind == 'app-lifecycle'),
      hasLength(1),
    );
    await logger.stop();
  });

  test(
      'Dart watchdog records a foreground stall and respects pause and debug suppression',
      () {
    fakeAsync((async) {
      var nowMs = 0;
      final events = <Map<String, Object?>>[];
      final watchdog = CrumbtrailDartEventLoopWatchdog(
        threshold: const Duration(seconds: 5),
        checkInterval: const Duration(seconds: 1),
        now: () => DateTime.fromMillisecondsSinceEpoch(nowMs),
        suppressInDebug: false,
        onHang: (data) {
          events.add(data);
          return true;
        },
      );
      watchdog.start();

      nowMs = 6500;
      async.elapse(const Duration(seconds: 1));
      expect(events, hasLength(1));
      expect(events.single['source'], 'dart');
      expect(events.single['recovered'], true);

      watchdog.pause();
      nowMs = 20000;
      async.elapse(const Duration(seconds: 10));
      expect(events, hasLength(1));

      watchdog.stop();
    });

    fakeAsync((async) {
      final events = <Map<String, Object?>>[];
      final watchdog = CrumbtrailDartEventLoopWatchdog(
        onHang: (data) {
          events.add(data);
          return true;
        },
        // Flutter's test runtime is debug mode. This verifies that the default
        // does not report development timer pauses as production hangs.
      );
      watchdog.start();
      async.elapse(const Duration(seconds: 20));
      expect(events, isEmpty);
      watchdog.stop();
    });
  });

  test('Dart watchdog rearms after a debugger detaches', () {
    fakeAsync((async) {
      var nowMs = 0;
      var debuggerAttached = true;
      final events = <Map<String, Object?>>[];
      final watchdog = CrumbtrailDartEventLoopWatchdog(
        checkInterval: const Duration(seconds: 1),
        monotonicNow: () => Duration(milliseconds: nowMs),
        debuggerAttached: () => debuggerAttached,
        suppressInDebug: false,
        onHang: (data) {
          events.add(data);
          return true;
        },
      );

      watchdog.start();
      nowMs = 6500;
      async.elapse(const Duration(seconds: 1));
      expect(events, isEmpty);

      debuggerAttached = false;
      nowMs = 13000;
      async.elapse(const Duration(seconds: 1));
      expect(events, hasLength(1));
      watchdog.stop();
    });
  });

  test('previous Dart handoff is bounded and imported once', () async {
    final handoff = MemoryCrumbtrailDartHangHandoff();
    await handoff.deliver(const {
      'source': 'dart',
      'thresholdMs': 5000,
      'observedDurationMs': 7000,
      'recovered': true,
      'previousLaunch': false,
    }, (_) => false);
    final seen = <Map<String, Object?>>[];
    final watchdog = CrumbtrailDartEventLoopWatchdog(
      handoff: handoff,
      suppressInDebug: true,
      onHang: (data) {
        seen.add(data);
        return true;
      },
    );

    watchdog.start();
    await Future<void>.delayed(Duration.zero);
    expect(seen.single['previousLaunch'], true);
    await expectLater(handoff.drain((_) => false), completion(isFalse));
    await watchdog.stop();
  });

  test('disabled native diagnostics configures the plugin off', () async {
    final transport = RecordingTransport();
    final native = ConfigurableNativeDiagnostics();
    final logger = Crumbtrail(
      config: const CrumbtrailConfig(
        endpoint: 'https://ingest.example.com',
        flushBatchSize: 100,
        collectors: CrumbtrailCollectors(nativeDiagnostics: false),
      ),
      transport: transport,
      nativeDiagnosticsPlatform: native,
      startTimer: false,
    );

    await logger.startNativeDiagnostics();
    await logger.flush();
    final events = transport.batches.expand((batch) => batch).toList();
    final capability = events.singleWhere(
      (event) =>
          event.kind == 'env' && event.data['kind'] == 'native-capabilities',
    );
    final nativeData = capability.data['native'] as Map<String, Object?>;
    final diagnostics = nativeData['nativeDiagnostics'] as Map<String, Object?>;
    expect(native.enabled, false);
    expect(native.drained, false);
    expect(diagnostics['supported'], true);
    expect(diagnostics['enabled'], false);
    await logger.stop();
    expect(native.enabled, false);
  });

  test('a stale handoff clear cannot erase a newer event', () async {
    final handoff = MemoryCrumbtrailDartHangHandoff();
    const older = <String, Object?>{
      'source': 'dart',
      'thresholdMs': 5000,
      'observedDurationMs': 6000,
      'recovered': true,
      'previousLaunch': false,
    };
    const newer = <String, Object?>{
      'source': 'dart',
      'thresholdMs': 5000,
      'observedDurationMs': 7000,
      'recovered': true,
      'previousLaunch': false,
    };

    await handoff.deliver(older, (_) => false);
    await handoff.deliver(newer, (_) => true);
    await expectLater(handoff.drain((_) => true), completion(isFalse));
  });

  test('watchdog stop waits for an in-flight host acceptance', () async {
    final handoff = MemoryCrumbtrailDartHangHandoff();
    await handoff.deliver(const {
      'source': 'dart',
      'thresholdMs': 5000,
      'observedDurationMs': 7000,
      'recovered': true,
      'previousLaunch': false,
    }, (_) => false);
    final acceptance = Completer<bool>();
    var callbackStarted = false;
    final watchdog = CrumbtrailDartEventLoopWatchdog(
      handoff: handoff,
      onHang: (_) {
        callbackStarted = true;
        return acceptance.future;
      },
    );

    watchdog.start();
    await Future<void>.delayed(Duration.zero);
    expect(callbackStarted, isTrue);
    var stopped = false;
    final stopping = watchdog.stop().then((_) => stopped = true);
    await Future<void>.delayed(Duration.zero);
    expect(stopped, isFalse);
    acceptance.complete(false);
    await stopping;
    expect(stopped, isTrue);
    await expectLater(handoff.drain((_) => false), completion(isFalse));
  });

  test('native diagnostics startup cannot resume after stop', () async {
    final transport = RecordingTransport();
    final native = DelayedNativeDiagnostics();
    final logger = Crumbtrail(
      config: const CrumbtrailConfig(
        endpoint: 'https://ingest.example.com',
        flushBatchSize: 100,
        collectors: CrumbtrailCollectors(
          environment: false,
          nativeDiagnostics: true,
          nativeWatchdog: true,
        ),
      ),
      transport: transport,
      nativeDiagnosticsPlatform: native,
      startTimer: false,
    );

    final starting = logger.startNativeDiagnostics();
    await Future<void>.delayed(Duration.zero);
    final stopping = logger.stop();
    await Future<void>.delayed(Duration.zero);
    expect(native.capabilityRead, isFalse);
    native.capabilityGate.complete();
    await starting;
    await stopping;
    expect(native.capabilityRead, isTrue);
    expect(
      transport.batches.expand((batch) => batch),
      isNot(contains(predicate<CrumbtrailEvent>(
          (event) => event.data['kind'] == 'native-capabilities'))),
    );
  });

  test('serializes custom handoff acceptance before the next durable write',
      () async {
    final handoff = MemoryCrumbtrailDartHangHandoff();
    final order = <String>[];
    const older = <String, Object?>{
      'source': 'dart',
      'thresholdMs': 5000,
      'observedDurationMs': 6000,
      'recovered': true,
      'previousLaunch': false,
    };
    const newer = <String, Object?>{
      'source': 'dart',
      'thresholdMs': 5000,
      'observedDurationMs': 7000,
      'recovered': true,
      'previousLaunch': false,
    };

    final first = handoff.deliver(older, (_) async {
      order.add('older');
      await Future<void>.delayed(Duration.zero);
      return false;
    });
    final second = handoff.deliver(newer, (_) {
      order.add('newer');
      return true;
    });

    expect(await first, isFalse);
    expect(await second, isTrue);
    expect(order, <String>['older', 'newer']);
    await expectLater(handoff.drain((_) => true), completion(isFalse));
  });
}
