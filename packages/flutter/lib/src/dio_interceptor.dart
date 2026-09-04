import 'package:dio/dio.dart';
import 'crumbtrail.dart';

/// Register once per Dio instance. Request and response bodies are untouched.
class CrumbtrailDioInterceptor extends Interceptor {
  CrumbtrailDioInterceptor(this.crumbtrail);
  final Crumbtrail crumbtrail;
  final Expando<Stopwatch> _pending = Expando<Stopwatch>();

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    if (crumbtrail.config.collectors.network) {
      _pending[options] = Stopwatch()..start();
    }
    handler.next(options);
  }

  void _record(RequestOptions options, int? status, [String? error]) {
    final clock = _pending[options];
    _pending[options] = null;
    if (clock == null) return;
    try {
      crumbtrail.recordRequest(
        url: options.uri.toString(),
        method: options.method,
        status: status,
        durationMs: clock.elapsedMilliseconds,
        source: 'dio',
        error: error,
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
