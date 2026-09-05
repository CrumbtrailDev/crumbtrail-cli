import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records what it was asked to send, and fails on command.
class FakeTransport implements CrumbtrailTransport {
  FakeTransport({this.failure});

  /// Thrown by the next `sendEvents`, if set. Cleared after it throws once, so
  /// a test can assert on the retry that follows.
  CrumbtrailDeliveryException Function(int count)? failure;

  final List<List<CrumbtrailEvent>> batches = [];
  final List<String> started = [];
  final List<String> ended = [];
  Map<String, Object?>? startMetadata;

  List<CrumbtrailEvent> get allEvents =>
      batches.expand((batch) => batch).toList();

  @override
  Future<void> startSession(String id, Map<String, Object?> metadata) async {
    started.add(id);
    startMetadata = metadata;
  }

  @override
  Future<void> sendEvents(String sessionId, List<CrumbtrailEvent> events) async {
    final failNow = failure;
    if (failNow != null) {
      failure = null;
      throw failNow(events.length);
    }
    batches.add(events);
  }

  @override
  Future<void> endSession(String id) async => ended.add(id);
}

const _endpoint = 'https://ingest.example.com';

Crumbtrail buildLogger({
  CrumbtrailTransport? transport,
  CrumbtrailSessionStore? store,
  CrumbtrailConfig? config,
  int? now,
}) {
  return Crumbtrail(
    config: config ??
        const CrumbtrailConfig(
          endpoint: _endpoint,
          // Large enough that no test flushes by accident on batch size.
          flushBatchSize: 1000,
        ),
    transport: transport ?? FakeTransport(),
    store: store,
    deviceInfo: const {'os': 'test'},
    // A periodic timer in a unit test is a source of flake, not coverage.
    startTimer: false,
    clock: now == null ? null : () => now,
  );
}

void main() {
  group('session resolution', () {
    test('a recent session is resumed across launches', () {
      final store = MemorySessionStore(
        const PersistedSession(id: 'ses_previous', lastActivity: 1000000),
      );
      final logger = buildLogger(store: store, now: 1000000 + 60000);
      // Within the 30 minute idle window.
      expect(logger.sessionId, 'ses_previous');
    });

    test('a stale session is not resumed', () {
      final store = MemorySessionStore(
        const PersistedSession(id: 'ses_previous', lastActivity: 1000000),
      );
      // One millisecond past the idle window. Resuming here would stitch
      // yesterday's timeline onto today's bug.
      final logger = buildLogger(
        store: store,
        now: 1000000 + (30 * 60 * 1000) + 1,
      );
      expect(logger.sessionId, isNot('ses_previous'));
      expect(logger.sessionId, startsWith('ses_'));
    });

    test('the boundary itself resumes', () {
      final store = MemorySessionStore(
        const PersistedSession(id: 'ses_previous', lastActivity: 1000000),
      );
      final logger = buildLogger(
        store: store,
        now: 1000000 + (30 * 60 * 1000),
      );
      expect(logger.sessionId, 'ses_previous');
    });

    test('a corrupt stored session starts a fresh one rather than throwing', () {
      // Startup is the worst possible place to throw: the app would crash
      // because a telemetry SDK could not read its own scratch file.
      expect(PersistedSession.tryParse('{not json'), isNull);
      expect(PersistedSession.tryParse('{"lastActivity":1}'), isNull);
      expect(PersistedSession.tryParse('{"id":""}'), isNull);
      expect(PersistedSession.tryParse(null), isNull);
      expect(PersistedSession.tryParse('[]'), isNull);
    });

    test('a session missing lastActivity is treated as ancient', () {
      final parsed = PersistedSession.tryParse('{"id":"ses_x"}');
      expect(parsed, isNotNull);
      expect(parsed!.lastActivity, 0);
    });

    test('activity keeps a session from expiring mid-use', () {
      final store = MemorySessionStore();
      final logger = buildLogger(store: store, now: 5000000);
      logger.addEvent(CrumbtrailEventKind.console, {'lv': 'log'});
      expect(store.read()!.lastActivity, 5000000);
      expect(store.read()!.id, logger.sessionId);
    });

    test('minted ids carry a UTC stamp', () {
      final id = CrumbtrailSessionResolver.mintSessionId(1754000000000);
      expect(id, startsWith('ses_20250731_'));
      expect(id.split('_').last.length, 12);
    });

    test('minted ids do not collide', () {
      final ids = List.generate(
        200,
        (_) => CrumbtrailSessionResolver.mintSessionId(1754000000000),
      ).toSet();
      expect(ids.length, 200);
    });
  });

  group('delivery', () {
    test('a refusal is recorded as a gap, not retried', () async {
      final transport = FakeTransport(
        failure: (count) => CrumbtrailRefused(413, count),
      );
      final logger = buildLogger(transport: transport);
      logger.addEvent(CrumbtrailEventKind.console, {'lv': 'log'});
      await logger.flush();

      expect(logger.gaps, hasLength(1));
      expect(logger.gaps.single.reason, 'refused-413');
      // The server already answered. Retrying the identical batch would be
      // refused identically, and a silent drop reads as "nothing happened".
      expect(transport.batches, isEmpty);

      await logger.flush();
      expect(transport.batches, isEmpty);
    });

    test('an unreachable endpoint is retried on the next flush', () async {
      final transport = FakeTransport(
        failure: (count) => CrumbtrailUnreachable(count),
      );
      final logger = buildLogger(transport: transport);
      logger.addEvent(CrumbtrailEventKind.console, {'lv': 'log'});

      await logger.flush();
      expect(transport.batches, isEmpty);
      expect(logger.gaps, isEmpty);

      await logger.flush();
      expect(transport.allEvents, hasLength(2)); // env snapshot + console
    });

    test('a retried batch keeps its place in the timeline', () async {
      final transport = FakeTransport(
        failure: (count) => CrumbtrailUnreachable(count),
      );
      final logger = buildLogger(transport: transport);
      logger.addEvent(CrumbtrailEventKind.console, {'seq': 1});

      await logger.flush(); // fails, requeues at the front
      logger.addEvent(CrumbtrailEventKind.console, {'seq': 2});
      await logger.flush();

      final sequence = transport.allEvents
          .where((event) => event.kind == 'con')
          .map((event) => event.data['seq'])
          .toList();
      // Re-appending at the back would put the retried batch after events that
      // happened later, inventing causality that never occurred.
      expect(sequence, [1, 2]);
    });

    test('flushing an empty queue does not call the transport', () async {
      final transport = FakeTransport();
      final logger = buildLogger(transport: transport);
      await logger.flush();
      transport.batches.clear();
      await logger.flush();
      expect(transport.batches, isEmpty);
    });

    test('stop flushes, ends the session, and stops recording', () async {
      final transport = FakeTransport();
      final logger = buildLogger(transport: transport);
      logger.addEvent(CrumbtrailEventKind.console, {'lv': 'log'});
      await logger.stop();

      expect(transport.ended, [logger.sessionId]);
      expect(transport.allEvents, hasLength(2));

      logger.addEvent(CrumbtrailEventKind.console, {'lv': 'after'});
      await logger.flush();
      expect(transport.allEvents, hasLength(2));
    });

    test('session start announces the service name', () async {
      final transport = FakeTransport();
      buildLogger(
        transport: transport,
        config: const CrumbtrailConfig(
          endpoint: _endpoint,
          service: 'checkout-app',
          flushBatchSize: 1000,
        ),
      );
      // One ingest key covers a whole project, so without this every app in it
      // arrives as an anonymous sender.
      await Future<void>.delayed(Duration.zero);
      expect(transport.startMetadata?['service'], 'checkout-app');
      expect(transport.startMetadata?['platform'], 'flutter');
    });

    test('reaching the batch size flushes without waiting for the timer',
        () async {
      final transport = FakeTransport();
      final logger = buildLogger(
        transport: transport,
        config: const CrumbtrailConfig(
          endpoint: _endpoint,
          flushBatchSize: 3,
        ),
      );
      logger.addEvent(CrumbtrailEventKind.console, {'n': 1});
      logger.addEvent(CrumbtrailEventKind.console, {'n': 2});
      await Future<void>.delayed(Duration.zero);
      expect(transport.allEvents, hasLength(3)); // env + 2
    });
  });

  group('queue bounds', () {
    test('the oldest events are dropped and counted', () {
      final queue = CrumbtrailEventQueue(capacity: 3);
      for (var index = 0; index < 5; index++) {
        queue.append(CrumbtrailEvent.of(
          timestamp: index,
          kind: CrumbtrailEventKind.console,
          data: {'n': index},
          sdk: crumbtrailSdk,
        ));
      }
      expect(queue.length, 3);
      expect(queue.dropped, 2);
      // The most recent window is the one the bug is in.
      expect(queue.drain().map((event) => event.data['n']), [2, 3, 4]);
    });

    test('a requeue larger than the queue keeps the newest of the batch', () {
      final queue = CrumbtrailEventQueue(capacity: 2);
      queue.requeue([
        for (var index = 0; index < 4; index++)
          CrumbtrailEvent.of(
            timestamp: index,
            kind: CrumbtrailEventKind.console,
            data: {'n': index},
            sdk: crumbtrailSdk,
          ),
      ]);
      expect(queue.drain().map((event) => event.data['n']), [2, 3]);
      expect(queue.dropped, 2);
    });

    test('capacity below one is clamped rather than dividing by zero', () {
      final queue = CrumbtrailEventQueue(capacity: 0);
      queue.append(CrumbtrailEvent.of(
        timestamp: 1,
        kind: CrumbtrailEventKind.console,
        data: const {},
        sdk: crumbtrailSdk,
      ));
      expect(queue.length, 1);
    });

    test('drain empties the queue', () {
      final queue = CrumbtrailEventQueue(capacity: 10);
      queue.append(CrumbtrailEvent.of(
        timestamp: 1,
        kind: CrumbtrailEventKind.console,
        data: const {},
        sdk: crumbtrailSdk,
      ));
      expect(queue.drain(), hasLength(1));
      expect(queue.drain(), isEmpty);
    });
  });

  group('redaction', () {
    test('credential-shaped header values go, names stay', () {
      final redacted = CrumbtrailRedaction.redactHeaders({
        'Authorization': 'Bearer abc.def.ghi',
        'X-API_Key': 'sk-live-1234',
        'x-csrf-token': 'nonce',
        'Cookie': 'sid=1',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      });
      // "The request carried an Authorization header" is diagnostic and
      // harmless; only the value is dangerous.
      expect(redacted['Authorization'], '[REDACTED]');
      expect(redacted['X-API_Key'], '[REDACTED]');
      expect(redacted['x-csrf-token'], '[REDACTED]');
      expect(redacted['Cookie'], '[REDACTED]');
      expect(redacted['Content-Type'], 'application/json');
      expect(redacted['Accept'], 'application/json');
    });

    test('spelling variants cannot slip a credential through', () {
      for (final name in [
        'x-api-key',
        'X_API_KEY',
        'xApiKey',
        'X.Api.Key',
        'AUTHORIZATION',
      ]) {
        expect(
          CrumbtrailRedaction.isDeniedHeader(name),
          isTrue,
          reason: '$name should be denied',
        );
      }
      expect(CrumbtrailRedaction.isDeniedHeader('accept-language'), isFalse);
    });

    test('userinfo and fragment never leave the device', () {
      final url = CrumbtrailRedaction.redactUrl(
        'https://user:hunter2@api.example.com/v1/orders#access_token=abc',
      );
      expect(url, isNot(contains('hunter2')));
      expect(url, isNot(contains('user')));
      // The fragment is where apps park an access token after an OAuth redirect.
      expect(url, isNot(contains('access_token')));
      expect(url, 'https://api.example.com/v1/orders');
    });

    test('credential-shaped query values are dropped, ordinary ones kept', () {
      final url = CrumbtrailRedaction.redactUrl(
        'https://api.example.com/search?q=shoes&api_key=sk-live&page=2',
      );
      expect(url, contains('q=shoes'));
      expect(url, contains('page=2'));
      expect(url, isNot(contains('sk-live')));
      // Literally, not percent encoded. Ingest matches on the marker string, so
      // a `%5BREDACTED%5D` here reads as an ordinary value on the other side.
      expect(url, contains('[REDACTED]'));
      expect(url, 'https://api.example.com/search?q=shoes&api_key=[REDACTED]&page=2');
    });

    test('a non-URL keeps only its path, never its query', () {
      // Uri.parse is lenient, so "did it parse" is not a safety check: a
      // schemeless string could otherwise carry a token straight through.
      expect(
        CrumbtrailRedaction.redactUrl('not a url?token=secret'),
        isNot(contains('secret')),
      );
      expect(CrumbtrailRedaction.redactUrl(''), '[REDACTED]');
    });

    test('the port is preserved', () {
      expect(
        CrumbtrailRedaction.redactUrl('http://localhost:8080/api/health'),
        'http://localhost:8080/api/health',
      );
    });

    test('recorded requests are redacted before they are queued', () async {
      final transport = FakeTransport();
      final logger = buildLogger(transport: transport);
      logger.recordRequest(
        url: 'https://api.example.com/v1/orders?token=sk-live-1234',
        method: 'post',
        status: 402,
        durationMs: 318,
      );
      await logger.flush();

      final event =
          transport.allEvents.firstWhere((event) => event.kind == 'net');
      expect(event.data['url'], isNot(contains('sk-live-1234')));
      expect(event.data['method'], 'POST');
      expect(event.data['ok'], isFalse);
      expect(event.data['dur'], 318);
    });

    test('a 2xx status records ok', () async {
      final transport = FakeTransport();
      final logger = buildLogger(transport: transport);
      logger.recordRequest(
        url: 'https://api.example.com/v1/orders',
        method: 'GET',
        status: 204,
        durationMs: 12,
      );
      await logger.flush();
      final event =
          transport.allEvents.firstWhere((event) => event.kind == 'net');
      expect(event.data['ok'], isTrue);
    });
  });

  group('recording', () {
    test('a caught error is not marked fatal', () async {
      final transport = FakeTransport();
      final logger = buildLogger(transport: transport);
      logger.recordError(StateError('boom'), StackTrace.current);
      await logger.flush();
      final event =
          transport.allEvents.firstWhere((event) => event.kind == 'err');
      // The app survived. Marking it fatal would inflate every crash metric.
      expect(event.data['fatal'], isFalse);
      expect(event.data['msg'], contains('boom'));
    });

    test('an environment snapshot is emitted at startup', () async {
      final transport = FakeTransport();
      final logger = buildLogger(transport: transport);
      await logger.flush();
      final event =
          transport.allEvents.firstWhere((event) => event.kind == 'env');
      expect(event.data['kind'], 'snapshot');
    });

    test('the environment collector can be turned off', () async {
      final transport = FakeTransport();
      final logger = buildLogger(
        transport: transport,
        config: const CrumbtrailConfig(
          endpoint: _endpoint,
          flushBatchSize: 1000,
          collectors: CrumbtrailCollectors(environment: false),
        ),
      );
      await logger.flush();
      expect(transport.allEvents, isEmpty);
    });

    test('describePlatform collects nothing that identifies a person', () {
      final described = Crumbtrail.describePlatform();
      expect(described.keys, isNot(contains('deviceId')));
      expect(described.keys, isNot(contains('advertisingId')));
      expect(described['os'], isNotNull);
    });
  });

  group('transport wiring', () {
    test('a trailing slash does not produce a double-slashed path', () async {
      final calls = <String>[];
      final transport = CrumbtrailHttpTransport(
        endpoint: 'https://ingest.example.com/',
        ingestKey: 'ctkey_test',
        client: _RecordingClient(calls),
      );
      await transport.sendEvents('ses_1', [
        CrumbtrailEvent.of(
          timestamp: 1,
          kind: CrumbtrailEventKind.console,
          data: const {},
          sdk: crumbtrailSdk,
        ),
      ]);
      // Some gateways route `//api/events` as a distinct, unrouted path.
      expect(calls.single, 'https://ingest.example.com/api/events');
    });

    test('a non-2xx response is a refusal, not a delivery', () async {
      final transport = CrumbtrailHttpTransport(
        endpoint: _endpoint,
        client: _StatusClient(429),
      );
      await expectLater(
        transport.sendEvents('ses_1', [
          CrumbtrailEvent.of(
            timestamp: 1,
            kind: CrumbtrailEventKind.console,
            data: const {},
            sdk: crumbtrailSdk,
          ),
        ]),
        throwsA(isA<CrumbtrailRefused>()),
      );
    });

    test('a thrown client is unreachable, which is retryable', () async {
      final transport = CrumbtrailHttpTransport(
        endpoint: _endpoint,
        client: _ThrowingClient(),
      );
      await expectLater(
        transport.sendEvents('ses_1', [
          CrumbtrailEvent.of(
            timestamp: 1,
            kind: CrumbtrailEventKind.console,
            data: const {},
            sdk: crumbtrailSdk,
          ),
        ]),
        throwsA(isA<CrumbtrailUnreachable>()),
      );
    });

    test('session start and end failures never surface to the host app', () async {
      final transport = CrumbtrailHttpTransport(
        endpoint: _endpoint,
        client: _ThrowingClient(),
      );
      // Capture that cannot announce itself still captures; ingest creates the
      // session lazily from the first batch.
      await transport.startSession('ses_1', const {});
      await transport.endSession('ses_1');
    });

    test('the ingest key is sent as a header, an empty one is omitted',
        () async {
      final withKey = <Map<String, String>>[];
      await CrumbtrailHttpTransport(
        endpoint: _endpoint,
        ingestKey: 'ctkey_abc',
        client: _HeaderClient(withKey),
      ).endSession('ses_1');
      expect(withKey.single['X-Crumbtrail-Auth'], 'ctkey_abc');

      final withoutKey = <Map<String, String>>[];
      await CrumbtrailHttpTransport(
        endpoint: _endpoint,
        ingestKey: '',
        client: _HeaderClient(withoutKey),
      ).endSession('ses_1');
      // An empty value reads to the server as a malformed credential rather
      // than as none at all.
      expect(withoutKey.single.containsKey('X-Crumbtrail-Auth'), isFalse);
    });

    test('an empty batch is not posted', () async {
      final calls = <String>[];
      await CrumbtrailHttpTransport(
        endpoint: _endpoint,
        client: _RecordingClient(calls),
      ).sendEvents('ses_1', const []);
      expect(calls, isEmpty);
    });
  });
}

class _RecordingClient implements CrumbtrailHttpClient {
  _RecordingClient(this.calls);
  final List<String> calls;

  @override
  Future<int> post(String url, Map<String, String> headers, String body) async {
    calls.add(url);
    return 200;
  }
}

class _HeaderClient implements CrumbtrailHttpClient {
  _HeaderClient(this.seen);
  final List<Map<String, String>> seen;

  @override
  Future<int> post(String url, Map<String, String> headers, String body) async {
    seen.add(headers);
    return 200;
  }
}

class _StatusClient implements CrumbtrailHttpClient {
  _StatusClient(this.status);
  final int status;

  @override
  Future<int> post(String url, Map<String, String> headers, String body) async =>
      status;
}

class _ThrowingClient implements CrumbtrailHttpClient {
  @override
  Future<int> post(String url, Map<String, String> headers, String body) async {
    throw const SocketExceptionStub();
  }
}

class SocketExceptionStub implements Exception {
  const SocketExceptionStub();
}
