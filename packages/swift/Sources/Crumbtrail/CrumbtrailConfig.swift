import Foundation

/// Which collectors are running.
public struct CrumbtrailCollectors: Equatable, Sendable {
    public var errors: Bool
    public var network: Bool
    public var appLifecycle: Bool
    public var navigation: Bool
    public var environment: Bool
    public var console: Bool
    /// Foreground main thread watchdog with a five second threshold.
    public var nativeWatchdog: Bool
    /// MetricKit diagnostics and previous launch hang handoff.
    public var nativeDiagnostics: Bool

    public init(
        errors: Bool = true,
        network: Bool = true,
        appLifecycle: Bool = true,
        navigation: Bool = true,
        environment: Bool = true,
        console: Bool = true,
        nativeWatchdog: Bool = true,
        nativeDiagnostics: Bool = true
    ) {
        self.errors = errors
        self.network = network
        self.appLifecycle = appLifecycle
        self.navigation = navigation
        self.environment = environment
        self.console = console
        self.nativeWatchdog = nativeWatchdog
        self.nativeDiagnostics = nativeDiagnostics
    }

    public static let all = CrumbtrailCollectors()
    public static let none = CrumbtrailCollectors(
        errors: false, network: false, appLifecycle: false,
        navigation: false, environment: false, console: false,
        nativeWatchdog: false, nativeDiagnostics: false
    )
}

public struct CrumbtrailConfig: Sendable {
    /// Base URL of the ingest endpoint, without a trailing slash.
    public var endpoint: String
    /// The ingest key (`ctkey_`). Write only by design.
    public var ingestKey: String?
    /// Which app in the project this is. One key covers a whole project, so
    /// without a service name every app in it ingests as an anonymous sender.
    public var service: String?
    /// How long a session may sit idle and still be resumed on next launch.
    public var sessionIdleMs: Int64
    /// Maximum events buffered before the oldest are dropped.
    public var queueCapacity: Int
    /// How many events accumulate before an automatic flush.
    public var flushBatchSize: Int
    /// Longest an event waits before being flushed anyway.
    public var flushIntervalSeconds: TimeInterval
    public var collectors: CrumbtrailCollectors

    public init(
        endpoint: String,
        ingestKey: String? = nil,
        service: String? = nil,
        // Thirty minutes matches the browser SDK. Long enough that a user who
        // backgrounds the app to read an email resumes the same session; short
        // enough that yesterday's session is never stitched onto today's bug.
        sessionIdleMs: Int64 = 30 * 60 * 1000,
        queueCapacity: Int = 2000,
        flushBatchSize: Int = 50,
        flushIntervalSeconds: TimeInterval = 10,
        collectors: CrumbtrailCollectors = .all
    ) {
        self.endpoint = endpoint
        self.ingestKey = ingestKey
        self.service = service
        self.sessionIdleMs = sessionIdleMs
        self.queueCapacity = queueCapacity
        self.flushBatchSize = flushBatchSize
        self.flushIntervalSeconds = flushIntervalSeconds
        self.collectors = collectors
    }
}

/// Facts about the running app and device, used for the session metadata and
/// the startup `env` snapshot.
public struct CrumbtrailDeviceInfo: Equatable, Sendable {
    public var model: String?
    public var manufacturer: String?
    public var os: String?
    public var osVersion: String?
    public var appId: String?
    public var appVersion: String?
    public var appBuild: String?
    public var locale: String?

    public init(
        model: String? = nil,
        manufacturer: String? = nil,
        os: String? = nil,
        osVersion: String? = nil,
        appId: String? = nil,
        appVersion: String? = nil,
        appBuild: String? = nil,
        locale: String? = nil
    ) {
        self.model = model
        self.manufacturer = manufacturer
        self.os = os
        self.osVersion = osVersion
        self.appId = appId
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.locale = locale
    }

    /// The `device` object for session metadata and the `env` snapshot. Unknown
    /// fields are omitted rather than sent blank: an absent field and an empty
    /// string are different claims, and only the first one is honest.
    public var deviceJSON: JSONValue {
        .object(compacting: [
            "model": model.map(JSONValue.string),
            "manufacturer": manufacturer.map(JSONValue.string),
            "os": os.map(JSONValue.string),
            "osVersion": osVersion.map(JSONValue.string),
        ])
    }

    public var appJSON: JSONValue {
        .object(compacting: [
            "id": appId.map(JSONValue.string),
            "version": appVersion.map(JSONValue.string),
            "build": appBuild.map(JSONValue.string),
        ])
    }
}
