import Foundation

@main
struct HealthSleepChecks {
    static func main() {
        let zone = TimeZone(secondsFromGMT: 0)!
        let day = ISO8601DateFormatter().date(from: "2026-10-24T00:00:00Z")!
        func date(_ hour: Double) -> Date { day.addingTimeInterval(hour * 3600) }
        func segment(_ start: Double, _ end: Double, _ source: String = "watch") -> SleepSessionProcessor.Segment {
            .init(source: source, start: date(start), end: date(end))
        }
        func select(_ samples: [SleepSessionProcessor.Segment], before: Double = 12) -> SleepSessionProcessor.Session? {
            SleepSessionProcessor.select(samples, before: date(before), since: date(-14 * 24), timeZone: zone)
        }
        precondition(select([]) == nil)
        let session = select([segment(-1, 3), segment(2, 7), segment(-1, 7), segment(-1, 8, "other")])!
        precondition(session.source == "other") // latest completed source; never combine sources
        let merged = select([segment(-1, 3), segment(2, 7), segment(-1, 7)])!
        precondition(merged.intervals.count == 1 && merged.seconds == 8 * 3600)
        let summary = SleepSessionProcessor.summary(merged, heart: [])
        precondition(summary.totalAsleepMinutes == 480 && summary.averageHeartRateBPM == nil)
        precondition(summary.provenance == .live)
        let nights = select([segment(-25, -17), segment(-1, 7)])!
        precondition(nights.start == date(-1) && nights.end == date(7))
        let boundary = select([segment(-25, -17), segment(-1, 7)], before: 6)!
        precondition(boundary.end == date(-17)) // no partial current night
        precondition(select([segment(-1, 7)], before: 7)?.end == date(7))
        precondition(select([segment(8, 11)]) == nil) // daytime nap
        precondition(select([segment(-340, -332)]) == nil) // older than lookback
        let gaps = select([segment(-1, 2), segment(3, 7)])!
        precondition(gaps.intervals.count == 2)
        let heart: [SleepSessionProcessor.HeartReading] = [
            .init(source: "watch", date: date(0), bpm: 50),
            .init(source: "watch", date: date(4), bpm: 70),
            .init(source: "watch", date: date(2.5), bpm: 200), // awake gap
            .init(source: "watch", date: date(7), bpm: 200), // excluded end
            .init(source: "other", date: date(4), bpm: 100)]
        precondition(SleepSessionProcessor.summary(gaps, heart: heart).averageHeartRateBPM == 60)
        var requests = PlanningRequests()
        let calendar = requests.begin(.calendar)
        let health = requests.begin(.health)
        requests.fail("Calendar failed", token: calendar, provider: .calendar)
        requests.finish(calendar)
        precondition(requests.loading && requests.error == "Calendar failed")
        requests.finish(health)
        precondition(!requests.loading && requests.error == "Calendar failed")
        let old = requests.begin(.health)
        requests.reset()
        let new = requests.begin(.health)
        requests.fail("stale", token: old, provider: .health)
        requests.finish(old)
        precondition(requests.loading && requests.error == nil)
        precondition(!requests.isCurrent(old, for: .health) && requests.isCurrent(new, for: .health))
        print("Health sleep and concurrent request checks passed")
    }
}
