import 'dart:async';
import 'dart:convert';

import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:crumbtrail_flutter_http/crumbtrail_flutter_http.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

const _endpoint = 'https://ingest.example.com';

class FakeTransport implements CrumbtrailTransport {
  final List<List<CrumbtrailEvent>> batches = [];

  List<CrumbtrailEvent> get allEvents =>
      batches.expand((batch) => batch).toList();

  List<CrumbtrailEvent> get netEvents =>
      allEvents.where((event) => event.kind == 'net').toList();

  @override
  Future<void> startSession(String id, Map<String, Object?> metadata) async {}

  @override
  Future<void> sendEvents(String sessionId, List<CrumbtrailEvent> events) async {
    batches.add(events);
  }

  @override
  Future<void> endSession(String id) async {}
}

Crumbtrail buildLogger({
  CrumbtrailTransport? transport,
  CrumbtrailSessionStore? store,
  CrumbtrailConfig? config,
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
  );
}

class StreamingClient extends http.BaseClient {
  final stream = StreamController<List<int>>();
  final List<Uri> sent = [];
  bool closed = false;
  Object? failure;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    sent.add(request.url);
    if (failure != null) throw failure!;
    return http.StreamedResponse(stream.stream, 202,
        headers: {'x-original': 'yes'});
  }

  @override
  void close() {
    closed = true;
  }
}

class FailingStore extends MemorySessionStore {
  bool fail = false;

  @override
  void write(PersistedSession session) {
    if (fail) throw StateError('store unavailable');
    super.write(session);
  }
}

void main() {
  test('a disabled collector leaves the call usable and records nothing',
      () async {
    final transport = FakeTransport();
    final logger = buildLogger(
      transport: transport,
      config: const CrumbtrailConfig(
        endpoint: _endpoint,
        collectors: CrumbtrailCollectors(network: false),
      ),
    );
    final inner = StreamingClient();
    final client = CrumbtrailClient(crumbtrail: logger, inner: inner);
    final response = await client
        .send(http.Request('POST', Uri.parse('https://example.com')));
    inner.stream.add([1, 2, 3]);
    unawaited(inner.stream.close());
    expect(await response.stream.toBytes(), [1, 2, 3]);
    await logger.flush();
    expect(transport.netEvents, isEmpty);
    client.close();
    await logger.stop();
  });

  test('a capture store failure cannot replace an HTTP response', () async {
    final store = FailingStore();
    final logger = buildLogger(store: store);
    store.fail = true;
    final inner = StreamingClient();
    final client = CrumbtrailClient(crumbtrail: logger, inner: inner);
    final response = await client.send(
        http.Request('POST', Uri.parse('https://example.com'))
          ..body = 'original request');
    expect(response.statusCode, 202);
    inner.stream.add([1]);
    unawaited(inner.stream.close());
    expect(await response.stream.toBytes(), [1]);
    client.close();
    store.fail = false;
    await logger.stop();
  });

  test('streaming response survives and the metadata is redacted', () async {
    final transport = FakeTransport();
    final logger = buildLogger(transport: transport);
    final inner = StreamingClient();
    final client = CrumbtrailClient(crumbtrail: logger, inner: inner);
    final response = await client.send(
        http.Request('POST', Uri.parse('https://example.com/api?token=secret'))
          ..body = 'original request');
    expect(response.headers['x-original'], 'yes');
    await logger.flush();
    final event = transport.netEvents.single;
    expect(event.data['status'], 202);
    expect(event.data['durTo'], 'headers');
    expect(event.data['url'], 'https://example.com/api?token=[REDACTED]');
    expect(jsonEncode(event.data), isNot(contains('secret')));
    inner.stream.add(utf8.encode('original response'));
    unawaited(inner.stream.close());
    expect(await response.stream.bytesToString(), 'original response');
    client.close();
    expect(inner.closed, isTrue);
    await logger.stop();
  });

  test('the original exception is preserved and its secrets are not captured',
      () async {
    final transport = FakeTransport();
    final logger = buildLogger(transport: transport);
    final error = http.ClientException('token=secret');
    final inner = StreamingClient()..failure = error;
    final client = CrumbtrailClient(crumbtrail: logger, inner: inner);
    await expectLater(
        client.get(Uri.parse('https://example.com')), throwsA(same(error)));
    await logger.flush();
    final event = transport.netEvents.single;
    expect(event.data['status'], isNull);
    expect(jsonEncode(event.data), isNot(contains('secret')));
    unawaited(inner.stream.close());
    await logger.stop();
  });

  test('requests to the ingest host are not captured', () async {
    // A host that wraps the client Crumbtrail's own transport uses, to share
    // its certificate pinning, would otherwise get event to flush to POST to
    // intercepted to event, amplifying because a flush fires on batch size.
    final transport = FakeTransport();
    final logger = buildLogger(transport: transport);
    final inner = StreamingClient();
    final client = CrumbtrailClient(crumbtrail: logger, inner: inner);
    final ingest =
        await client.send(http.Request('POST', Uri.parse('$_endpoint/v1/events')));
    inner.stream.add([1]);
    unawaited(inner.stream.close());
    expect(await ingest.stream.toBytes(), [1]);
    await logger.flush();
    expect(transport.netEvents, isEmpty);
    expect(inner.sent.single.host, 'ingest.example.com');
    client.close();
    await logger.stop();
  });
}
