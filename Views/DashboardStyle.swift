import SwiftUI

// Shared look for the dashboard: deep navy, cream text, lavender accents, rounded cards.

enum Theme {
    static let background = Color(red: 0.05, green: 0.07, blue: 0.13)   // #0D1120
    static let card = Color(red: 0.10, green: 0.12, blue: 0.21)
    static let cardBorder = Color.white.opacity(0.07)
    static let text = Color(red: 0.96, green: 0.94, blue: 0.90)         // #F4EFE6
    static let secondaryText = Color(red: 0.96, green: 0.94, blue: 0.90).opacity(0.72)
    static let accent = Color(red: 0.74, green: 0.67, blue: 0.96)       // lavender
    static let warm = Color(red: 0.95, green: 0.79, blue: 0.54)         // #F2C98A
    static let warning = Color(red: 0.98, green: 0.64, blue: 0.57)
}

struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Theme.cardBorder))
    }
}

extension View {
    func card() -> some View { modifier(CardStyle()) }
}

struct CardHeader: View {
    let title: String
    let systemImage: String
    var source: PlanningDataMode? = nil

    var body: some View {
        // Title and badge sit side by side, and stack when larger text needs the room.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                titleLabel
                Spacer(minLength: 8)
                if let source { SourceBadge(mode: source) }
            }
            VStack(alignment: .leading, spacing: 6) {
                titleLabel
                if let source { SourceBadge(mode: source) }
            }
        }
    }

    private var titleLabel: some View {
        Label(title, systemImage: systemImage)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.secondaryText)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Labels each card's data as real or demo. Sleep and calendar get separate badges,
/// because one can be live while the other is still a fixture.
struct SourceBadge: View {
    let mode: PlanningDataMode

    var body: some View {
        Label(mode == .live ? "Live data" : "Demo data",
              systemImage: mode == .live ? "checkmark.circle.fill" : "wand.and.stars")
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.14), in: Capsule())
            .accessibilityLabel(mode == .live ? "Source: live data" : "Source: demo data")
    }

    private var color: Color { mode == .live ? Theme.accent : Theme.warm }
}

/// Formatting only. Every date is shown in the time zone its data came with.
enum DayTime {
    static func zone(_ identifier: String?) -> TimeZone {
        identifier.flatMap(TimeZone.init(identifier:)) ?? .current
    }

    static func time(_ date: Date, in tz: TimeZone) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: tz))
    }

    static func shortDay(_ date: Date, in tz: TimeZone) -> String {
        date.formatted(Date.FormatStyle(timeZone: tz).weekday(.abbreviated).month(.abbreviated).day())
    }

    /// "Today", "Tomorrow" or "Yesterday" in `tz`, otherwise nil.
    static func relativeDay(_ date: Date, now: Date, in tz: TimeZone) -> String? {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        if cal.isDate(date, inSameDayAs: now) { return "Today" }
        if let next = cal.date(byAdding: .day, value: 1, to: now), cal.isDate(date, inSameDayAs: next) { return "Tomorrow" }
        if let prev = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: prev) { return "Yesterday" }
        return nil
    }

    /// "Tomorrow · Sat, Oct 25", or just "Mon, Oct 27" further out.
    static func day(_ date: Date, now: Date, in tz: TimeZone) -> String {
        let short = shortDay(date, in: tz)
        guard let rel = relativeDay(date, now: now, in: tz) else { return short }
        return "\(rel) · \(short)"
    }

    /// The zone's abbreviation when it differs from the phone's (e.g. a flight).
    static func zoneNote(_ tz: TimeZone, at date: Date) -> String? {
        guard tz.secondsFromGMT(for: date) != TimeZone.current.secondsFromGMT(for: date) else { return nil }
        return tz.abbreviation(for: date) ?? tz.identifier
    }

    static func duration(minutes: Int) -> String {
        "\(minutes / 60) h \(minutes % 60) min"
    }
}
