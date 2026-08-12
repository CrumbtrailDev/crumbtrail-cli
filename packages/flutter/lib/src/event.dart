import 'dart:convert';

/// Source runtime an event came from. See the shared wire contract.
enum CrumbtrailPlatform {
  web('web'),
  reactNative('react-native'),
  ios('ios'),
  android('android'),
  flutter('flutter'),
  webview('webview'),
  node('node');

  const CrumbtrailPlatform(this.wireValue);
  final String wireValue;
}

/// The shared event kinds.
enum CrumbtrailEventKind {
  error('err'),
  rejection('rej'),
  console('con'),
  network('net'),
  networkStatus('net-status'),
  environment('env'),
  navigation('navigation'),
  navigationIntent('nav-intent'),
  appLifecycle('app-lifecycle'),
  nativeCrash('native-crash'),
  viewSnapshot('view-snapshot');

  const CrumbtrailEventKind(this.wireValue);
  final String wireValue;
}

/// Current version of the shared event envelope.
const int crumbtrailSchemaVersion = 1;

/// Identity of the SDK that produced an event.
class CrumbtrailSdkDescriptor {
  const CrumbtrailSdkDescriptor({required this.name, required this.version});

  final String name;
  final String version;

  Map<String, Object?> toJson() => {'name': name, 'version': version};
}

/// Bounding box of a UI element, in logical pixels.
class CrumbtrailBounds {
  const CrumbtrailBounds({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  final double x;
  final double y;
  final double width;
  final double height;

  Map<String, Object?> toJson() =>
      {'x': x, 'y': y, 'width': width, 'height': height};
}

/// A normalised reference to a UI element.
///
/// At least one identifying key must be present or the descriptor is dropped —
/// a target made only of bounds names nothing and costs payload on every event.
class CrumbtrailTarget {
  const CrumbtrailTarget({
    this.role,
    this.label,
    this.testID,
    this.accessibilityId,
    this.componentName,
    this.routePath,
    this.ancestryHash,
    this.bounds,
  });

  final String? role;
  final String? label;
  final String? testID;
  final String? accessibilityId;
  final String? componentName;
  final String? routePath;
  final String? ancestryHash;
  final CrumbtrailBounds? bounds;

  bool get identifiesSomething =>
      role != null ||
      label != null ||
      testID != null ||
      accessibilityId != null ||
      componentName != null ||
      routePath != null ||
      ancestryHash != null;

  Map<String, Object?> toJson() => compactJson({
        'role': role,
        'label': label,
        'testID': testID,
        'accessibilityId': accessibilityId,
        'componentName': componentName,
        'routePath': routePath,
        'ancestryHash': ancestryHash,
        'bounds': bounds?.toJson(),
      });
}

/// Drop null-valued keys from a map.
///
/// The contract's rule: an absent field and a null one are different claims, and
/// "we did not observe this" is almost always the true one.
Map<String, Object?> compactJson(Map<String, Object?> input) {
  final result = <String, Object?>{};
  input.forEach((key, value) {
    if (value != null) result[key] = value;
  });
  return result;
}

/// One captured event, in the shape ingest expects.
class CrumbtrailEvent {
  CrumbtrailEvent({
    required this.timestamp,
    required this.kind,
    required this.data,
    required this.sdk,
    this.platform = CrumbtrailPlatform.flutter,
    this.capabilities = const [],
    CrumbtrailTarget? target,
  }) : target =
            (target != null && target.identifiesSomething) ? target : null;

  CrumbtrailEvent.of({
    required int timestamp,
    required CrumbtrailEventKind kind,
    required Map<String, Object?> data,
    required CrumbtrailSdkDescriptor sdk,
    CrumbtrailPlatform platform = CrumbtrailPlatform.flutter,
    List<String> capabilities = const [],
    CrumbtrailTarget? target,
  }) : this(
          timestamp: timestamp,
          kind: kind.wireValue,
          data: data,
          sdk: sdk,
          platform: platform,
          capabilities: capabilities,
          target: target,
        );

  /// Unix timestamp in MILLISECONDS. Seconds here would place every event in
  /// 1970 and break every correlation the product depends on.
  final int timestamp;
  final String kind;
  final Map<String, Object?> data;
  final CrumbtrailPlatform platform;
  final CrumbtrailSdkDescriptor sdk;
  final List<String> capabilities;
  final CrumbtrailTarget? target;

  Map<String, Object?> toJson() => compactJson({
        't': timestamp,
        'k': kind,
        'd': data,
        'schemaVersion': crumbtrailSchemaVersion,
        'platform': platform.wireValue,
        'sdk': sdk.toJson(),
        // Omitted rather than sent empty: an absent field and an empty array are
        // different claims on the ingest side.
        'capabilities': capabilities.isEmpty ? null : capabilities,
        'target': target?.toJson(),
      });
}

/// Encode with object keys in sorted order.
///
/// Dart's `jsonEncode` preserves insertion order, which is fine for a server but
/// not for a conformance test comparing bytes against a fixture written by
/// another language. Sorting makes the output canonical.
String canonicalJsonEncode(Object? value) =>
    jsonEncode(_sortKeys(value));

Object? _sortKeys(Object? value) {
  if (value is Map) {
    final sorted = <String, Object?>{};
    final keys = value.keys.map((key) => key as String).toList()..sort();
    for (final key in keys) {
      sorted[key] = _sortKeys(value[key]);
    }
    return sorted;
  }
  if (value is List) return value.map(_sortKeys).toList();
  // A whole double encodes as `402.0`, which is a different JSON token from
  // `402` and would fail a byte comparison against a fixture on that alone.
  if (value is double && value.isFinite && value == value.roundToDouble()) {
    return value.toInt();
  }
  return value;
}
