import 'dart:convert';
import 'dart:math';

/// A session id plus when it was last active, in Unix milliseconds.
class PersistedSession {
  const PersistedSession({required this.id, required this.lastActivity});

  final String id;
  final int lastActivity;

  Map<String, Object?> toJson() => {'id': id, 'lastActivity': lastActivity};

  static PersistedSession? tryParse(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final id = decoded['id'];
      // A store written by an older SDK, or corrupted on disk, must start a
      // fresh session rather than throw during app startup.
      if (id is! String || id.isEmpty) return null;
      final lastActivity = decoded['lastActivity'];
      return PersistedSession(
        id: id,
        lastActivity: lastActivity is int ? lastActivity : 0,
      );
    } on FormatException {
      return null;
    }
  }
}

/// Where a session id survives between launches.
abstract class CrumbtrailSessionStore {
  PersistedSession? read();
  void write(PersistedSession session);
  void clear();
}

/// In-memory store, for tests and for a host that opts out of persistence.
class MemorySessionStore implements CrumbtrailSessionStore {
  MemorySessionStore([this._session]);

  PersistedSession? _session;

  @override
  PersistedSession? read() => _session;

  @override
  void write(PersistedSession session) => _session = session;

  @override
  void clear() => _session = null;
}

/// Decides whether to resume a persisted session or mint a new one.
///
/// The rule is subtle enough that it is the part most worth testing: resuming
/// unconditionally stitches today's bug onto last week's timeline, while never
/// resuming turns a user's week of once-a-day intermittent reports into
/// unrelated single-event sessions — exactly the recurrence signal the product
/// exists to surface.
class CrumbtrailSessionResolver {
  const CrumbtrailSessionResolver._();

  static PersistedSession resolve({
    required CrumbtrailSessionStore store,
    required int idleMs,
    required int now,
    String Function()? mint,
  }) {
    final persisted = store.read();
    if (persisted != null && now - persisted.lastActivity <= idleMs) {
      final refreshed =
          PersistedSession(id: persisted.id, lastActivity: now);
      store.write(refreshed);
      return refreshed;
    }
    final fresh = PersistedSession(
      id: (mint ?? () => mintSessionId(now))(),
      lastActivity: now,
    );
    store.write(fresh);
    return fresh;
  }

  /// Same shape as the other SDKs: `ses_<date>_<time>_<random>`.
  static String mintSessionId([int? nowMs]) {
    final now = DateTime.fromMillisecondsSinceEpoch(
      nowMs ?? DateTime.now().millisecondsSinceEpoch,
      isUtc: true,
    );
    String two(int value) => value.toString().padLeft(2, '0');
    final stamp = '${now.year}${two(now.month)}${two(now.day)}'
        '_${two(now.hour)}${two(now.minute)}${two(now.second)}';
    final random = Random();
    final suffix = List.generate(
      12,
      (_) => '0123456789abcdef'[random.nextInt(16)],
    ).join();
    return 'ses_${stamp}_$suffix';
  }
}
