import Foundation

// Standalone check runner for OfflineExplainer. Compile with -parse-as-library.

@main
enum ExplainCheck {
    static func main() {
        var checks = 0
        var failures = 0

        let zoneID = "America/Los_Angeles"
        let tz = TimeZone(identifier: zoneID)!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = tz
        let cal = calendar

        func equal(_ actual: String, _ expected: String, _ label: String) {
            checks += 1
            if actual != expected {
                failures += 1
                print("FAIL: \(label)")
                print("  expected: \(expected)")
                print("  actual:   \(actual)")
            }
        }

        func contains(_ text: String, _ part: String, _ label: String) {
            checks += 1
            if !text.contains(part) {
                failures += 1
                print("FAIL: \(label)")
                print("  missing:  \(part)")
                print("  actual:   \(text)")
            }
        }

        func lacks(_ text: String, _ part: String, _ label: String) {
            checks += 1
            if text.contains(part) {
                failures += 1
                print("FAIL: \(label)")
                print("  should not contain: \(part)")
                print("  actual:   \(text)")
            }
        }

        func at(_ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
            var c = DateComponents()
            c.year = 2026
            c.month = month
            c.day = day
            c.hour = hour
            c.minute = minute
            return cal.date(from: c)!
        }

        let profile = SleepProfile(preferredWakeHour: 7, preferredWakeMinute: 0,
                                   timeZoneID: zoneID, preparationMinutes: 60,
                                   targetSleepMinutes: 480)

        func sleep(_ minutes: Int) -> SleepSummary {
            let end = at(10, 25, 7)
            return SleepSummary(sleepStart: end.addingTimeInterval(-Double(minutes) * 60),
                                sleepEnd: end, totalAsleepMinutes: minutes,
                                averageHeartRateBPM: nil, provenance: .demo)
        }

        func event(_ id: String, _ start: Date, title: String = "Meeting",
                   dest: String? = nil) -> CalendarEvent {
            CalendarEvent(id: id, title: title, start: start,
                          end: start.addingTimeInterval(3600), isAllDay: false,
                          timeZoneID: zoneID, destinationTimeZoneID: dest)
        }

        let engine = PlanEngine()
        let explainer = OfflineExplainer()
        let wakeDay = at(10, 26, 15, 30)

        func explain(_ events: [CalendarEvent], sleep: SleepSummary?) -> String {
            let result = try! engine.makeResult(for: wakeDay, profile: profile,
                                                sleepSummary: sleep, events: events)
            return explainer.explain(result)
        }

        // 1. 7 AM meeting, normal night: exact text.
        let normal = explain([event("m", at(10, 26, 7))], sleep: sleep(480))
        equal(normal,
              "Your first commitment starts at 7:00 AM, so your plan wakes you at 6:00 AM to leave time to get ready. "
              + "Start winding down at 9:00 PM and aim to be in bed by 10:00 PM. "
              + "Have your last caffeine by 2:00 PM. "
              + "Get bright morning light between 6:30 AM and 7:00 AM.",
              "7 AM meeting, normal night")
        lacks(normal, "No sleep data", "normal night has sleep data")
        lacks(normal, "Last night was short", "normal night is not short")

        // 2. Bad night: wake fixed, evening earlier.
        let bad = explain([event("m", at(10, 26, 7))], sleep: sleep(330))
        contains(bad, "wakes you at 6:00 AM", "bad night: wake unchanged")
        contains(bad, "Last night was short", "bad night: mentions short night")
        contains(bad, "8 h 30 min", "bad night: sleep opportunity")
        contains(bad, "winding down at 8:30 PM", "bad night: wind-down 8:30 PM")
        contains(bad, "in bed by 9:30 PM", "bad night: bedtime 9:30 PM")
        contains(bad, "caffeine by 1:30 PM", "bad night: caffeine 1:30 PM")

        // 3. Flight uses flight wording; title text is never echoed.
        let flight = explain([event("f", at(10, 26, 7), title: "SECRET TITLE", dest: "Asia/Tokyo")],
                             sleep: sleep(480))
        contains(flight, "Your flight departs at 7:00 AM", "flight wording")
        lacks(flight, "SECRET", "event title is not echoed")

        // 4. No events and a non-binding early event.
        let none = explain([], sleep: sleep(480))
        contains(none, "Nothing on your calendar needs an earlier start", "no events")
        contains(none, "usual wake time of 7:00 AM", "no events: usual wake")
        lacks(none, "commitment", "no events: no commitment wording")

        let notBinding = explain([event("n", at(10, 26, 8, 30))], sleep: sleep(480))
        contains(notBinding, "Nothing on your calendar needs an earlier start", "non-binding early event")

        // 5. Missing sleep data.
        let missing = explain([event("m", at(10, 26, 7))], sleep: nil)
        contains(missing, "No sleep data was available", "missing sleep data")
        contains(missing, "wakes you at 6:00 AM", "missing sleep data: wake still computed")

        // 6. Deterministic.
        equal(explain([event("m", at(10, 26, 7))], sleep: sleep(480)), normal, "same input gives same text")

        print("\(checks) checks, \(failures) failures")
        exit(failures == 0 ? 0 : 1)
    }
}
