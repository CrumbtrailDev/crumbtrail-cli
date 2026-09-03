import Flutter
import Foundation
import UIKit

/// Optional iOS half of the Flutter diagnostics channel.
///
/// The plugin stores only bounded local evidence. Dart owns the Crumbtrail
/// event queue and transport, so this layer remains safe when Flutter is
/// unavailable or the channel is called during teardown.
public final class CrumbtrailFlutterPlugin: NSObject, FlutterPlugin {
    private static let channelName = "ai.crumbtrail/native_diagnostics"
    private static let pendingKey = "native-diagnostics"
    private static let preferencesSuite = "ai.crumbtrail.flutter"
    private static let maxPendingEvents = 32
    private static let maxTextCharacters = 8_192
    private static let hangThresholdMilliseconds: Int64 = 5_000

    private let defaults: UserDefaults
    private var observerTokens: [NSObjectProtocol] = []
    private var watchdogTimer: DispatchSourceTimer?
    private var lastHeartbeat = DispatchTime.now().uptimeNanoseconds
    private var watchdogPending = false
    private var previousExceptionHandler: (@convention(c) (NSException) -> Void)?

    private static weak var activePlugin: CrumbtrailFlutterPlugin?
    private static var activeExceptionHandler: (@convention(c) (NSException) -> Void)?

    override public init() {
        defaults = UserDefaults(suiteName: Self.preferencesSuite) ?? .standard
        super.init()
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let instance = CrumbtrailFlutterPlugin()
        let channel = FlutterMethodChannel(
            name: channelName,
            binaryMessenger: registrar.messenger()
        )
        registrar.addMethodCallDelegate(instance, channel: channel)
        instance.installCollectors()
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "getCapabilities":
            result(capabilities())
        case "drainDiagnostics":
            result(drainDiagnostics())
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    private func capabilities() -> [String: [String: Bool]] {
        [
            "nativeDiagnostics": capability(),
            "nativeHang": capability(),
            "nativeCrash": capability(),
            "appLifecycle": capability(),
        ]
    }

    private func capability() -> [String: Bool] {
        ["supported": true, "enabled": true, "observed": false]
    }

    private func installCollectors() {
        Self.activePlugin = self
        Self.activeExceptionHandler = { exception in
            guard let plugin = Self.activePlugin else { return }
            plugin.appendPending(
                kind: "native-crash",
                data: [
                    "msg": plugin.bounded(exception.reason ?? exception.name.rawValue),
                    "stk": plugin.bounded(exception.callStackSymbols.joined(separator: "\n")),
                    "signal": plugin.bounded(exception.name.rawValue),
                    "source": "previous-launch",
                ]
            )
            plugin.previousExceptionHandler?(exception)
        }
        previousExceptionHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler(Self.activeExceptionHandler)

        let center = NotificationCenter.default
        let notifications: [(Notification.Name, String)] = [
            (UIApplication.didBecomeActiveNotification, "active"),
            (UIApplication.willResignActiveNotification, "inactive"),
            (UIApplication.didEnterBackgroundNotification, "background"),
            (UIApplication.willEnterForegroundNotification, "foreground"),
            (UIApplication.didReceiveMemoryWarningNotification, "memory-warning"),
        ]
        for (name, state) in notifications {
            observerTokens.append(
                center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.appendPending(
                        kind: "app-lifecycle",
                        data: ["state": state, "source": "uiapplication"]
                    )
                }
            )
        }
        startWatchdog()
    }

    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(
            deadline: .now() + .milliseconds(1_000),
            repeating: .milliseconds(1_000)
        )
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let now = DispatchTime.now().uptimeNanoseconds
            let elapsed = Int64((now - self.lastHeartbeat) / 1_000_000)
            if elapsed > Self.hangThresholdMilliseconds,
               !self.watchdogPending,
               !CrumbtrailFlutterPlugin.debuggerAttached {
                self.watchdogPending = true
                self.appendPending(
                    kind: "native-hang",
                    data: [
                        "source": "main-thread",
                        "thresholdMs": Self.hangThresholdMilliseconds,
                        "observedDurationMs": min(elapsed, 86_400_000),
                        "recovered": false,
                        "previousLaunch": false,
                    ]
                )
            }
            DispatchQueue.main.async { [weak self] in
                self?.lastHeartbeat = DispatchTime.now().uptimeNanoseconds
            }
        }
        watchdogTimer = timer
        timer.resume()
    }

    private static var debuggerAttached: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    private func drainDiagnostics() -> [[String: Any]] {
        guard let raw = defaults.array(forKey: Self.pendingKey) else { return [] }
        defaults.removeObject(forKey: Self.pendingKey)
        return raw.compactMap { value in
            guard let item = value as? [String: Any],
                  let kind = item["kind"] as? String,
                  let data = item["data"] as? [String: Any] else { return nil }
            return ["kind": kind, "data": data]
        }
    }

    private func appendPending(kind: String, data: [String: Any]) {
        var events = (defaults.array(forKey: Self.pendingKey) as? [[String: Any]]) ?? []
        while events.count >= Self.maxPendingEvents { events.removeFirst() }
        events.append(["kind": kind, "data": data.reduce(into: [String: Any]()) { result, item in
            guard item.key.count <= 64 else { return }
            if let text = item.value as? String {
                result[item.key] = bounded(text)
            } else if item.value is NSNumber {
                result[item.key] = item.value
            }
        }])
        defaults.set(events, forKey: Self.pendingKey)
    }

    private func bounded(_ value: String) -> String {
        String(value.prefix(Self.maxTextCharacters))
    }

    deinit {
        watchdogTimer?.cancel()
        for token in observerTokens { NotificationCenter.default.removeObserver(token) }
        if Self.activePlugin === self {
            NSSetUncaughtExceptionHandler(previousExceptionHandler)
            Self.activePlugin = nil
            Self.activeExceptionHandler = nil
        }
    }
}
