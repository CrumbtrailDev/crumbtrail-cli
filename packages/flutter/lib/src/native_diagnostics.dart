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

class CrumbtrailNativeDiagnosticBatch {
  const CrumbtrailNativeDiagnosticBatch(
      {required this.token, required this.events});

  final String token;
  final List<CrumbtrailNativeDiagnosticEvent> events;
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

  CrumbtrailNativeCapabilities withEnabled(bool enabled) =>
      CrumbtrailNativeCapabilities(
        nativeDiagnostics: _withEnabled(nativeDiagnostics, enabled),
        nativeHang: _withEnabled(nativeHang, enabled),
        nativeCrash: _withEnabled(nativeCrash, enabled),
        appLifecycle: _withEnabled(appLifecycle, enabled),
      );
}

CrumbtrailNativeCapabilityDetail _withEnabled(
  CrumbtrailNativeCapabilityDetail detail,
  bool enabled,
) =>
    CrumbtrailNativeCapabilityDetail(
      supported: detail.supported,
      enabled: enabled && detail.enabled,
      observed: detail.observed,
    );

/// Platform seam for native diagnostics. Tests and platform implementations can
/// provide this without booting a native engine.
abstract interface class CrumbtrailNativeDiagnosticsPlatform {
  Future<CrumbtrailNativeCapabilities> getCapabilities();

  Future<CrumbtrailNativeDiagnosticBatch> drainDiagnostics();

  Future<bool> acknowledgeDiagnostics(String token);
}

/// Optional configuration seam for platform plugins that own native
/// collectors. The diagnostics platform still owns the required drain and
/// acknowledgment contract.
abstract interface class CrumbtrailNativeDiagnosticsConfigurable {
  Future<void> setEnabled(bool enabled);
}

/// Method channel implementation used by Android and iOS plugin registrants.
class MethodChannelCrumbtrailNativeDiagnostics
    implements
        CrumbtrailNativeDiagnosticsPlatform,
        CrumbtrailNativeDiagnosticsConfigurable {
  MethodChannelCrumbtrailNativeDiagnostics({MethodChannel? channel})
      : _channel =
            channel ?? const MethodChannel(crumbtrailNativeDiagnosticsChannel);

  final MethodChannel _channel;

  @override
  Future<void> setEnabled(bool enabled) async {
    try {
      await _channel.invokeMethod<void>('setEnabled', enabled);
    } on Object {
      // An unavailable plugin is represented by its capability response.
    }
  }

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
  Future<CrumbtrailNativeDiagnosticBatch> drainDiagnostics() async {
    try {
      final raw = await _channel.invokeMethod<Object?>('drainDiagnostics');
      if (raw is! Map || raw['token'] is! String || raw['events'] is! List) {
        return const CrumbtrailNativeDiagnosticBatch(token: '', events: []);
      }
      final parsed = (raw['events'] as List).map(_parseEvent).toList();
      if (parsed.any((event) => event == null)) {
        return const CrumbtrailNativeDiagnosticBatch(token: '', events: []);
      }
      final events =
          parsed.whereType<CrumbtrailNativeDiagnosticEvent>().toList();
      final token = raw['token'] as String;
      if (events.isNotEmpty && token.isEmpty) {
        return const CrumbtrailNativeDiagnosticBatch(token: '', events: []);
      }
      return CrumbtrailNativeDiagnosticBatch(token: token, events: events);
    } on Object {
      return const CrumbtrailNativeDiagnosticBatch(token: '', events: []);
    }
  }

  @override
  Future<bool> acknowledgeDiagnostics(String token) async {
    if (token.isEmpty) return false;
    try {
      return await _channel.invokeMethod<bool>(
              'acknowledgeDiagnostics', token) ==
          true;
    } on Object {
      return false;
    }
  }
}

typedef CrumbtrailHangAcceptance = FutureOr<bool> Function(
    Map<String, Object?> event);

/// The complete durable handoff lifecycle. A custom implementation must
/// serialize each primitive so its durable write, host acceptance callback, and
/// compare-and-clear cannot be reordered by another operation.
abstract interface class CrumbtrailDartHangHandoff {
  Future<bool> deliver(
      Map<String, Object?> event, CrumbtrailHangAcceptance accept);

  Future<bool> drain(CrumbtrailHangAcceptance accept);
}

Future<bool> _safeAccept(
    CrumbtrailHangAcceptance accept, Map<String, Object?> event) async {
  try {
    return await accept(event) == true;
  } on Object {
    return false;
  }
}

class MemoryCrumbtrailDartHangHandoff implements CrumbtrailDartHangHandoff {
  Map<String, Object?>? _pending;
  Future<void> _tail = Future<void>.value();

  @override
  Future<bool> deliver(
      Map<String, Object?> event, CrumbtrailHangAcceptance accept) {
    return _enqueue(() async {
      final durable = _boundedEvent(event);
      _pending = durable;
      if (!await _safeAccept(accept, durable)) return false;
      if (_pending == null || !_sameHangData(_pending!, durable)) return false;
      _pending = null;
      return true;
    });
  }

  @override
  Future<bool> drain(CrumbtrailHangAcceptance accept) {
    return _enqueue(() async {
      final durable = _pending;
      if (durable == null) {
        return false;
      }
      if (!await _safeAccept(accept, {
        ...durable,
        'recovered': false,
        'previousLaunch': true,
      })) {
        return false;
      }
      if (_pending == null || !_sameHangData(_pending!, durable)) {
        return false;
      }
      _pending = null;
      return true;
    });
  }

  Future<bool> _enqueue(Future<bool> Function() operation) {
    final next =
        _tail.then<bool>((_) => operation(), onError: (_) => operation());
    _tail = next.then<void>((_) {}, onError: (_) {});
    return next;
  }
}

class SharedPreferencesDartHangHandoff implements CrumbtrailDartHangHandoff {
  SharedPreferencesDartHangHandoff(
    this.preferences, {
    this.key = 'crumbtrail.dart.native-hang',
  });

  final SharedPreferences preferences;
  final String key;
  Future<void> _pendingOperation = Future<void>.value();

  @override
  Future<bool> deliver(
      Map<String, Object?> event, CrumbtrailHangAcceptance accept) {
    return _enqueue(() async {
      final durable = _boundedEvent(event);
      final encoded = jsonEncode(durable);
      if (!await preferences.setString(key, encoded)) return false;
      if (!await _safeAccept(accept, durable)) return false;
      return _clearIfCurrent(encoded);
    });
  }

  @override
  Future<bool> drain(CrumbtrailHangAcceptance accept) {
    return _enqueue(() async {
      final raw = preferences.getString(key);
      if (raw == null || raw.isEmpty) {
        return false;
      }
      final value = _safeParseHang(raw);
      if (value == null) {
        return false;
      }
      if (!await _safeAccept(accept, {
        ...value,
        'recovered': false,
        'previousLaunch': true,
      })) {
        return false;
      }
      if (preferences.getString(key) != raw) {
        return false;
      }
      return preferences.remove(key);
    });
  }

  Future<bool> _enqueue(Future<bool> Function() operation) {
    final next = _pendingOperation.then<bool>(
      (_) => operation(),
      onError: (_) => operation(),
    );
    _pendingOperation = next.then<void>((_) {}, onError: (_) {});
    return next;
  }

  Future<bool> _clearIfCurrent(String expected) async {
    if (preferences.getString(key) != expected) return false;
    try {
      return await preferences.remove(key);
    } on Object {
      return false;
    }
  }

  Map<String, Object?>? _safeParseHang(String raw) {
    try {
      final value = jsonDecode(raw);
      return value is Map ? _parseHangData(value) : null;
    } on Object {
      return null;
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
    this.monotonicNow,
    bool Function()? debuggerAttached,
    this.suppressInDebug = true,
  })  : _now = now,
        _debuggerAttached = debuggerAttached ?? (() => false);

  final CrumbtrailHangAcceptance onHang;
  final CrumbtrailDartHangHandoff? handoff;
  final Duration threshold;
  final Duration checkInterval;
  final DateTime Function()? _now;
  final Duration Function()? monotonicNow;
  final bool Function() _debuggerAttached;
  final bool suppressInDebug;
  final Stopwatch _monotonicClock = Stopwatch()..start();
  DateTime? _clockOrigin;

  Timer? _timer;
  Duration? _lastTick;
  bool _foreground = true;
  bool _reportedForBlock = false;
  bool _stopped = false;
  final Set<Future<void>> _inFlight = <Future<void>>{};

  /// Starts the watchdog and imports one bounded prior-launch handoff.
  void start({bool foreground = true}) {
    if (_stopped) return;
    _foreground = foreground;
    _lastTick = _clockNow();
    final currentHandoff = handoff;
    if (currentHandoff != null) {
      _track(currentHandoff.drain((event) => _accept({
            ...event,
            'recovered': false,
            'previousLaunch': true,
          })));
    }
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
    _lastTick = _clockNow();
  }

  void resume() {
    if (_stopped) return;
    _foreground = true;
    _reportedForBlock = false;
    _lastTick = _clockNow();
  }

  Future<void> stop() async {
    if (_stopped) {
      await Future.wait(_inFlight);
      return;
    }
    _stopped = true;
    _timer?.cancel();
    _timer = null;
    await Future.wait(_inFlight);
  }

  bool get _isSuppressed {
    try {
      return _debuggerAttached() || (suppressInDebug && kDebugMode);
    } on Object {
      return true;
    }
  }

  void _tick() {
    final current = _clockNow();
    final elapsed = current - (_lastTick ?? current);
    _lastTick = current;
    if (!_foreground || _isSuppressed) {
      _reportedForBlock = false;
      return;
    }
    final blocked = elapsed - checkInterval;
    if (blocked < threshold) {
      _reportedForBlock = false;
      return;
    }
    if (_reportedForBlock) return;
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
    _track(_persistAndEmit(data));
  }

  Future<bool> _persistAndEmit(Map<String, Object?> data) async {
    final currentHandoff = handoff;
    if (currentHandoff == null) {
      return _accept(data);
    }
    try {
      return await currentHandoff.deliver(data, _accept);
    } on Object {
      // A storage failure is isolated from the host.
      return false;
    }
  }

  Duration _clockNow() {
    if (monotonicNow != null) return monotonicNow!();
    if (_now != null) {
      final current = _now();
      _clockOrigin ??= current;
      return current.difference(_clockOrigin!);
    }
    return _monotonicClock.elapsed;
  }

  Future<bool> _accept(Map<String, Object?> data) async {
    if (_stopped) return false;
    try {
      final accepted = await onHang(data) == true;
      return !_stopped && accepted;
    } on Object {
      return false;
    }
  }

  void _track(Future<bool> operation) {
    final pending = operation.then<void>((_) {}, onError: (_) {});
    _inFlight.add(pending);
    unawaited(pending.whenComplete(() => _inFlight.remove(pending)));
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

bool _sameHangData(Map<String, Object?>? left, Map<String, Object?> right) {
  if (left == null) return false;
  return left['source'] == right['source'] &&
      left['thresholdMs'] == right['thresholdMs'] &&
      left['observedDurationMs'] == right['observedDurationMs'] &&
      left['recovered'] == right['recovered'] &&
      left['previousLaunch'] == right['previousLaunch'] &&
      left['stk'] == right['stk'];
}
