import EventKit
import Foundation

@MainActor
final class CalendarService: CalendarProviding {
    let dataMode: PlanningDataMode = .live
    private let store = EKEventStore()

    /// Call only from an explicit user action. Fetching never requests access.
    func requestAccess() async throws {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return
        case .denied, .restricted: try requireAccess()
        default:
            guard try await store.requestFullAccessToEvents() else {
                throw SheepFailure("Calendar access was not granted. Allow Full Access in Settings to load events.")
            }
            try requireAccess()
        }
    }

    private func requireAccess() throws {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return
        case .denied:
            throw SheepFailure("Calendar access is denied. Allow Full Access for Sleep Sheep in Settings.")
        case .restricted:
            throw SheepFailure("Calendar access is restricted on this device.")
        case .writeOnly:
            throw SheepFailure("Calendar write-only access cannot read events. Request Full Access.")
        default:
            throw SheepFailure("Calendar access has not been granted. Request Calendar access first.")
        }
    }

    func events(in interval: DateInterval) async throws -> [CalendarEvent] {
        try requireAccess()
        guard interval.start.timeIntervalSinceReferenceDate.isFinite,
              interval.end.timeIntervalSinceReferenceDate.isFinite else {
            throw SheepFailure("Calendar date range must be finite.")
        }
        guard interval.duration > 0 else { return [] }
        // EventKit limits each predicate to four years. Query in smaller chunks
        // and deduplicate overlapping occurrences without losing source IDs.
        var events: [CalendarEvent] = []
        var seen = Set<Occurrence>()
        var start = interval.start
        while start < interval.end {
            try Task.checkCancellation()
            let end = min(start.addingTimeInterval(366 * 24 * 60 * 60), interval.end)
            let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
            for event in store.events(matching: predicate) {
                guard let mapped = try Self.map(id: event.eventIdentifier ?? event.calendarItemIdentifier,
                    title: event.title ?? "", start: event.startDate, end: event.endDate,
                    isAllDay: event.isAllDay, timeZoneID: event.timeZone?.identifier,
                    in: interval) else { continue }
                if seen.insert(Occurrence(id: mapped.id, start: mapped.start, end: mapped.end)).inserted {
                    events.append(mapped)
                }
            }
            start = end
        }
        try requireAccess()
        return events.sorted {
            if $0.start != $1.start { return $0.start < $1.start }
            if $0.end != $1.end { return $0.end < $1.end }
            return $0.id < $1.id
        }
    }

    private struct Occurrence: Hashable {
        let id: String
        let start: Date
        let end: Date
    }

    /// Pure mapping seam for boundary checks without accessing a user's calendar.
    nonisolated static func map(id: String?, title: String, start: Date?, end: Date?,
                                isAllDay: Bool, timeZoneID: String?,
                                in interval: DateInterval) throws -> CalendarEvent? {
        guard let start, let end, end >= start else {
            throw SheepFailure("Calendar returned an event with invalid dates.")
        }
        // Zero-duration events are points: include at start, exclude at end.
        let overlaps = start == end ? interval.start <= start && start < interval.end
            : start < interval.end && end > interval.start
        guard interval.duration > 0, overlaps else { return nil }
        guard let id, !id.isEmpty else {
            throw SheepFailure("Calendar returned an event without an identifier.")
        }
        return CalendarEvent(id: id, title: title, start: start, end: end,
                             isAllDay: isAllDay, timeZoneID: timeZoneID,
                             destinationTimeZoneID: nil)
    }
}
