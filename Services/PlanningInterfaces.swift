import Foundation

/// Implementations own authorization and source access. No fabricated live data.
@MainActor
protocol SleepProviding {
    var dataMode: PlanningDataMode { get }
    /// Most recent available sleep summary ending on or before the reference date.
    /// nil means no available sleep data, not a provider failure.
    func sleepSummary(before referenceDate: Date) async throws -> SleepSummary?
}

@MainActor
protocol CalendarProviding {
    var dataMode: PlanningDataMode { get }
    /// Events overlapping the half-open interval [start, end), including all-day events.
    func events(in interval: DateInterval) async throws -> [CalendarEvent]
}

/// Person B's pure, synchronous planner. Use profile.timeZoneID for local-day
/// calculations; derive no inputs from Date(), Calendar.current, UI, or services.
/// Implementations validate preferences and throw for invalid input.
protocol PlanGenerating {
    func generatePlan(for planDate: Date, profile: SleepProfile,
                      sleepSummary: SleepSummary?, events: [CalendarEvent]) throws -> DailyPlan
}
