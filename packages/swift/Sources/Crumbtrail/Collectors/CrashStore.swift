import Foundation

/// Crash details written by a dying process and read by the next launch.
public struct CrumbtrailPendingCrash: Codable, Equatable, Sendable {
    public let message: String
    public let stack: String?
    public let signal: String?
    public let at: Int64

    public init(message: String, stack: String?, signal: String?, at: Int64) {
        self.message = message
        self.stack = stack
        self.signal = signal
        self.at = at
    }
}

/// On-disk handoff between a crashing process and the next launch.
///
/// A crash cannot report itself. By the time the uncaught-exception handler
/// runs, the process is unwinding and there is no chance of completing a network
/// round trip — so the handler writes to disk, and the next launch delivers it.
///
/// The file lives in Application Support rather than Caches, because the OS may
/// purge Caches under storage pressure and a crash report is exactly the thing
/// worth keeping when a device is short on space.
public enum CrumbtrailCrashStore {
    static let fileName = "crumbtrail-pending-crash.json"

    static func applicationSupportFileURL(named fileName: String) -> URL? {
        guard
            let directory = FileManager.default.urls(
                for: .applicationSupportDirectory, in: .userDomainMask
            ).first
        else { return nil }
        let folder = directory.appendingPathComponent("Crumbtrail", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: folder, withIntermediateDirectories: true
        )
        return folder.appendingPathComponent(fileName)
    }

    static var fileURL: URL? {
        applicationSupportFileURL(named: fileName)
    }

    /// Called from a crash handler. Everything is `try?`: throwing inside a
    /// dying process buys nothing and can turn a reportable crash into a hang.
    public static func writePending(message: String, stack: String?, signal: String?) {
        guard let url = fileURL else { return }
        let crash = CrumbtrailPendingCrash(
            message: crumbtrailBoundedDiagnosticText(message, maxCharacters: 1_024)
                ?? "uncaught exception",
            stack: crumbtrailBoundedDiagnosticText(stack),
            signal: crumbtrailBoundedDiagnosticText(signal, maxCharacters: 128),
            at: Int64(Date().timeIntervalSince1970 * 1000)
        )
        guard let data = try? JSONEncoder().encode(crash) else { return }
        try? data.write(to: url, options: .atomic)
    }

    public static func readPending() -> CrumbtrailPendingCrash? {
        guard
            let url = fileURL,
            let data = try? Data(contentsOf: url),
            let crash = try? JSONDecoder().decode(CrumbtrailPendingCrash.self, from: data)
        else { return nil }
        return crash
    }

    /// Clear before sending, not after.
    ///
    /// If delivery is what clears the file and delivery keeps failing, the same
    /// crash is re-reported on every launch forever. A crash reported once and
    /// occasionally lost is better than one that floods a session on repeat.
    public static func clearPending() {
        guard let url = fileURL else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
