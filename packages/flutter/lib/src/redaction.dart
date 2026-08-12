/// Deny-biased redaction, applied before anything leaves the device.
///
/// Same rules as the Swift and Kotlin SDKs, held to the same fixtures: capture
/// must never be the reason a secret leaves the device. Deny-biased on purpose —
/// a header or query key that *might* be a credential is dropped. Keeping the
/// shape while dropping the value preserves what an agent can act on and
/// discards what it could not use anyway.
class CrumbtrailRedaction {
  const CrumbtrailRedaction._();

  static const String placeholder = '[REDACTED]';

  static const Set<String> _deniedHeaderNames = {
    'authorization',
    'cookie',
    'setcookie',
    'proxyauthorization',
    'wwwauthenticate',
    'xapikey',
    'xauthtoken',
    'xcsrftoken',
  };

  static const List<String> _deniedNameTokens = [
    'token',
    'secret',
    'key',
    'password',
    'passwd',
    'auth',
    'credential',
    'session',
    'signature',
    'bearer',
  ];

  /// Lowercase and strip non-alphanumerics, so `X-API_Key`, `x-api-key` and
  /// `xApiKey` compact to one token and cannot slip through on spelling.
  static String compact(String name) => name
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]'), '');

  static bool isDeniedHeader(String name) {
    final compacted = compact(name);
    return _deniedHeaderNames.contains(compacted) ||
        _deniedNameTokens.any(compacted.contains);
  }

  /// Redact header values, keeping the names.
  ///
  /// "The request carried an Authorization header" is diagnostic and harmless.
  /// Only the value is dangerous.
  static Map<String, String> redactHeaders(Map<String, String> headers) {
    return headers.map(
      (name, value) =>
          MapEntry(name, isDeniedHeader(name) ? placeholder : value),
    );
  }

  /// Strip credentials and credential-shaped query values from a URL.
  ///
  /// Removes userinfo (`https://user:pass@host`), the fragment — where apps park
  /// access tokens after an OAuth redirect — and any query value whose key looks
  /// like a credential.
  ///
  /// Anything without a scheme and host keeps only its path. `Uri.parse` is
  /// lenient, so "did it parse" is not a safety check; the query-key heuristic
  /// is only trustworthy on something genuinely URL-shaped, and everything else
  /// has its query dropped wholesale rather than scanned.
  static String redactUrl(String raw) {
    if (raw.isEmpty) return placeholder;

    final Uri uri;
    try {
      uri = Uri.parse(raw);
    } on FormatException {
      return placeholder;
    }

    if (!uri.hasScheme || uri.host.isEmpty) {
      return uri.path.isEmpty ? placeholder : uri.path;
    }

    final query = uri.hasQuery
        ? uri.queryParameters.map(
            (name, value) => MapEntry(
              name,
              _deniedNameTokens.any(compact(name).contains)
                  ? placeholder
                  : value,
            ),
          )
        : null;

    return Uri(
      scheme: uri.scheme,
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
      path: uri.path,
      queryParameters: (query != null && query.isNotEmpty) ? query : null,
      // Fragment deliberately never carried over.
    ).toString();
  }
}
