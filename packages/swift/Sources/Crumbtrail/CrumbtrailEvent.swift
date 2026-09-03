import Foundation

/// The source runtime an event came from.
///
/// Native iOS always reports `.ios`. The other cases exist because this enum is
/// the shared vocabulary described in `docs/specs/native-sdk-wire-contract.md`,
/// and an SDK that decodes an event it did not emit must not choke on a value
/// another platform produced.
public enum CrumbtrailPlatform: String, Codable, Sendable {
    case web
    case reactNative = "react-native"
    case ios
    case android
    case flutter
    case webview
    case node
}

/// Identity of the SDK that produced an event.
public struct CrumbtrailSDKDescriptor: Codable, Equatable, Sendable {
    public let name: String
    public let version: String

    public init(name: String, version: String) {
        self.name = name
        self.version = version
    }
}

/// A normalised reference to a UI element.
///
/// At least one identifying key must be present or the descriptor must be
/// omitted entirely — a target made only of `bounds` identifies nothing and
/// costs payload on every event that carries it.
public struct CrumbtrailTarget: Codable, Equatable, Sendable {
    public struct Bounds: Codable, Equatable, Sendable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double

        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
    }

    public var role: String?
    public var label: String?
    public var testID: String?
    public var accessibilityId: String?
    public var componentName: String?
    public var routePath: String?
    public var ancestryHash: String?
    public var bounds: Bounds?

    public init(
        role: String? = nil,
        label: String? = nil,
        testID: String? = nil,
        accessibilityId: String? = nil,
        componentName: String? = nil,
        routePath: String? = nil,
        ancestryHash: String? = nil,
        bounds: Bounds? = nil
    ) {
        self.role = role
        self.label = label
        self.testID = testID
        self.accessibilityId = accessibilityId
        self.componentName = componentName
        self.routePath = routePath
        self.ancestryHash = ancestryHash
        self.bounds = bounds
    }

    /// True when the descriptor names something. A descriptor that fails this
    /// must not be attached to an event.
    public var identifiesSomething: Bool {
        role != nil || label != nil || testID != nil || accessibilityId != nil
            || componentName != nil || routePath != nil || ancestryHash != nil
    }
}

/// The shared event kinds. Free-form kinds are allowed via ``CrumbtrailEventKind/other(_:)``
/// but only these get cross-platform treatment on the ingest side.
public enum CrumbtrailEventKind: Equatable, Sendable {
    case error
    case rejection
    case console
    case network
    case networkStatus
    case environment
    case navigation
    case navigationIntent
    case appLifecycle
    case nativeCrash
    case nativeHang
    case viewSnapshot
    case other(String)

    public var wireValue: String {
        switch self {
        case .error: return "err"
        case .rejection: return "rej"
        case .console: return "con"
        case .network: return "net"
        case .networkStatus: return "net-status"
        case .environment: return "env"
        case .navigation: return "navigation"
        case .navigationIntent: return "nav-intent"
        case .appLifecycle: return "app-lifecycle"
        case .nativeCrash: return "native-crash"
        case .nativeHang: return "native-hang"
        case .viewSnapshot: return "view-snapshot"
        case .other(let raw): return raw
        }
    }
}

/// One captured event, in the shape ingest expects.
///
/// Field names are deliberately short (`t`, `k`, `d`): a session is thousands of
/// these, and the envelope is repeated on every one.
public struct CrumbtrailEvent: Equatable, Sendable {
    /// Unix timestamp in **milliseconds**. Seconds here would silently place
    /// every event in 1970 and break every correlation the product depends on.
    public var timestamp: Int64
    public var kind: CrumbtrailEventKind
    public var data: JSONValue
    public var platform: CrumbtrailPlatform
    public var sdk: CrumbtrailSDKDescriptor
    public var capabilities: [String]
    public var target: CrumbtrailTarget?

    public init(
        timestamp: Int64,
        kind: CrumbtrailEventKind,
        data: JSONValue,
        platform: CrumbtrailPlatform = .ios,
        sdk: CrumbtrailSDKDescriptor,
        capabilities: [String] = [],
        target: CrumbtrailTarget? = nil
    ) {
        self.timestamp = timestamp
        self.kind = kind
        self.data = data
        self.platform = platform
        self.sdk = sdk
        self.capabilities = capabilities
        // A target that identifies nothing is dropped rather than sent: it
        // would add bytes to every event and name no element.
        self.target = (target?.identifiesSomething ?? false) ? target : nil
    }
}

/// Current version of the shared event envelope.
public let crumbtrailSchemaVersion = 1

extension CrumbtrailEvent: Encodable {
    private enum CodingKeys: String, CodingKey {
        case t, k, d, schemaVersion, platform, sdk, capabilities, target
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(timestamp, forKey: .t)
        try container.encode(kind.wireValue, forKey: .k)
        try container.encode(data, forKey: .d)
        try container.encode(crumbtrailSchemaVersion, forKey: .schemaVersion)
        try container.encode(platform, forKey: .platform)
        try container.encode(sdk, forKey: .sdk)
        // Omitted rather than sent empty. An absent field and a present-but-empty
        // one mean different things on the ingest side.
        if !capabilities.isEmpty {
            try container.encode(capabilities, forKey: .capabilities)
        }
        try container.encodeIfPresent(target, forKey: .target)
    }
}
