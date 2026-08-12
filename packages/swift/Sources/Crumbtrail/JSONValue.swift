import Foundation

/// A JSON value with a stable, deterministic encoding.
///
/// The event payload `d` is arbitrary JSON, and Swift has no built-in Codable
/// type for that. Using `[String: Any]` and `JSONSerialization` instead would
/// cost two things this SDK cannot give up:
///
///   1. **Determinism.** `JSONSerialization` gives no ordering guarantee across
///      runs, so a conformance test comparing against a shared fixture would be
///      flaky. This type sorts object keys, so the same value always produces
///      the same bytes.
///   2. **Type safety.** `Any` lets a non-encodable value reach the encoder and
///      throw at flush time — inside the transport, far from the collector that
///      actually built it, with a session already half sent.
public enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// Build an object, dropping keys whose value is nil.
    ///
    /// Dropping rather than encoding null is the contract's rule: an absent
    /// field and a null one are different claims, and only "we did not observe
    /// this" is usually true.
    public static func object(compacting pairs: [String: JSONValue?]) -> JSONValue {
        var result: [String: JSONValue] = [:]
        for (key, value) in pairs {
            guard let value, value != .null else { continue }
            result[key] = value
        }
        return .object(result)
    }
}

// MARK: - Ergonomic construction

extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension JSONValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension JSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int64) { self = .int(value) }
}

extension JSONValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) { self = .double(value) }
}

extension JSONValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }
}

extension JSONValue: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) { self = .null }
}

// MARK: - Coding

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}
