import Foundation

enum PlannerError: Error, Equatable, LocalizedError {
    case invalidTimeZone(String)
    case invalidWakeTime(hour: Int, minute: Int)
    case invalidPreparationMinutes(Int)
    case invalidTargetSleepMinutes(Int)
    case dateComputationFailed

    var errorDescription: String? {
        switch self {
        case .invalidTimeZone(let id):
            return "Unknown time zone identifier: \(id)."
        case .invalidWakeTime(let hour, let minute):
            return "Preferred wake time \(hour):\(minute) is out of range."
        case .invalidPreparationMinutes(let value):
            return "Preparation minutes must be between 1 and 1440 (got \(value))."
        case .invalidTargetSleepMinutes(let value):
            return "Target sleep minutes must be between 1 and 1440 (got \(value))."
        case .dateComputationFailed:
            return "Could not compute the plan dates for this day and time zone."
        }
    }
}

/// Prototype demo rules. These are NOT medically validated recommendations.
struct PlannerConfig: Equatable {
    /// Timed events starting before this local hour count as early commitments.
    var earlyCutoffHour = 9
    /// Last night's sleep under this many minutes counts as a bad night.
    var badNightThresholdMinutes = 360
    /// Extra sleep opportunity after a bad night; wake time stays fixed.
    var badNightExtraSleepMinutes = 30
    /// Morning light starts this long after waking.
    var lightStartDelayMinutes = 30
    /// Length of the morning light window.
    var lightWindowMinutes = 30
    /// Caffeine cutoff is this many minutes before planned bedtime (8 hours).
    var caffeineCutoffMinutesBeforeBed = 480
    /// Wind-down starts this many minutes before planned bedtime.
    var windDownMinutesBeforeBed = 60
}

/// A plan plus the facts needed to explain it. `DailyPlan` has no field for
/// bedtime or the anchoring event, so they live here.
struct PlanResult: Equatable {
    let plan: DailyPlan
    /// Planned bedtime for the night before `plan.wake`.
    let bedtime: Date
    /// Total sleep opportunity in minutes (target plus any bad-night extra).
    let sleepOpportunityMinutes: Int
    /// The early commitment that forced an earlier wake than the preferred one.
    /// nil if no early event exists or it did not move the wake time.
    let anchorEvent: ClassifiedEvent?
    let isBadNightAdjusted: Bool
    /// false when no usable sleep summary was supplied.
    let hadSleepData: Bool
}

/// Person B's planner. Pure and synchronous: same inputs always give the same
/// output, nothing is cached, and nothing reads Date(), Calendar.current, UI,
/// or services. Safe to call again after every calendar refresh.
///
/// `planDate` is the day the user WAKES UP. Events are read from that local day.
/// Caffeine cutoff and wind-down therefore fall on the evening before.
struct PlanEngine: PlanGenerating {
    var config: PlannerConfig

    init(config: PlannerConfig = PlannerConfig()) {
        self.config = config
    }

    func generatePlan(for planDate: Date, profile: SleepProfile,
                      sleepSummary: SleepSummary?, events: [CalendarEvent]) throws -> DailyPlan {
        try makeResult(for: planDate, profile: profile,
                       sleepSummary: sleepSummary, events: events).plan
    }

    /// Same calculation as `generatePlan`, plus the details used for explanations.
    func makeResult(for planDate: Date, profile: SleepProfile,
                    sleepSummary: SleepSummary?, events: [CalendarEvent]) throws -> PlanResult {
        let timeZone = try validatedTimeZone(for: profile)

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let dayStart = calendar.startOfDay(for: planDate)

        guard let preferredWake = calendar.date(bySettingHour: profile.preferredWakeHour,
                                                minute: profile.preferredWakeMinute,
                                                second: 0, of: dayStart) else {
            throw PlannerError.dateComputationFailed
        }

        // Wake: preferred time, or earlier if an early commitment needs the
        // preparation buffer. Never later than preferred.
        let preparation = TimeInterval(profile.preparationMinutes * 60)
        let classifier = EventClassifier(earlyCutoffHour: config.earlyCutoffHour)
        var wake = preferredWake
        var anchor: ClassifiedEvent?
        if let early = classifier.earliestEarly(events: events, planDate: planDate, timeZone: timeZone) {
            let latestWakeForEvent = early.event.start.addingTimeInterval(-preparation)
            if latestWakeForEvent < preferredWake {
                wake = max(latestWakeForEvent, dayStart) // never before the local day starts
                anchor = early
            }
        }

        // Bad night: extend sleep opportunity, keep wake fixed.
        var hadSleepData = false
        var isBadNight = false
        if let summary = sleepSummary, summary.totalAsleepMinutes >= 0 {
            hadSleepData = true
            isBadNight = summary.totalAsleepMinutes < config.badNightThresholdMinutes
        }
        let opportunityMinutes = profile.targetSleepMinutes
            + (isBadNight ? config.badNightExtraSleepMinutes : 0)

        // All offsets are elapsed time, so DST transitions are handled correctly.
        let bedtime = wake.addingTimeInterval(-TimeInterval(opportunityMinutes * 60))
        let caffeineCutoff = bedtime.addingTimeInterval(-TimeInterval(config.caffeineCutoffMinutesBeforeBed * 60))
        let windDown = bedtime.addingTimeInterval(-TimeInterval(config.windDownMinutesBeforeBed * 60))
        let lightStart = wake.addingTimeInterval(TimeInterval(config.lightStartDelayMinutes * 60))
        let lightEnd = lightStart.addingTimeInterval(TimeInterval(config.lightWindowMinutes * 60))

        let plan = DailyPlan(planDate: dayStart,
                             timeZoneID: timeZone.identifier,
                             wake: wake,
                             morningLightStart: lightStart,
                             morningLightEnd: lightEnd,
                             caffeineCutoff: caffeineCutoff,
                             windDown: windDown)

        return PlanResult(plan: plan,
                          bedtime: bedtime,
                          sleepOpportunityMinutes: opportunityMinutes,
                          anchorEvent: anchor,
                          isBadNightAdjusted: isBadNight,
                          hadSleepData: hadSleepData)
    }

    private func validatedTimeZone(for profile: SleepProfile) throws -> TimeZone {
        guard let timeZone = TimeZone(identifier: profile.timeZoneID) else {
            throw PlannerError.invalidTimeZone(profile.timeZoneID)
        }
        guard (0...23).contains(profile.preferredWakeHour),
              (0...59).contains(profile.preferredWakeMinute) else {
            throw PlannerError.invalidWakeTime(hour: profile.preferredWakeHour,
                                               minute: profile.preferredWakeMinute)
        }
        guard (1...1440).contains(profile.preparationMinutes) else {
            throw PlannerError.invalidPreparationMinutes(profile.preparationMinutes)
        }
        guard (1...1440).contains(profile.targetSleepMinutes) else {
            throw PlannerError.invalidTargetSleepMinutes(profile.targetSleepMinutes)
        }
        return timeZone
    }
}
