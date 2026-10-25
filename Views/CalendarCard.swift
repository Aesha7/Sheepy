import SwiftUI
import UIKit

// The coming week's calendar, with the Enable Calendar / Refresh controls.
// Access and fetching live in SleepController (see Docs/CALENDAR_INTEGRATION.md); this card
// only shows the results and calls back. Grouping here is display-only: the planner still
// receives every event and applies its own classification.
struct CalendarCard: View {
    let events: [CalendarEvent]
    let mode: PlanningDataMode
    let fallbackZone: TimeZone
    let now: Date
    let loading: Bool
    let error: String?
    /// True once a live fetch has succeeded, so the main button becomes Refresh.
    let connected: Bool
    let onEnable: () -> Void
    let onRefresh: () -> Void

    /// Not started yet, soonest first. Events that have ended are left out entirely.
    private var upcoming: [CalendarEvent] {
        events.filter { $0.start > now }.sorted { $0.start < $1.start }
    }

    /// Started and not yet ended, e.g. an all-day event today or a multi-day trip.
    private var ongoing: [CalendarEvent] {
        events.filter { $0.start <= now && $0.end > now }.sorted { $0.end < $1.end }
    }

    private var badge: SourceBadge.Kind {
        .of(mode: mode, loadedFrom: events.isEmpty ? nil : "Calendar")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(title: "Calendar", systemImage: "calendar", badge: badge)

            if loading {
                HStack(spacing: 10) {
                    ProgressView().tint(Theme.accent)
                    Text("Loading your calendar…")
                }
                .foregroundStyle(Theme.secondaryText)
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.subheadline)
                    .foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                content
            }

            controls
        }
        .card()
    }

    @ViewBuilder private var content: some View {
        SectionLabel("Next commitment")
        if let next = upcoming.first {
            EventSummary(event: next, fallbackZone: fallbackZone, now: now)
        } else {
            Text(emptyText)
                .foregroundStyle(Theme.secondaryText)
        }

        let later = upcoming.dropFirst().prefix(3)
        if !later.isEmpty {
            Divider().overlay(Theme.cardBorder)
            SectionLabel("Coming up")
            ForEach(Array(later), id: \.rowKey) { event in
                EventRow(event: event, detail: event.whenText(now: now, zone: event.zone(fallback: fallbackZone), short: true))
            }
        }

        if !ongoing.isEmpty {
            Divider().overlay(Theme.cardBorder)
            SectionLabel("Happening now")
            ForEach(Array(ongoing.prefix(3)), id: \.rowKey) { event in
                EventRow(event: event, detail: event.ongoingText(now: now, zone: event.zone(fallback: fallbackZone)))
            }
        }
    }

    private var emptyText: String {
        if mode == .demo { return "No upcoming commitments." }
        return connected ? "Nothing else starts in the next 7 days." : "Enable Calendar to load your next 7 days."
    }

    @ViewBuilder private var controls: some View {
        HStack(spacing: 10) {
            if mode == .live && connected {
                CardButton(title: "Refresh", systemImage: "arrow.clockwise", action: onRefresh)
            } else {
                CardButton(title: "Enable Calendar", systemImage: "calendar.badge.plus", prominent: true, action: onEnable)
            }
            if error != nil, mode == .live, let settings = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: settings) {
                    Label("Settings", systemImage: "gear")
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 44)
                        .padding(.horizontal, 6)
                }
                .buttonStyle(.bordered)
                .tint(Theme.accent)
            }
        }
        .disabled(loading)
        .padding(.top, 4)

        if mode == .demo {
            HintText("Enable Calendar switches to live mode. Sheepy only reads your calendar.")
        }
    }
}

private struct SectionLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.secondaryText)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct EventSummary: View {
    let event: CalendarEvent
    let fallbackZone: TimeZone
    let now: Date

    var body: some View {
        let zone = event.zone(fallback: fallbackZone)
        VStack(alignment: .leading, spacing: 6) {
            Text(event.title)
                .font(.title3.weight(.semibold))
                .lineLimit(2)
                .truncationMode(.tail)
                .accessibilityLabel(event.title)
            Text(event.whenText(now: now, zone: zone))
                .foregroundStyle(Theme.secondaryText)
            if !event.isAllDay, let note = DayTime.zoneNote(zone, at: event.start) {
                Label("\(note) time", systemImage: "globe")
                    .font(.footnote)
                    .foregroundStyle(Theme.warm)
            }
            if let destination = event.destinationTimeZoneID.flatMap(TimeZone.init(identifier:)) {
                Label("Destination time zone: \(destination.abbreviation(for: event.end) ?? destination.identifier)",
                      systemImage: "airplane")
                    .font(.footnote)
                    .foregroundStyle(Theme.warm)
            }
        }
    }
}

private struct EventRow: View {
    let event: CalendarEvent
    let detail: String

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(event.title)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                Text(detail)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(Theme.secondaryText)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .lineLimit(2)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Theme.secondaryText)
            }
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}

/// Row identity per the calendar doc: EventKit ids can repeat across recurring occurrences.
struct CalendarRowKey: Hashable {
    let id: String
    let start: Date
    let end: Date
}

extension CalendarEvent {
    var rowKey: CalendarRowKey { CalendarRowKey(id: id, start: start, end: end) }

    /// The event's own time zone; a missing one means the phone's/profile's zone.
    /// All-day dates are shown as EventKit gives them, without zone conversion.
    func zone(fallback: TimeZone) -> TimeZone {
        timeZoneID.flatMap { TimeZone(identifier: $0) } ?? fallback
    }

    func whenText(now: Date, zone: TimeZone, short: Bool = false) -> String {
        let day = short
            ? (DayTime.relativeDay(start, now: now, in: zone) ?? DayTime.shortDay(start, in: zone))
            : DayTime.day(start, now: now, in: zone)
        if isAllDay { return "\(day) · All day" }
        return short ? "\(day) \(DayTime.time(start, in: zone))" : "\(day) at \(DayTime.time(start, in: zone))"
    }

    /// For an event already under way: when it ends. All-day ends are exclusive in EventKit,
    /// so the last day shown is the one just before `end`.
    func ongoingText(now: Date, zone: TimeZone) -> String {
        if isAllDay {
            let lastDay = end.addingTimeInterval(-1)
            if let rel = DayTime.relativeDay(lastDay, now: now, in: zone), rel == "Today" { return "Today · All day" }
            return "Ongoing · until \(DayTime.shortDay(lastDay, in: zone))"
        }
        let endDay = DayTime.relativeDay(end, now: now, in: zone)
        if endDay == "Today" { return "Ongoing · until \(DayTime.time(end, in: zone))" }
        return "Ongoing · until \(endDay ?? DayTime.shortDay(end, in: zone)) \(DayTime.time(end, in: zone))"
    }
}

#Preview("Calendar card states") {
    let demo = PlanningDemoInputs.make(referenceDate: .now, timeZone: .current)
    var later = demo.calendarEvents[0]
    later.title = "Lab section"
    later.start = later.start.addingTimeInterval(26 * 3600)
    later.end = later.start.addingTimeInterval(3600)
    let cal = Calendar.current
    let threeDaysAgo = cal.startOfDay(for: cal.date(byAdding: .day, value: -3, to: .now)!)
    let trip = CalendarEvent(id: "trip", title: "Conference trip", start: threeDaysAgo,
                             end: cal.date(byAdding: .day, value: 6, to: threeDaysAgo)!, isAllDay: true,
                             timeZoneID: nil, destinationTimeZoneID: nil)
    let ended = CalendarEvent(id: "old", title: "Old all-day event", start: threeDaysAgo,
                              end: cal.date(byAdding: .day, value: 1, to: threeDaysAgo)!, isAllDay: true,
                              timeZoneID: nil, destinationTimeZoneID: nil)
    return ScrollView {
        VStack(spacing: 16) {
            CalendarCard(events: demo.calendarEvents, mode: .demo, fallbackZone: .current, now: .now,
                         loading: false, error: nil, connected: false, onEnable: {}, onRefresh: {})
            CalendarCard(events: [], mode: .live, fallbackZone: .current, now: .now,
                         loading: true, error: nil, connected: false, onEnable: {}, onRefresh: {})
            CalendarCard(events: demo.calendarEvents + [later, trip, ended], mode: .live, fallbackZone: .current, now: .now,
                         loading: false, error: nil, connected: true, onEnable: {}, onRefresh: {})
            CalendarCard(events: [ended], mode: .live, fallbackZone: .current, now: .now,
                         loading: false, error: nil, connected: true, onEnable: {}, onRefresh: {})
            CalendarCard(events: [], mode: .live, fallbackZone: .current, now: .now,
                         loading: false, error: "Calendar access is denied. Allow Full Access for Sleep Sheep in Settings.",
                         connected: false, onEnable: {}, onRefresh: {})
        }
        .padding(16)
    }
    .background(Theme.background)
    .foregroundStyle(Theme.text)
    .preferredColorScheme(.dark)
}
