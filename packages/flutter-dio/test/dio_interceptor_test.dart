import 'dart:convert';
import 'dart:io';

import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:crumbtrail_flutter_dio/crumbtrail_flutter_dio.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

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
    deviceInfo: const {'os': 'test'},
    // A periodic timer in a unit test is a source of flake, not coverage.
    startTimer: false,
  );
}

Interceptor _resolveWith(int status, Object body) =>
    InterceptorsWrapper(onRequest: (options, handler) {
      // `true` so the earlier interceptors' onResponse still runs; without it
      // Dio short circuits past the adapter under test.
      handler.resolve(
          Response(requestOptions: options, statusCode: status, data: body),
          true);
    });

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
    final dio = Dio()
      ..interceptors.add(CrumbtrailDioInterceptor(logger))
      ..interceptors.add(_resolveWith(200, 'ok'));
    expect((await dio.get('https://example.com')).data, 'ok');
    await logger.flush();
    expect(transport.netEvents, isEmpty);
    dio.close();
    await logger.stop();
  });

  test('cancellation remains cancellation and captures no message', () async {
    final transport = FakeTransport();
    final logger = buildLogger(transport: transport);
    final dio = Dio()
      ..interceptors.add(CrumbtrailDioInterceptor(logger))
      ..interceptors.add(InterceptorsWrapper(onRequest: (options, handler) {
        handler.reject(DioException(
            requestOptions: options,
            type: DioExceptionType.cancel,
            error: 'token=secret'));
      }));
    await expectLater(
        dio.get('https://example.com'),
        throwsA(isA<DioException>()
            .having((e) => e.type, 'type', DioExceptionType.cancel)));
    await logger.flush();
    final event = transport.netEvents.single;
    expect(event.data['error'], 'cancel');
    expect(jsonEncode(event.data), isNot(contains('secret')));
    dio.close();
    await logger.stop();
  });

  test('real HTTP preserves success and rejected status', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final requests = <String>[];
    server.listen((request) async {
      requests.add(await utf8.decoder.bind(request).join());
      request.response.statusCode = request.uri.path == '/error' ? 503 : 201;
      request.response.write('original response');
      await request.response.close();
    });
    final transport = FakeTransport();
    final logger = buildLogger(transport: transport);
    final dio = Dio()..interceptors.add(CrumbtrailDioInterceptor(logger));
    final base = 'http://127.0.0.1:${server.port}';
    try {
      final response =
          await dio.post('$base/ok?token=secret', data: 'original request');
      expect(response.data, 'original response');
      await expectLater(
          dio.get('$base/error'),
          throwsA(isA<DioException>()
              .having((e) => e.response?.statusCode, 'status', 503)));
      await logger.flush();
      final events = transport.netEvents;
      expect(events.map((e) => e.data['status']), [201, 503]);
      // Dio's response interceptor runs after the body is buffered, so this
      // adapter says so rather than letting `dur` be read as time to headers.
      expect(events.map((e) => e.data['durTo']), ['body', 'body']);
      expect(events.first.data['url'],
          'http://127.0.0.1:${server.port}/ok?token=[REDACTED]');
      expect(jsonEncode(events.map((e) => e.data).toList()),
          isNot(contains('secret')));
      expect(requests.first, 'original request');
    } finally {
      dio.close(force: true);
      await logger.stop();
      await server.close(force: true);
    }
  });

  test('requests to the ingest host are not captured', () async {
    // A host that hands Crumbtrail a Dio backed transport, to share its
    // certificate pinning, would otherwise get event to flush to POST to
    // intercepted to event, amplifying because a flush fires on batch size.
    final transport = FakeTransport();
    final logger = buildLogger(transport: transport);
    final dio = Dio()
      ..interceptors.add(CrumbtrailDioInterceptor(logger))
      ..interceptors.add(_resolveWith(200, 'ok'));
    expect((await dio.post('$_endpoint/v1/events', data: '{}')).data, 'ok');
    expect((await dio.get('https://example.com/api')).data, 'ok');
    await logger.flush();
    expect(transport.netEvents.map((e) => e.data['url']),
        ['https://example.com/api']);
    dio.close();
    await logger.stop();
  });

  test('a replaced RequestOptions is reported, not silently dropped', () async {
    // A retry interceptor that clones RequestOptions breaks the Expando lookup,
    // so the request goes unrecorded. The session then looks like one where the
    // request never happened, which is the same shape as a real capture gap.
    final transport = FakeTransport();
    final logger = buildLogger(transport: transport);
    final interceptor = CrumbtrailDioInterceptor(logger);
    final dio = Dio()
      ..interceptors.add(interceptor)
      ..interceptors.add(InterceptorsWrapper(onRequest: (options, handler) {
        handler.resolve(
            Response(
              requestOptions: options.copyWith(path: options.path),
              statusCode: 200,
              data: 'ok',
            ),
            true);
      }));
    final messages = <String>[];
    final previous = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) {
      if (message != null) messages.add(message);
    };
    try {
      expect((await dio.get('https://example.com/api')).data, 'ok');
    } finally {
      debugPrint = previous;
    }
    await logger.flush();
    expect(transport.netEvents, isEmpty);
    expect(messages.single, contains('not recorded'));
    dio.close();
    await logger.stop();
  });
}
