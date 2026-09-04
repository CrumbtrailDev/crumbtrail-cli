import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'behavior_test.dart' show FakeTransport, buildLogger;

class StreamingClient extends http.BaseClient {
  final stream = StreamController<List<int>>();
  bool closed = false;
  Object? failure;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (failure != null) throw failure!;
    expect(await request.finalize().bytesToString(), 'original request');
    return http.StreamedResponse(stream.stream, 202, headers: {'x-original': 'yes'});
  }
  @override
  void close() { closed = true; }
}

void main() {
  test('http preserves streaming response and records redacted metadata', () async {
    final transport = FakeTransport();
    final logger = buildLogger(transport: transport);
    final inner = StreamingClient();
    final client = CrumbtrailClient(crumbtrail: logger, inner: inner);
    final response = await client.send(http.Request('POST', Uri.parse('https://example.com/api?token=secret'))..body = 'original request');
    expect(response.headers['x-original'], 'yes');
    await logger.flush();
    final event = transport.allEvents.where((e) => e.kind == 'network').single;
    expect(event.data['status'], 202);
    expect(jsonEncode(event.data), isNot(contains('secret')));
    inner.stream.add(utf8.encode('original response'));
    unawaited(inner.stream.close());
    expect(await response.stream.bytesToString(), 'original response');
    client.close();
    expect(inner.closed, isTrue);
    await logger.stop();
  });

  test('http preserves original exception without capturing its secrets', () async {
    final transport = FakeTransport();
    final logger = buildLogger(transport: transport);
    final error = http.ClientException('token=secret');
    final inner = StreamingClient()..failure = error;
    final client = CrumbtrailClient(crumbtrail: logger, inner: inner);
    await expectLater(client.get(Uri.parse('https://example.com')), throwsA(same(error)));
    await logger.flush();
    final event = transport.allEvents.where((e) => e.kind == 'network').single;
    expect(event.data['status'], isNull);
    expect(jsonEncode(event.data), isNot(contains('secret')));
    await inner.stream.close();
    await logger.stop();
  });

  test('Dio real HTTP preserves success and rejected status', () async {
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
      final response = await dio.post('$base/ok?token=secret', data: 'original request');
      expect(response.data, 'original response');
      await expectLater(dio.get('$base/error'), throwsA(isA<DioException>().having((e) => e.response?.statusCode, 'status', 503)));
      await logger.flush();
      final events = transport.allEvents.where((e) => e.kind == 'network').toList();
      expect(events.map((e) => e.data['status']), [201, 503]);
      expect(jsonEncode(events.map((e) => e.data).toList()), isNot(contains('secret')));
      expect(requests.first, 'original request');
    } finally {
      dio.close(force: true);
      await logger.stop();
      await server.close(force: true);
    }
  });
}
