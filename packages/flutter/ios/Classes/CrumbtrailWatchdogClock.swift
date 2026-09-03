enum CrumbtrailWatchdogClock {
    static func elapsedMilliseconds(now: UInt64, heartbeat: UInt64) -> Int64 {
        Int64(min((now >= heartbeat ? now - heartbeat : 0) / 1_000_000, 86_400_000))
    }
}
