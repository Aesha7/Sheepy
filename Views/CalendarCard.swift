import SwiftUI
import UIKit

// Next commitment plus the coming week's events, with the Enable Calendar / Refresh controls.
// Access and fetching live in SleepController (see Docs/CALENDAR_INTEGRATION.md); this card
// only shows the results and calls back.
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

    private var upcoming: [CalendarEvent] {
        events.filter { $0.end > now }.sorted { $0.start < $1.start }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(title: "Next commitment", systemImage: "calendar", source: mode)

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
            } else if let next = upcoming.first {
                EventSummary(event: next, fallbackZone: fallbackZone, now: now)
                let later = upcoming.dropFirst().prefix(4)
                if !later.isEmpty {
                    Divider().overlay(Theme.cardBorder)
                    Text("Coming up")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.secondaryText)
                    ForEach(Array(later), id: \.rowKey) { event in
                        EventRow(event: event, fallbackZone: fallbackZone, now: now)
                    }
                }
            } else {
                Text(mode == .live ? "No events in the next 7 days." : "No upcoming commitments.")
                    .foregroundStyle(Theme.secondaryText)
            }

            controls
        }
        .card()
    }

    @ViewBuilder private var controls: some View {
        HStack(spacing: 10) {
            if mode == .live && connected {
                Button(action: onRefresh) {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
            } else {
                Button(action: onEnable) {
                    Label("Enable Calendar", systemImage: "calendar.badge.plus")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .foregroundStyle(Theme.background)
            }
            if error != nil, mode == .live, let settings = URL(string: UIApplication.openSettingsURLString) {
                Link(destination: settings) {
                    Label("Settings", systemImage: "gear")
                        .frame(minHeight: 44)
                        .padding(.horizontal, 8)
                }
                .buttonStyle(.bordered)
            }
        }
        .tint(Theme.accent)
        .font(.subheadline.weight(.semibold))
        .disabled(loading)
        .padding(.top, 4)

        if mode == .demo {
            Text("Switches the app to your real data. Sheepy only reads your calendar.")
                .font(.caption)
                .foregroundStyle(Theme.secondaryText)
        }
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
    let fallbackZone: TimeZone
    let now: Date

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(event.title)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            Text(event.whenText(now: now, zone: event.zone(fallback: fallbackZone), short: true))
                .font(.footnote.monospacedDigit())
                .foregroundStyle(Theme.secondaryText)
                .multilineTextAlignment(.trailing)
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
}

#Preview("Calendar card states") {
    let demo = PlanningDemoInputs.make(referenceDate: .now, timeZone: .current)
    var later = demo.calendarEvents[0]
    later.title = "Lab section"
    later.start = later.start.addingTimeInterval(26 * 3600)
    later.end = later.start.addingTimeInterval(3600)
    return ScrollView {
        VStack(spacing: 16) {
            CalendarCard(events: demo.calendarEvents, mode: .demo, fallbackZone: .current, now: .now,
                         loading: false, error: nil, connected: false, onEnable: {}, onRefresh: {})
            CalendarCard(events: [], mode: .live, fallbackZone: .current, now: .now,
                         loading: true, error: nil, connected: false, onEnable: {}, onRefresh: {})
            CalendarCard(events: demo.calendarEvents + [later], mode: .live, fallbackZone: .current, now: .now,
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
