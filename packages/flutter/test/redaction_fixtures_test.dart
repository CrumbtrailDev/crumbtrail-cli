import 'dart:convert';
import 'dart:io';

import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

/// Conformance against `test-fixtures/redaction/urls.json`.
///
/// The Kotlin SDK runs the equivalent of this file against the same corpus, so
/// a rule that drifts in one language fails in both. The class doc on
/// `CrumbtrailRedaction` claims the SDKs are held to the same fixtures; this is
/// the file that makes that true for URLs.
///
/// The corpus is read from the repo root rather than copied in: a per-SDK copy
/// would hide exactly the cross-language drift it exists to catch.
void main() {
  final fixture = () {
    var dir = Directory.current;
    while (!Directory('${dir.path}/test-fixtures/redaction').existsSync()) {
      final parent = dir.parent;
      if (parent.path == dir.path) {
        throw StateError('repo root not found from ${Directory.current.path}');
      }
      dir = parent;
    }
    return File('${dir.path}/test-fixtures/redaction/urls.json');
  }();

  List<Map<String, String>> cases() {
    final root = jsonDecode(fixture.readAsStringSync()) as Map<String, Object?>;
    return (root['cases'] as List<Object?>)
        .cast<Map<String, Object?>>()
        .map((entry) => entry.map((key, value) => MapEntry(key, '$value')))
        .toList();
  }

  test('the corpus is reachable and not empty', () {
    // If the path arithmetic above is wrong every other assertion here would
    // pass vacuously against an empty list. Fail loudly instead.
    expect(fixture.existsSync(), isTrue, reason: 'expected ${fixture.path}');
    expect(cases().length, greaterThanOrEqualTo(10));
  });

  test('every fixture URL redacts to the shared expectation', () {
    final failures = <String>[];
    for (final entry in cases()) {
      final actual = CrumbtrailRedaction.redactUrl(entry['input']!);
      if (actual != entry['expected']) {
        failures.add('${entry['name']}\n'
            '  input:    ${entry['input']}\n'
            '  expected: ${entry['expected']}\n'
            '  actual:   $actual');
      }
    }
    expect(failures, isEmpty,
        reason: 'test-fixtures/redaction/urls.json disagrees with this SDK:\n'
            '${failures.join('\n')}');
  });

  test('the marker is emitted literally so ingest can match on it', () {
    // Re-encoding the marker is the failure mode that hides a redaction from
    // every downstream consumer while still looking redacted to a reader.
    expect(
      CrumbtrailRedaction.redactUrl('https://api.example.com/api?token=abc'),
      'https://api.example.com/api?token=[REDACTED]',
    );
  });

  test('verified leaks from the reviewed adapters stay redacted', () {
    const urls = [
      'https://api.example.com/v1/users/omar@shabana.dev/profile',
      'https://api.example.com/reset-password/eyJhbGciOiJIUzI1NiJ9.abc.def',
      'https://api.example.com/api?q=Bearer%20sk-live-1234567890',
      'https://api.example.com/api?next=https%3A%2F%2Fx.com%3Ftoken%3Dsecret',
    ];
    const secrets = [
      'omar@shabana.dev',
      'eyJhbGciOiJIUzI1NiJ9',
      'sk-live-1234567890',
      'token%3Dsecret',
    ];
    for (final url in urls) {
      final redacted = CrumbtrailRedaction.redactUrl(url);
      expect(redacted, contains(CrumbtrailRedaction.placeholder));
      for (final secret in secrets) {
        expect(redacted, isNot(contains(secret)));
      }
    }
  });
}
