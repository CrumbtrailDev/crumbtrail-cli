import 'package:flutter/widgets.dart';

import 'crumbtrail.dart';
import 'event.dart';

/// Records screen changes as `navigation` events.
///
/// A `NavigatorObserver` rather than anything cleverer, because it is the one
/// hook that works identically for the imperative `Navigator` API, `go_router`,
/// `auto_route` and every other router — they all drive the same Navigator
/// underneath. An SDK that integrated with one router by name would silently
/// capture nothing for apps using another.
///
/// Observes only. It never pushes, pops or rewrites a route: a telemetry SDK
/// that changes navigation behaviour is a bug factory.
class CrumbtrailNavigatorObserver extends NavigatorObserver {
  CrumbtrailNavigatorObserver({Crumbtrail? logger}) : _logger = logger;

  final Crumbtrail? _logger;

  Crumbtrail? get _target => _logger ?? Crumbtrail.instance;

  void _record(String action, Route<dynamic>? route, Route<dynamic>? previous) {
    final logger = _target;
    if (logger == null) return;
    logger.addEvent(
      CrumbtrailEventKind.navigation,
      compactJson({
        'action': action,
        'name': _describe(route),
        'path': route?.settings.name,
        'from': _describe(previous),
        'source': 'navigator-observer',
      }),
    );
  }

  /// Prefer the route's declared name, falling back to its runtime type.
  ///
  /// An anonymous `MaterialPageRoute` has no name at all, and "MaterialPageRoute"
  /// at least distinguishes a page push from a dialog or a modal sheet — which
  /// is usually the distinction that matters when reading a timeline.
  String? _describe(Route<dynamic>? route) {
    if (route == null) return null;
    final name = route.settings.name;
    if (name != null && name.isNotEmpty) return name;
    return route.runtimeType.toString();
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _record('push', route, previousRoute);
    super.didPush(route, previousRoute);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    // The route being popped is the one leaving; `previousRoute` is what the
    // user ends up looking at, so it is reported as the destination.
    _record('pop', previousRoute, route);
    super.didPop(route, previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    _record('replace', newRoute, oldRoute);
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _record('remove', previousRoute, route);
    super.didRemove(route, previousRoute);
  }
}
