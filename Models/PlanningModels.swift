import Foundation

/// Source of planning inputs; independent of Bluetooth hardware simulation.
enum PlanningDataMode: String, Codable, CaseIterable {
    case demo, live
}

struct SleepSummary: Codable, Equatable {
    var sleepStart: Date
    var sleepEnd: Date
    var totalAsleepMinutes: Int
    var averageHeartRateBPM: Double?
    /// .live means real source data; .demo means a fixture.
    var provenance: PlanningDataMode
}

struct CalendarEvent: Codable, Equatable, Identifiable {
    let id: String
    var title: String
    var start: Date
    var end: Date
    var isAllDay: Bool
    var timeZoneID: String?
    /// Only explicitly supplied metadata; never inferred from an event title.
    var destinationTimeZoneID: String?
}

struct DailyPlan: Codable, Equatable {
    /// Local start of the planned day in timeZoneID.
    var planDate: Date
    var timeZoneID: String
    var wake: Date
    var morningLightStart: Date
    var morningLightEnd: Date
    var caffeineCutoff: Date
    var windDown: Date
}

enum SheepyState: String, Codable, CaseIterable {
    case lively, sleepy, sleeping, drained
}

struct Quest: Codable, Equatable, Identifiable {
    let id: String
    var title: String
    var isCompleted: Bool
}
