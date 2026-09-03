import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeNativeDiagnostics implements CrumbtrailNativeDiagnosticsPlatform {
  FakeNativeDiagnostics({this.events = const []});

  final List<CrumbtrailNativeDiagnosticEvent> events;

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
  Future<List<CrumbtrailNativeDiagnosticEvent>> drainDiagnostics() async =>
      events;
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
        onHang: events.add,
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
        onHang: events.add,
        // Flutter's test runtime is debug mode. This verifies that the default
        // does not report development timer pauses as production hangs.
      );
      watchdog.start();
      async.elapse(const Duration(seconds: 20));
      expect(events, isEmpty);
      watchdog.stop();
    });
  });

  test('previous Dart handoff is bounded and imported once', () {
    final handoff = MemoryCrumbtrailDartHangHandoff();
    handoff.write(const {
      'source': 'dart',
      'thresholdMs': 5000,
      'observedDurationMs': 7000,
      'recovered': true,
      'previousLaunch': false,
    });
    final seen = <Map<String, Object?>>[];
    final watchdog = CrumbtrailDartEventLoopWatchdog(
      handoff: handoff,
      suppressInDebug: true,
      onHang: seen.add,
    );

    watchdog.start();
    expect(seen.single['previousLaunch'], true);
    expect(handoff.read(), isNull);
    watchdog.stop();
  });
}
