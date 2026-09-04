/// Flutter SDK for Crumbtrail session capture.
///
/// Speaks the shared ingest contract documented in
/// `docs/specs/native-sdk-wire-contract.md` and verified against the fixtures in
/// `test-fixtures/wire-contract/`, the same ones the Swift and Kotlin SDKs use.
library;

export 'src/crumbtrail.dart';
export 'src/event.dart';
export 'src/navigator_observer.dart';
export 'src/native_diagnostics.dart';
export 'src/redaction.dart';
export 'src/session.dart';
export 'src/transport.dart';

export 'src/http_client.dart';
export 'src/dio_interceptor.dart';
