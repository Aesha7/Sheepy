import Foundation

/// A calendar event annotated for planning. Pure value type; nothing here is
/// derived from the event title.
struct ClassifiedEvent: Equatable {
    let event: CalendarEvent
    /// Timed event that starts on the plan day before the early cutoff
    /// (default 9:00 AM in the planning time zone).
    let isEarly: Bool
    /// True only when the event carries a valid, explicitly supplied
    /// `destinationTimeZoneID`. Never inferred from the title or any free text.
    let isFlight: Bool
}

/// Stateless calendar classifier used by `PlanEngine`.
/// Does not read Date(), Calendar.current, UI, or services.
struct EventClassifier {
    /// Local hour (0...23) before which a timed commitment counts as early.
    var earlyCutoffHour: Int

    init(earlyCutoffHour: Int = 9) {
        self.earlyCutoffHour = earlyCutoffHour
    }

    /// Timed events that start on the local plan day, sorted by start time
    /// (ties broken by id), so the input array order never matters.
    /// All-day events are ignored.
    func classify(events: [CalendarEvent], planDate: Date, timeZone: TimeZone) -> [ClassifiedEvent] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone

        let dayStart = calendar.startOfDay(for: planDate)
        let hour = min(max(earlyCutoffHour, 0), 23)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart),
              let cutoff = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: dayStart) else {
            return []
        }

        return events
            .filter { !$0.isAllDay && $0.start >= dayStart && $0.start < dayEnd }
            .sorted { ($0.start, $0.id) < ($1.start, $1.id) }
            .map { event in
                ClassifiedEvent(event: event,
                                isEarly: event.start < cutoff,
                                isFlight: EventClassifier.hasExplicitDestination(event))
            }
    }

    /// The earliest early commitment on the plan day, or nil if there is none.
    func earliestEarly(events: [CalendarEvent], planDate: Date, timeZone: TimeZone) -> ClassifiedEvent? {
        classify(events: events, planDate: planDate, timeZone: timeZone)
            .first(where: { $0.isEarly })
    }

    private static func hasExplicitDestination(_ event: CalendarEvent) -> Bool {
        guard let id = event.destinationTimeZoneID, !id.isEmpty else { return false }
        return TimeZone(identifier: id) != nil
    }
}
