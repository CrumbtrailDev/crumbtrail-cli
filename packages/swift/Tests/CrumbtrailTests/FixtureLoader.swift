import Foundation
import XCTest

/// Reads the shared wire-contract fixtures from the repo root.
///
/// Deliberately NOT a bundled SwiftPM resource. A copied fixture set is a second
/// source of truth, and the whole reason these fixtures exist is to catch drift
/// between the Swift, Kotlin and Dart SDKs — which a per-SDK copy would hide.
/// Walking up from `#filePath` reads the one canonical set.
enum FixtureLoader {
    static var wireContractDirectory: URL {
        // .../packages/swift/Tests/CrumbtrailTests/FixtureLoader.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }  // -> packages/
        url.deleteLastPathComponent()  // -> repo root
        return url
            .appendingPathComponent("test-fixtures")
            .appendingPathComponent("wire-contract")
    }

    static func event(_ name: String) throws -> [String: Any] {
        let url = wireContractDirectory
            .appendingPathComponent("events")
            .appendingPathComponent("\(name).json")
        let data = try Data(contentsOf: url)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw NSError(
                domain: "FixtureLoader", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "\(name).json is not an object"]
            )
        }
        return object
    }

    static func transport() throws -> [String: Any] {
        let url = wireContractDirectory.appendingPathComponent("transport.json")
        let data = try Data(contentsOf: url)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    /// Encode a value and read it back as a plain dictionary, so a test can
    /// compare against a fixture without depending on key order.
    static func encodeToDictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }
}

/// Compare two JSON-shaped dictionaries, reporting the first difference by path.
///
/// `NSDictionary.isEqual` would answer the same question, but its failure output
/// is two whole objects printed side by side. When a conformance test fails, the
/// useful information is which key diverged.
func assertJSONEqual(
    _ actual: [String: Any],
    _ expected: [String: Any],
    path: String = "",
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let actualKeys = Set(actual.keys)
    let expectedKeys = Set(expected.keys)

    for missing in expectedKeys.subtracting(actualKeys).sorted() {
        XCTFail("missing key \(path)\(missing)", file: file, line: line)
    }
    for extra in actualKeys.subtracting(expectedKeys).sorted() {
        XCTFail("unexpected key \(path)\(extra)", file: file, line: line)
    }

    for key in expectedKeys.intersection(actualKeys).sorted() {
        let lhs = actual[key]!
        let rhs = expected[key]!
        if let lhsDict = lhs as? [String: Any], let rhsDict = rhs as? [String: Any] {
            assertJSONEqual(lhsDict, rhsDict, path: "\(path)\(key).", file: file, line: line)
        } else if !NSObject.isJSONEqual(lhs, rhs) {
            XCTFail(
                "at \(path)\(key): got \(lhs), expected \(rhs)",
                file: file, line: line
            )
        }
    }
}

extension NSObject {
    static func isJSONEqual(_ lhs: Any, _ rhs: Any) -> Bool {
        // Numeric literals round-trip through JSON as NSNumber, so 402 read from
        // a fixture and 402 encoded from an Int64 must compare equal despite
        // arriving as different Swift types.
        if let l = lhs as? NSNumber, let r = rhs as? NSNumber { return l == r }
        if let l = lhs as? String, let r = rhs as? String { return l == r }
        if let l = lhs as? [Any], let r = rhs as? [Any] {
            guard l.count == r.count else { return false }
            return zip(l, r).allSatisfy { isJSONEqual($0, $1) }
        }
        return (lhs as? NSObject)?.isEqual(rhs as? NSObject) ?? false
    }
}
