import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

/// Register once per Dio instance. Request and response bodies are untouched.
class CrumbtrailDioInterceptor extends Interceptor {
  CrumbtrailDioInterceptor(this.crumbtrail);
  final Crumbtrail crumbtrail;
  final Expando<Stopwatch> _pending = Expando<Stopwatch>();

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    // Includes the ingest host check: an application that hands Crumbtrail a
    // Dio backed transport would otherwise record Crumbtrail's own delivery,
    // and each recorded delivery would trigger the next.
    if (crumbtrail.capturesRequestTo(options.uri)) {
      _pending[options] = Stopwatch()..start();
    }
    handler.next(options);
  }

  void _record(RequestOptions options, int? status, [String? error]) {
    final clock = _pending[options];
    _pending[options] = null;
    if (clock == null) {
      if (crumbtrail.capturesRequestTo(options.uri)) {
        // The response carries a different RequestOptions instance from the one
        // onRequest saw, so the Expando lookup misses and the request goes
        // unrecorded. A retry interceptor cloning RequestOptions is the usual
        // cause. Said out loud rather than returning silently, because the
        // symptom otherwise is a session that is simply missing requests.
        // Redacted, because this line lands in the application's own log and a
        // path segment is exactly where a reset token lives.
        debugPrint(
          'crumbtrail: no start time for ${options.method} '
          '${CrumbtrailRedaction.redactUrl(options.uri.toString())}; the '
          'request options were replaced after onRequest, so this request is '
          'not recorded',
        );
      }
      return;
    }
    try {
      crumbtrail.recordRequest(
        url: options.uri.toString(),
        method: options.method,
        status: status,
        durationMs: clock.elapsedMilliseconds,
        source: 'dio',
        error: error,
        // Dio's response interceptor runs after the body has been buffered and
        // decoded, so this covers more than the OkHttp and package:http
        // adapters report. Stated in the event rather than left for a reader to
        // infer from `source`.
        durTo: 'body',
      );
    } catch (_) {
      // Capture failures must not change the application's HTTP result.
    }
  }

  @override
  void onResponse(Response response, ResponseInterceptorHandler handler) {
    _record(response.requestOptions, response.statusCode);
    handler.next(response);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    _record(err.requestOptions, err.response?.statusCode, err.type.name);
    handler.next(err);
  }
}
