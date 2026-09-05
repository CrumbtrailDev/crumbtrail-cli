import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:http/http.dart' as http;

/// Records time to response headers without reading either body.
/// Closing this wrapper closes [inner]. Register one wrapper per client.
class CrumbtrailClient extends http.BaseClient {
  CrumbtrailClient({required this.crumbtrail, required this.inner});
  final Crumbtrail crumbtrail;
  final http.Client inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    // Includes the ingest host check: a wrapper placed around the client
    // Crumbtrail's own transport uses would otherwise record its own delivery.
    if (!crumbtrail.capturesRequestTo(request.url)) return inner.send(request);
    final clock = Stopwatch()..start();
    void record(int? status, [String? error]) {
      try {
        crumbtrail.recordRequest(
          url: request.url.toString(),
          method: request.method,
          status: status,
          durationMs: clock.elapsedMilliseconds,
          source: 'http',
          error: error,
          // `send` returns as soon as the response head is available, so this
          // number never contains body download or decoding.
          durTo: 'headers',
        );
      } catch (_) {
        // Capture failures must not change the application's HTTP result.
      }
    }

    final http.StreamedResponse response;
    try {
      response = await inner.send(request);
    } catch (error) {
      record(null, error.runtimeType.toString());
      rethrow;
    }
    record(response.statusCode);
    return response;
  }

  @override
  void close() => inner.close();
}
