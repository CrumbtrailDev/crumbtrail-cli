import 'dart:convert';
import 'dart:io';

import 'package:crumbtrail_flutter/crumbtrail_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

/// Conformance against `test-fixtures/wire-contract/`.
///
/// The Swift and Kotlin SDKs run the equivalent of this file against the same
/// files. Changing a fixture therefore fails all three at once, which is the
/// only mechanism that reliably catches one SDK quietly renaming a field.
///
/// The fixtures are read from the repo root rather than copied in: a per-SDK
/// copy would hide exactly the cross-language drift these exist to catch.
void main() {
  const sdk = CrumbtrailSdkDescriptor(
    name: 'crumbtrail-fixture',
    version: '0.0.0-fixture',
  );
  const timestamp = 1754000000000;
  const capabilities = ['app-lifecycle', 'device-info'];

  final fixtureDir = () {
    var dir = Directory.current;
    while (!Directory('${dir.path}/test-fixtures/wire-contract').existsSync()) {
      final parent = dir.parent;
      if (parent.path == dir.path) {
        throw StateError('repo root not found from ${Directory.current.path}');
      }
      dir = parent;
    }
    return Directory('${dir.path}/test-fixtures/wire-contract');
  }();

  CrumbtrailEvent event(
    CrumbtrailEventKind kind,
    Map<String, Object?> data, {
    CrumbtrailTarget? target,
  }) =>
      CrumbtrailEvent.of(
        timestamp: timestamp,
        kind: kind,
        data: data,
        sdk: sdk,
        platform: CrumbtrailPlatform.ios,
        capabilities: capabilities,
        target: target,
      );

  /// Compare canonical JSON text. Both sides go through this SDK's own encoder,
  /// which sorts keys and normalises whole doubles, so the comparison is about
  /// structure and values rather than how a fixture file is indented.
  void expectMatchesFixture(CrumbtrailEvent actual, String name) {
    final file = File('${fixtureDir.path}/events/$name.json');
    final expected = canonicalJsonEncode(jsonDecode(file.readAsStringSync()));
    expect(
      canonicalJsonEncode(actual.toJson()),
      expected,
      reason: 'does not match test-fixtures/wire-contract/events/$name.json',
    );
  }

  test('fixtures are reachable', () {
    // If the path arithmetic above is wrong, every other test here would pass
    // vacuously. Fail loudly instead.
    final file = File('${fixtureDir.path}/events/net.json');
    expect(file.existsSync(), isTrue, reason: 'expected ${file.path}');
    expect(file.readAsStringSync(), contains('"k"'));
  });

  test('error event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.error, {
        'msg': 'Unexpected nil while unwrapping an Optional value',
        'stk': 'CrumbtrailDemo.CheckoutViewController.submit()\n'
            'CrumbtrailDemo.CheckoutViewController.tap()',
        'fatal': true,
        'source': 'uncaught-exception',
      }),
      'err',
    );
  });

  test('rejection event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.rejection, {
        'msg': 'The request timed out.',
        'stk': 'CrumbtrailDemo.OrderService.load()',
        'source': 'unhandled-async',
      }),
      'rej',
    );
  });

  test('console event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.console, {
        'lv': 'err',
        'args': ['checkout failed', '{"orderId":42}'],
      }),
      'con',
    );
  });

  test('network event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.network, {
        'url': 'https://api.example.com/v1/orders',
        'method': 'POST',
        'status': 402,
        'ok': false,
        'dur': 318,
        'source': 'urlsession',
      }),
      'net',
    );
  });

  test('network status event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.networkStatus, {
        'connected': false,
        'type': 'none',
        'kind': 'change',
      }),
      'net-status',
    );
  });

  test('environment event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.environment, {
        'kind': 'snapshot',
        'device': {
          'model': 'iPhone15,2',
          'manufacturer': 'Apple',
          'os': 'iOS',
          'osVersion': '18.2',
        },
        'app': {
          'id': 'ai.crumbtrail.demo',
          'version': '1.4.0',
          'build': '204',
        },
        'battery': {'level': 0.42, 'charging': false},
        'locale': 'en-GB',
      }),
      'env',
    );
  });

  test('navigation event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.navigation, {
        'name': 'CheckoutViewController',
        'path': '/checkout',
        'source': 'navigation-controller',
      }),
      'navigation',
    );
  });

  test('navigation intent event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.navigationIntent, {
        'action': 'back',
        'source': 'hardware-back',
      }),
      'nav-intent',
    );
  });

  test('app lifecycle event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.appLifecycle, {
        'state': 'background',
        'source': 'app-lifecycle',
      }),
      'app-lifecycle',
    );
  });

  test('native crash event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.nativeCrash, {
        'msg': 'Fatal error: index out of range',
        'stk': 'CrumbtrailDemo.CartView.item(at:)',
        'signal': 'SIGABRT',
        'source': 'previous-launch',
      }),
      'native-crash',
    );
  });

  test('view snapshot event', () {
    expectMatchesFixture(
      event(CrumbtrailEventKind.viewSnapshot, {
        'w': 393,
        'h': 852,
        'nodes': [
          {
            'role': 'screen',
            'componentName': 'CheckoutViewController',
            'bounds': {'x': 0, 'y': 0, 'width': 393, 'height': 852},
          },
          {
            'role': 'button',
            'label': 'Pay now',
            'testID': 'checkout-pay',
            'bounds': {'x': 16, 'y': 720, 'width': 361, 'height': 48},
          },
        ],
      }),
      'view-snapshot',
    );
  });

  test('target descriptor', () {
    expectMatchesFixture(
      event(
        CrumbtrailEventKind.error,
        {'msg': 'tap handler threw', 'fatal': false, 'source': 'caught'},
        target: const CrumbtrailTarget(
          role: 'button',
          label: 'Pay now',
          testID: 'checkout-pay',
          componentName: 'CheckoutButton',
          routePath: '/checkout',
          bounds: CrumbtrailBounds(x: 16, y: 720, width: 361, height: 48),
        ),
      ),
      'target',
    );
  });

  group('envelope invariants', () {
    test('schema version and platform are always sent', () {
      final json = event(CrumbtrailEventKind.error, {}).toJson();
      expect(json['schemaVersion'], 1);
      expect(json['platform'], 'ios');
    });

    test('empty capabilities are omitted, not sent empty', () {
      final bare = CrumbtrailEvent.of(
        timestamp: timestamp,
        kind: CrumbtrailEventKind.error,
        data: const {},
        sdk: sdk,
      );
      // An absent field and an empty array are different claims on the ingest
      // side, and only one of them is what we mean.
      expect(bare.toJson().containsKey('capabilities'), isFalse);
    });

    test('a target that identifies nothing is dropped', () {
      final bare = CrumbtrailEvent.of(
        timestamp: timestamp,
        kind: CrumbtrailEventKind.error,
        data: const {},
        sdk: sdk,
        // Bounds only: names no element, costs bytes on every event.
        target: const CrumbtrailTarget(
          bounds: CrumbtrailBounds(x: 0, y: 0, width: 1, height: 1),
        ),
      );
      expect(bare.toJson().containsKey('target'), isFalse);
    });

    test('platform defaults to flutter', () {
      final bare = CrumbtrailEvent.of(
        timestamp: timestamp,
        kind: CrumbtrailEventKind.error,
        data: const {},
        sdk: sdk,
      );
      expect(bare.toJson()['platform'], 'flutter');
    });

    test('whole doubles encode without a trailing decimal', () {
      // 402.0 and 402 are different JSON tokens, and a fixture written by
      // another language would fail on the difference alone.
      expect(canonicalJsonEncode({'n': 402.0}), '{"n":402}');
      expect(canonicalJsonEncode({'n': 0.42}), '{"n":0.42}');
    });

    test('object keys encode in sorted order', () {
      expect(
        canonicalJsonEncode({'zebra': 1, 'alpha': 2}),
        '{"alpha":2,"zebra":1}',
      );
    });
  });
}
