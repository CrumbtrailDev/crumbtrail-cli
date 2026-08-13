import Foundation

#if canImport(UIKit)
import UIKit
#endif

extension CrumbtrailDeviceInfo {
    /// Read what the running platform will tell us.
    ///
    /// Everything here is non-identifying by construction. There is no
    /// `identifierForVendor`, no advertising id, and no serial: a device model
    /// and OS version explain a bug, whereas a device identifier only tracks a
    /// person, and shipping one would make this SDK a privacy liability in an
    /// app store review.
    public static func current(bundle: Bundle = .main) -> CrumbtrailDeviceInfo {
        let info = bundle.infoDictionary

        #if canImport(UIKit) && !os(macOS)
        let device = UIDevice.current
        return CrumbtrailDeviceInfo(
            model: hardwareIdentifier(),
            manufacturer: "Apple",
            os: device.systemName,
            osVersion: device.systemVersion,
            appId: bundle.bundleIdentifier,
            appVersion: info?["CFBundleShortVersionString"] as? String,
            appBuild: info?["CFBundleVersion"] as? String,
            locale: Locale.current.identifier
        )
        #else
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return CrumbtrailDeviceInfo(
            model: hardwareIdentifier(),
            manufacturer: "Apple",
            os: "macOS",
            osVersion: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
            appId: bundle.bundleIdentifier,
            appVersion: info?["CFBundleShortVersionString"] as? String,
            appBuild: info?["CFBundleVersion"] as? String,
            locale: Locale.current.identifier
        )
        #endif
    }

    /// The hardware string (`iPhone15,2`), not the marketing name.
    ///
    /// `UIDevice.model` answers "iPhone" for every iPhone ever made, which
    /// cannot distinguish a device that reproduces a bug from one that does not.
    /// The sysctl value is the specific model, and it is the one an engineer can
    /// actually go and test on.
    static func hardwareIdentifier() -> String? {
        var size = 0
        guard sysctlbyname("hw.machine", nil, &size, nil, 0) == 0, size > 0 else {
            return nil
        }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.machine", &buffer, &size, nil, 0) == 0 else {
            return nil
        }
        return String(cString: buffer)
    }
}
