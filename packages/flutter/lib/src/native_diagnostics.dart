import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

const String crumbtrailNativeDiagnosticsChannel =
    'ai.crumbtrail/native_diagnostics';

/// A diagnostic event produced by the native plugin and drained by Dart.
class CrumbtrailNativeDiagnosticEvent {
  const CrumbtrailNativeDiagnosticEvent(
      {required this.kind, required this.data});

  final String kind;
  final Map<String, Object?> data;
}

class CrumbtrailNativeCapabilityDetail {
  const CrumbtrailNativeCapabilityDetail({
    required this.supported,
    required this.enabled,
    required this.observed,
  });

  final bool supported;
  final bool enabled;
  final bool observed;

  Map<String, Object?> toJson() => {
        'supported': supported,
        'enabled': enabled,
        'observed': observed,
      };
}

class CrumbtrailNativeCapabilities {
  const CrumbtrailNativeCapabilities({
    required this.nativeDiagnostics,
    required this.nativeHang,
    required this.nativeCrash,
    required this.appLifecycle,
  });

  final CrumbtrailNativeCapabilityDetail nativeDiagnostics;
  final CrumbtrailNativeCapabilityDetail nativeHang;
  final CrumbtrailNativeCapabilityDetail nativeCrash;
  final CrumbtrailNativeCapabilityDetail appLifecycle;

  static const absent = CrumbtrailNativeCapabilities(
    nativeDiagnostics: CrumbtrailNativeCapabilityDetail(
      supported: false,
      enabled: false,
      observed: false,
    ),
    nativeHang: CrumbtrailNativeCapabilityDetail(
      supported: false,
      enabled: false,
      observed: false,
    ),
    nativeCrash: CrumbtrailNativeCapabilityDetail(
      supported: false,
      enabled: false,
      observed: false,
    ),
    appLifecycle: CrumbtrailNativeCapabilityDetail(
      supported: false,
      enabled: false,
      observed: false,
    ),
  );

  Map<String, Object?> toJson() => {
        'nativeDiagnostics': nativeDiagnostics.toJson(),
        'nativeHang': nativeHang.toJson(),
        'nativeCrash': nativeCrash.toJson(),
        'appLifecycle': appLifecycle.toJson(),
      };
}

/// Platform seam for native diagnostics. Tests and platform implementations can
/// provide this without booting a native engine.
abstract interface class CrumbtrailNativeDiagnosticsPlatform {
  Future<CrumbtrailNativeCapabilities> getCapabilities();

  Future<List<CrumbtrailNativeDiagnosticEvent>> drainDiagnostics();
}

/// Method channel implementation used by Android and iOS plugin registrants.
class MethodChannelCrumbtrailNativeDiagnostics
    implements CrumbtrailNativeDiagnosticsPlatform {
  MethodChannelCrumbtrailNativeDiagnostics({MethodChannel? channel})
      : _channel =
            channel ?? const MethodChannel(crumbtrailNativeDiagnosticsChannel);

  final MethodChannel _channel;

  @override
  Future<CrumbtrailNativeCapabilities> getCapabilities() async {
    try {
      final raw = await _channel.invokeMethod<Object?>('getCapabilities');
      return _parseCapabilities(raw);
    } on Object {
      // A package can be used on a platform where its plugin was not
      // registered. That is an unavailable capability, not an app failure.
      return CrumbtrailNativeCapabilities.absent;
    }
  }

  @override
  Future<List<CrumbtrailNativeDiagnosticEvent>> drainDiagnostics() async {
    try {
      final raw = await _channel.invokeMethod<Object?>('drainDiagnostics');
      if (raw is! List) return const [];
      return raw
          .map(_parseEvent)
          .whereType<CrumbtrailNativeDiagnosticEvent>()
          .toList();
    } on Object {
      return const [];
    }
  }
}

/// A synchronous bounded handoff for a Dart watchdog observation.
abstract interface class CrumbtrailDartHangHandoff {
  Map<String, Object?>? read();

  void write(Map<String, Object?> event);

  void clear();
}

class MemoryCrumbtrailDartHangHandoff implements CrumbtrailDartHangHandoff {
  Map<String, Object?>? _pending;

  @override
  Map<String, Object?>? read() => _pending == null ? null : {..._pending!};

  @override
  void write(Map<String, Object?> event) {
    _pending = _boundedEvent(event);
  }

  @override
  void clear() {
    _pending = null;
  }
}

class SharedPreferencesDartHangHandoff implements CrumbtrailDartHangHandoff {
  SharedPreferencesDartHangHandoff(
    this.preferences, {
    this.key = 'crumbtrail.dart.native-hang',
  });

  final SharedPreferences preferences;
  final String key;

  @override
  Map<String, Object?>? read() {
    final raw = preferences.getString(key);
    if (raw == null || raw.isEmpty) return null;
    try {
      final value = jsonDecode(raw);
      return value is Map ? _parseHangData(value) : null;
    } on Object {
      return null;
    }
  }

  @override
  void write(Map<String, Object?> event) {
    try {
      // setString is asynchronous at the platform boundary, but it returns
      // immediately and cannot block the Dart event loop.
      unawaited(
        preferences
            .setString(key, jsonEncode(_boundedEvent(event)))
            .then((_) {}),
      );
    } on Object {
      // Diagnostic storage must never take down the host.
    }
  }

  @override
  void clear() {
    try {
      unawaited(preferences.remove(key).then((_) {}));
    } on Object {
      // Best effort only.
    }
  }
}

/// Foreground aware Dart event loop watchdog.
class CrumbtrailDartEventLoopWatchdog {
  CrumbtrailDartEventLoopWatchdog({
    required this.onHang,
    this.handoff,
    this.threshold = const Duration(seconds: 5),
    this.checkInterval = const Duration(seconds: 1),
    DateTime Function()? now,
    bool Function()? debuggerAttached,
    this.suppressInDebug = true,
  })  : _now = now ?? DateTime.now,
        _debuggerAttached = debuggerAttached ?? (() => false);

  final void Function(Map<String, Object?> data) onHang;
  final CrumbtrailDartHangHandoff? handoff;
  final Duration threshold;
  final Duration checkInterval;
  final DateTime Function() _now;
  final bool Function() _debuggerAttached;
  final bool suppressInDebug;

  Timer? _timer;
  DateTime? _lastTick;
  bool _foreground = true;
  bool _reportedForBlock = false;
  bool _stopped = false;

  /// Starts the watchdog and imports one bounded prior-launch handoff.
  void start({bool foreground = true}) {
    if (_stopped) return;
    _foreground = foreground;
    _lastTick = _now();
    final pending = _safeRead();
    if (pending != null && _isValidHangData(pending)) {
      _safeEmit({
        ...pending,
        'recovered': false,
        'previousLaunch': true,
      });
      _safeClear();
    }
    if (_isSuppressed) return;
    _timer?.cancel();
    final interval = checkInterval <= Duration.zero
        ? const Duration(seconds: 1)
        : checkInterval;
    _timer = Timer.periodic(interval, (_) => _tick());
  }

  void pause() {
    if (_stopped) return;
    _foreground = false;
    _reportedForBlock = false;
    _lastTick = _now();
  }

  void resume() {
    if (_stopped) return;
    _foreground = true;
    _reportedForBlock = false;
    _lastTick = _now();
  }

  void stop() {
    if (_stopped) return;
    _stopped = true;
    _timer?.cancel();
    _timer = null;
  }

  bool get _isSuppressed {
    try {
      return _debuggerAttached() || (suppressInDebug && kDebugMode);
    } on Object {
      return true;
    }
  }

  void _tick() {
    final current = _now();
    final elapsed = current.difference(_lastTick ?? current);
    _lastTick = current;
    if (!_foreground || _isSuppressed) {
      _reportedForBlock = false;
      return;
    }
    final blocked = elapsed - checkInterval;
    if (blocked < threshold || _reportedForBlock) return;
    _reportedForBlock = true;
    final data = _boundedEvent({
      'source': 'dart',
      'thresholdMs': threshold.inMilliseconds,
      'observedDurationMs': blocked.inMilliseconds
          .clamp(1, const Duration(days: 1).inMilliseconds)
          .toInt(),
      'recovered': true,
      'previousLaunch': false,
    });
    _safeWrite(data);
    _safeEmit(data);
    _safeClear();
  }

  Map<String, Object?>? _safeRead() {
    try {
      return handoff?.read();
    } on Object {
      return null;
    }
  }

  void _safeWrite(Map<String, Object?> data) {
    try {
      handoff?.write(data);
    } on Object {
      // A storage failure is capture loss, never a host failure.
    }
  }

  void _safeClear() {
    try {
      handoff?.clear();
    } on Object {
      // Best effort only.
    }
  }

  void _safeEmit(Map<String, Object?> data) {
    try {
      onHang(data);
    } on Object {
      // A logger teardown race must not escape the watchdog callback.
    }
  }
}

CrumbtrailNativeCapabilities _parseCapabilities(Object? value) {
  if (value is! Map) return CrumbtrailNativeCapabilities.absent;
  CrumbtrailNativeCapabilityDetail detail(String key) {
    final candidate = value[key];
    if (candidate is! Map) {
      return const CrumbtrailNativeCapabilityDetail(
        supported: false,
        enabled: false,
        observed: false,
      );
    }
    return CrumbtrailNativeCapabilityDetail(
      supported: candidate['supported'] == true,
      enabled: candidate['enabled'] == true,
      observed: candidate['observed'] == true,
    );
  }

  return CrumbtrailNativeCapabilities(
    nativeDiagnostics: detail('nativeDiagnostics'),
    nativeHang: detail('nativeHang'),
    nativeCrash: detail('nativeCrash'),
    appLifecycle: detail('appLifecycle'),
  );
}

CrumbtrailNativeDiagnosticEvent? _parseEvent(Object? value) {
  if (value is! Map || value['kind'] is! String || value['data'] is! Map) {
    return null;
  }
  final kind = value['kind'] as String;
  if (kind != 'native-hang' &&
      kind != 'native-crash' &&
      kind != 'app-lifecycle') {
    return null;
  }
  final data = <String, Object?>{};
  (value['data'] as Map).forEach((key, item) {
    if (key is String && _isBoundedScalar(item)) data[key] = item;
  });
  final bounded = _boundedEvent(data);
  if (kind == 'native-hang' && !_isValidHangData(bounded)) return null;
  if (kind == 'native-hang') {
    return CrumbtrailNativeDiagnosticEvent(
      kind: kind,
      data: {...bounded, 'recovered': false, 'previousLaunch': true},
    );
  }
  return CrumbtrailNativeDiagnosticEvent(kind: kind, data: bounded);
}

Map<String, Object?>? _parseHangData(Map value) {
  final data = <String, Object?>{};
  value.forEach((key, item) {
    if (key is String && _isBoundedScalar(item)) data[key] = item;
  });
  final bounded = _boundedEvent(data);
  return _isValidHangData(bounded) ? bounded : null;
}

Map<String, Object?> _boundedEvent(Map<String, Object?> value) {
  final result = <String, Object?>{};
  for (final entry in value.entries.take(16)) {
    if (entry.key.length > 64 || !_isBoundedScalar(entry.value)) continue;
    result[entry.key] = entry.value is String
        ? (entry.value! as String).substring(
            0,
            (entry.value! as String).length.clamp(0, 8192).toInt(),
          )
        : entry.value;
  }
  return result;
}

bool _isBoundedScalar(Object? value) =>
    value is String || value is bool || (value is num && value.isFinite);

bool _isValidHangData(Map<String, Object?> value) {
  final source = value['source'];
  final threshold = value['thresholdMs'];
  final observed = value['observedDurationMs'];
  return (source == 'main-thread' || source == 'js' || source == 'dart') &&
      threshold is int &&
      threshold >= 0 &&
      threshold <= const Duration(days: 1).inMilliseconds &&
      observed is int &&
      observed >= 0 &&
      observed <= const Duration(days: 1).inMilliseconds &&
      value['recovered'] is bool &&
      value['previousLaunch'] is bool &&
      (value['stk'] == null ||
          (value['stk'] is String && (value['stk']! as String).isNotEmpty));
}
