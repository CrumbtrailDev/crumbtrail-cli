import 'dart:io';

import 'event.dart';

/// Why a batch did not arrive.
sealed class CrumbtrailDeliveryException implements Exception {
  const CrumbtrailDeliveryException(this.eventCount);
  final int eventCount;
}

/// No response at all. Worth retrying.
class CrumbtrailUnreachable extends CrumbtrailDeliveryException {
  const CrumbtrailUnreachable(super.eventCount);

  @override
  String toString() => 'capture endpoint unreachable for $eventCount event(s)';
}

/// The server answered and refused. Retrying the identical batch would be
/// refused identically, so the caller declares a capture gap instead.
class CrumbtrailRefused extends CrumbtrailDeliveryException {
  const CrumbtrailRefused(this.status, super.eventCount);
  final int status;

  @override
  String toString() =>
      'capture endpoint rejected $eventCount event(s) with $status';
}

/// Where captured events go.
abstract class CrumbtrailTransport {
  Future<void> startSession(String id, Map<String, Object?> metadata);
  Future<void> sendEvents(String sessionId, List<CrumbtrailEvent> events);
  Future<void> endSession(String id);
}

/// Minimal seam over HTTP, so tests can assert exact bytes without a server.
abstract class CrumbtrailHttpClient {
  /// Returns the HTTP status. Throws when there was no response at all.
  Future<int> post(String url, Map<String, String> headers, String body);
}

/// `dart:io` HttpClient rather than package:http.
///
/// package:http is the nicer API and is also already in most Flutter apps at
/// some specific version. A telemetry SDK that pinned its own would force a
/// version conflict on the host for no benefit the host asked for. `dart:io` is
/// in the SDK, ships nothing, and posting a JSON batch needs nothing more.
class DefaultHttpClient implements CrumbtrailHttpClient {
  DefaultHttpClient({Duration? timeout})
      : _timeout = timeout ?? const Duration(seconds: 15);

  final Duration _timeout;

  @override
  Future<int> post(
    String url,
    Map<String, String> headers,
    String body,
  ) async {
    final client = HttpClient()..connectionTimeout = _timeout;
    try {
      final request = await client.postUrl(Uri.parse(url));
      headers.forEach(request.headers.set);
      request.write(body);
      final response = await request.close().timeout(_timeout);
      await response.drain<void>();
      return response.statusCode;
    } finally {
      client.close(force: true);
    }
  }
}

/// HTTP transport implementing `docs/specs/native-sdk-wire-contract.md`.
class CrumbtrailHttpTransport implements CrumbtrailTransport {
  CrumbtrailHttpTransport({
    required String endpoint,
    String? ingestKey,
    CrumbtrailHttpClient? client,
  })  :
        // Trailing slashes would produce `//api/events`, which some gateways
        // treat as a distinct, unrouted path.
        _endpoint = endpoint.replaceAll(RegExp(r'/+$'), ''),
        // An empty token is not a token: sending the header with an empty value
        // reads to the server as a malformed credential rather than as none.
        _ingestKey = (ingestKey == null || ingestKey.isEmpty) ? null : ingestKey,
        _client = client ?? DefaultHttpClient();

  final String _endpoint;
  final String? _ingestKey;
  final CrumbtrailHttpClient _client;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_ingestKey != null) 'X-Crumbtrail-Auth': _ingestKey,
      };

  @override
  Future<void> startSession(String id, Map<String, Object?> metadata) async {
    // Best effort: a session that fails to announce itself still captures, and
    // ingest creates it lazily from the first batch.
    try {
      await _client.post(
        '$_endpoint/api/session/start',
        _headers,
        canonicalJsonEncode({'sessionId': id, 'metadata': metadata}),
      );
    } on Object {
      // Intentionally swallowed.
    }
  }

  @override
  Future<void> sendEvents(
    String sessionId,
    List<CrumbtrailEvent> events,
  ) async {
    if (events.isEmpty) return;
    final body = canonicalJsonEncode({
      'sessionId': sessionId,
      'events': events.map((event) => event.toJson()).toList(),
    });

    final int status;
    try {
      status = await _client.post('$_endpoint/api/events', _headers, body);
    } on Object {
      throw CrumbtrailUnreachable(events.length);
    }

    // The whole reason this throws. A 413 or 429 is a perfectly normal
    // response, so an SDK that only catches exceptions counts a refusal as a
    // delivery, drops the batch, and reports a session indistinguishable from
    // one where nothing happened.
    if (status < 200 || status >= 300) {
      throw CrumbtrailRefused(status, events.length);
    }
  }

  @override
  Future<void> endSession(String id) async {
    try {
      await _client.post(
        '$_endpoint/api/session/end',
        _headers,
        canonicalJsonEncode({'sessionId': id}),
      );
    } on Object {
      // Intentionally swallowed.
    }
  }
}
