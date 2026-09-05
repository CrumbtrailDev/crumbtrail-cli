/// Deny-biased redaction, applied before anything leaves the device.
///
/// Same rules as the Swift and Kotlin SDKs, and held to the same fixtures:
/// `test-fixtures/redaction/urls.json` is read by this SDK's tests and by the
/// Kotlin SDK's tests, so a rule that drifts in one language fails in both.
/// Capture must never be the reason a secret leaves the device. Deny-biased on
/// purpose — a header, a query key, a query value or a path segment that *might*
/// be a credential is dropped. Keeping the shape while dropping the value
/// preserves what an agent can act on and discards what it could not use anyway.
///
/// The URL rules are a port of `packages/core/src/redaction.ts`, narrowed to
/// what a mobile SDK can carry: path segment redaction, sensitive preceder
/// detection, and token shape matching on query values. Key names alone were
/// never enough, because a REST API puts the value in the path
/// (`/reset-password/<jwt>`) and a redirect parameter puts a whole second URL
/// inside one query value.
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

  /// Path segments whose *next* segment is the value, not another route name.
  ///
  /// `/reset/<code>` and `/otp/<code>` are followed by the secret itself.
  /// `/session/refresh` is followed by an endpoint name, which is why the plain
  /// route word carve-out below exists and why `session` is absent from
  /// [_credentialPathPreceders].
  static const Set<String> _sensitivePathPreceders = {
    'code',
    'invite',
    'magic',
    'mfa',
    'otp',
    'passcode',
    'reset',
    'session',
    'token',
    'verify',
  };

  /// The subset that is *definitionally* followed by a value, so no carve-out.
  static const Set<String> _credentialPathPreceders = {
    'code',
    'invite',
    'magic',
    'mfa',
    'otp',
    'passcode',
    'reset',
    'token',
    'verify',
  };

  /// A segment that is plainly a route name rather than a value.
  ///
  /// Without this, `/api/auth/whoami` reports its own endpoint as a secret and a
  /// captured 401 names no endpoint at all. Deliberately narrow, because it
  /// weakens a security control: short all-lowercase words, API version
  /// segments, and three named protocol words. Anything with entropy — a token,
  /// a hash, an id, a JWT, a uuid — fails at least one of those.
  static final RegExp _plainRouteWord = RegExp(r'^(?:[a-z]{2,16}|v[0-9]{1,3})$');
  static const Set<String> _plainRouteProtocolWords = {
    'oauth1',
    'oauth2',
    'saml2',
  };

  /// Credential shapes, matched on the decoded value.
  ///
  /// The last two are generic length-and-charset rules. They cost some
  /// legitimate long identifiers, which is the intended trade on a plane where
  /// the SDK cannot ask the application what a value means.
  static final List<RegExp> _tokenPatterns = [
    RegExp(r'\b(?:Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b',
        caseSensitive: false),
    RegExp(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b'),
    RegExp(
        r'(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_.=-]{12,}',
        caseSensitive: false),
    RegExp(r'\b[A-Fa-f0-9]{32,}\b'),
    RegExp(r'\b[A-Za-z0-9_-]{40,}\b'),
  ];

  static final RegExp _uuidPattern = RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      caseSensitive: false);
  static final RegExp _emailPattern =
      RegExp('[^\\s@"\'<>]+@[^\\s@"\'<>]+\\.[A-Za-z]{2,}');
  static final RegExp _opaqueSegment = RegExp(r'^[A-Za-z0-9_-]{16,39}$');
  static final RegExp _versionOrYearPart = RegExp(r'^[A-Za-z]?[0-9]{1,4}$');
  static final RegExp _lettersOnly = RegExp(r'^[A-Za-z]+$');
  static final RegExp _vowel = RegExp('[aeiouy]', caseSensitive: false);
  static final RegExp _nonAlphanumeric = RegExp(r'[^a-z0-9]');

  /// Lowercase and strip non-alphanumerics, so `X-API_Key`, `x-api-key` and
  /// `xApiKey` compact to one token and cannot slip through on spelling.
  static String compact(String name) =>
      name.toLowerCase().replaceAll(_nonAlphanumeric, '');

  static bool isDeniedHeader(String name) {
    final compacted = compact(name);
    return _deniedHeaderNames.contains(compacted) ||
        _deniedNameTokens.any(compacted.contains);
  }

  static bool _isDeniedName(String name) {
    final compacted = compact(name);
    return _deniedNameTokens.any(compacted.contains);
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

  /// Strip credentials, credential-shaped path segments and credential-shaped
  /// query values from a URL.
  ///
  /// Removes userinfo (`https://user:pass@host`) and the fragment — where apps
  /// park access tokens after an OAuth redirect — then rewrites the path and
  /// query segment by segment.
  ///
  /// Anything without a scheme and host keeps only its path. `Uri.parse` is
  /// lenient, so "did it parse" is not a safety check; the query heuristics are
  /// only trustworthy on something genuinely URL-shaped, and everything else has
  /// its query dropped wholesale rather than scanned.
  static String redactUrl(String raw) {
    if (raw.isEmpty) return placeholder;

    final Uri uri;
    try {
      uri = Uri.parse(raw);
    } on FormatException {
      return placeholder;
    }

    if (!uri.hasScheme || uri.host.isEmpty) {
      // The parser's own path, never a slice of the input: a protocol-relative
      // `//user:pass@host/path` carries userinfo that a slice would hand
      // straight back.
      if (uri.path.isEmpty) return placeholder;
      return _redactPath(uri.path);
    }

    final beforeFragment = _before(raw, '#');
    final beforeQuery = _before(beforeFragment, '?');
    final rawQuery =
        beforeFragment.contains('?') ? _after(beforeFragment, '?') : null;

    final buffer = StringBuffer()
      ..write(uri.scheme)
      ..write('://')
      ..write(uri.host);
    if (uri.hasPort) buffer.write(':${uri.port}');
    buffer.write(_redactPath(_rawPathOf(beforeQuery)));
    if (rawQuery != null && rawQuery.isNotEmpty) {
      buffer.write('?${_redactQuery(rawQuery)}');
    }
    // Fragment deliberately never carried over.
    return buffer.toString();
  }

  /// The path exactly as written, taken from the input rather than the parser.
  ///
  /// `Uri` exposes only a decoded, normalised path, so `%2F` would come back
  /// indistinguishable from `/`. Slicing the input is the one derivation both
  /// SDKs can perform identically, which is what makes their output byte
  /// comparable in `test-fixtures/redaction/urls.json`.
  static String _rawPathOf(String beforeQuery) {
    final separator = beforeQuery.indexOf('://');
    if (separator < 0) return '';
    final slash = beforeQuery.indexOf('/', separator + 3);
    return slash < 0 ? '' : beforeQuery.substring(slash);
  }

  static String _before(String value, String marker) {
    final index = value.indexOf(marker);
    return index < 0 ? value : value.substring(0, index);
  }

  static String _after(String value, String marker) {
    final index = value.indexOf(marker);
    return index < 0 ? '' : value.substring(index + marker.length);
  }

  /// Percent-decode up to three times, leaving `+` alone. Unchanged on failure.
  static String _decodeDeep(String value) {
    var output = value;
    for (var round = 0; round < 3; round += 1) {
      final decoded = _decodeOnce(output);
      if (decoded == null || decoded == output) return output;
      output = decoded;
    }
    return output;
  }

  /// One percent-decode, or null when the input is not decodable.
  ///
  /// `+` is escaped first so this agrees with the Kotlin SDK, whose
  /// `URLDecoder` would otherwise read it as a form-encoded space. Bytes that
  /// are not UTF-8 are indistinguishable from a deliberately mangled key, so
  /// they fail closed.
  static String? _decodeOnce(String value) {
    try {
      return Uri.decodeComponent(value.replaceAll('+', '%2B'));
    } catch (_) {
      return null;
    }
  }

  /// Rewrite the query pair by pair, preserving the raw structure.
  ///
  /// Deliberately not `Uri.queryParameters`: it collapses repeated keys so
  /// `?id=1&id=2` came back as `?id=2`, and re-encoding through `Uri` turned the
  /// marker itself into `%5BREDACTED%5D` and every space into `+`, so nothing
  /// downstream could match on the literal marker.
  static String _redactQuery(String rawQuery) {
    return rawQuery.split('&').map((pair) {
      final name = _before(pair, '=');
      if (_decodeOnce(name) == null) return '$name=$placeholder';
      if (_isDeniedName(_decodeDeep(name))) return '$name=$placeholder';
      if (!pair.contains('=')) return pair;
      final value = _after(pair, '=');
      if (value.isEmpty) return pair;
      if (_decodeOnce(value) == null) return '$name=$placeholder';
      return _carriesSecret(_decodeDeep(value)) ? '$name=$placeholder' : pair;
    }).join('&');
  }

  /// Rewrite a path one segment at a time, carrying the previous segment as
  /// context: `/reset/<value>` is what makes `<value>` a secret, and nothing in
  /// the segment itself says so.
  static String _redactPath(String path) {
    if (path.isEmpty || path == '/') return path;
    var previous = '';
    return path.split('/').map((segment) {
      if (segment.isEmpty) return segment;
      final decoded = _decodeDeep(segment);
      final lower = decoded.toLowerCase();
      final redact =
          (_isSensitivePreceder(previous) && !_isPlainRouteWord(previous, lower)) ||
              _carriesSecret(decoded) ||
              _isSecretLikeSegment(decoded);
      previous = redact ? placeholder.toLowerCase() : lower;
      return redact ? placeholder : segment;
    }).join('/');
  }

  static bool _isSensitivePreceder(String previous) =>
      _sensitivePathPreceders.contains(previous) || _isDeniedName(previous);

  static bool _isPlainRouteWord(String previous, String component) =>
      !_credentialPathPreceders.contains(previous) &&
      (_plainRouteWord.hasMatch(component) ||
          _plainRouteProtocolWords.contains(component));

  /// Does this decoded value carry a credential, whatever its key said?
  ///
  /// Three ways it can. It is a credential shape outright (`Bearer sk-live-…`, a
  /// JWT, a long hex run). It is an email address, which is the value a REST API
  /// most often puts in a path segment. Or it is a whole second URL with its own
  /// query string, which is how `?next=https%3A%2F%2Fx.com%3Ftoken%3D…` smuggles
  /// a token past a check that only reads the outer key.
  static bool _carriesSecret(String decoded) {
    if (_tokenPatterns.any((pattern) => pattern.hasMatch(decoded))) return true;
    if (_emailPattern.hasMatch(decoded)) return true;
    if (!decoded.contains('=')) return false;
    return decoded.split(RegExp(r'[?&]')).any((part) {
      if (!part.contains('=')) return false;
      return _isDeniedName(_before(part, '=')) ||
          _tokenPatterns.any((pattern) => pattern.hasMatch(_after(part, '=')));
    });
  }

  /// An opaque identifier sitting in a path with nothing around it to say what
  /// it is: a uuid, or a length-and-charset run that does not read as words.
  ///
  /// The word test is what keeps `aurora-desk-lamp` and `winter-sale-2024`
  /// readable while `sk_live_4eC39HqLyjWDarjt` and a raw hex id still redact.
  /// Without it, a product slug and a secret of the same length were treated
  /// identically and a session could not say which page a bug happened on.
  static bool _isSecretLikeSegment(String segment) {
    if (_uuidPattern.hasMatch(segment)) return true;
    if (!_opaqueSegment.hasMatch(segment)) return false;
    return !_isWordLikeSlug(segment);
  }

  static bool _isWordLikeSlug(String segment) {
    final parts = segment.split(RegExp(r'[-_]'));
    if (parts.isEmpty) return false;
    return parts.every((part) {
      if (part.isEmpty) return false;
      if (_versionOrYearPart.hasMatch(part)) return true;
      if (!_lettersOnly.hasMatch(part)) return false;
      return _vowel.hasMatch(part);
    });
  }
}
