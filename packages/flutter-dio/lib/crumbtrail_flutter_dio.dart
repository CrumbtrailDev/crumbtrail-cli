/// Dio capture adapter for Crumbtrail.
///
/// Separate from `crumbtrail_flutter` because Dart has no compile-only
/// dependency: anything the SDK declares, every consumer resolves. Installing
/// capture must never be the reason an application's own HTTP client fails to
/// resolve.
library;

export 'src/dio_interceptor.dart';
