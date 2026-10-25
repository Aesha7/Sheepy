import Foundation

/// Minimal preview fixtures for Person C; Person D can extend this catalog.
/// This supplies inputs only. It does not implement Person B's planning logic.
struct PlanningDemoInputs {
    let profile: SleepProfile
    let sleepSummary: SleepSummary
    let calendarEvents: [CalendarEvent]
    let sheepyState: SheepyState
    let quests: [Quest]

    static func make(referenceDate: Date, timeZone: TimeZone) -> PlanningDemoInputs {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let today = calendar.startOfDay(for: referenceDate)
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!
        let todayWake = calendar.date(bySettingHour: 7, minute: 0, second: 0, of: today)!
        // Before 7 AM, use yesterday's completed night rather than future sleep.
        let sleepEnd = todayWake <= referenceDate ? todayWake
            : calendar.date(byAdding: .day, value: -1, to: todayWake)!
        let commitment = calendar.date(bySettingHour: 7, minute: 0, second: 0, of: tomorrow)!
        return PlanningDemoInputs(
            profile: SleepProfile(preferredWakeHour: 7, preferredWakeMinute: 0,
                                  timeZoneID: timeZone.identifier, preparationMinutes: 60,
                                  targetSleepMinutes: 480),
            sleepSummary: SleepSummary(sleepStart: sleepEnd.addingTimeInterval(-8 * 60 * 60),
                                       sleepEnd: sleepEnd, totalAsleepMinutes: 480,
                                       averageHeartRateBPM: 58, provenance: .demo),
            calendarEvents: [CalendarEvent(id: "demo-tomorrow-7am", title: "Demo: 7 AM commitment",
                                           start: commitment, end: commitment.addingTimeInterval(3600),
                                           isAllDay: false, timeZoneID: timeZone.identifier,
                                           destinationTimeZoneID: nil)],
            sheepyState: .lively,
            quests: [Quest(id: "demo-morning-light", title: "Demo: Get morning light", isCompleted: false)])
    }
}
