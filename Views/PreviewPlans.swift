import Foundation

// Preview-only plans so the timeline can be seen before Person B's planner is connected.
// These are fixed sample values, not planning logic; the app never shows them.
enum PreviewPlans {
    static func result() -> PlanResult {
        let reference = Date(timeIntervalSince1970: 1_792_868_400)
        let zone = TimeZone(identifier: "America/Los_Angeles")!
        let demo = PlanningDemoInputs.make(referenceDate: reference, timeZone: zone)
        return try! PlanEngine().makeResult(for: demo.calendarEvents[0].start, profile: demo.profile,
                                            sleepSummary: demo.sleepSummary, events: demo.calendarEvents)
    }

    static func normal(timeZone: TimeZone = .current, now: Date = .now) -> DailyPlan {
        plan(windDown: (22, 0), caffeine: (14, 0), timeZone: timeZone, now: now)
    }

    /// Same wake and light; earlier wind-down and caffeine cutoff.
    static func badNight(timeZone: TimeZone = .current, now: Date = .now) -> DailyPlan {
        plan(windDown: (21, 15), caffeine: (13, 0), timeZone: timeZone, now: now)
    }

    private static func plan(windDown: (Int, Int), caffeine: (Int, Int), timeZone: TimeZone, now: Date) -> DailyPlan {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let today = cal.startOfDay(for: now)
        let tomorrow = cal.date(byAdding: .day, value: 1, to: today)!
        func at(_ day: Date, _ hm: (Int, Int)) -> Date {
            cal.date(bySettingHour: hm.0, minute: hm.1, second: 0, of: day)!
        }
        return DailyPlan(planDate: tomorrow, timeZoneID: timeZone.identifier,
                         wake: at(tomorrow, (5, 45)),
                         morningLightStart: at(tomorrow, (6, 0)), morningLightEnd: at(tomorrow, (6, 30)),
                         caffeineCutoff: at(tomorrow, caffeine),
                         windDown: at(today, windDown))
    }
}
