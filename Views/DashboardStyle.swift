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
    var badge: SourceBadge.Kind? = nil

    var body: some View {
        // Title and badge sit side by side, and stack when larger text needs the room.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                titleLabel
                Spacer(minLength: 8)
                if let badge { SourceBadge(kind: badge) }
            }
            VStack(alignment: .leading, spacing: 6) {
                titleLabel
                if let badge { SourceBadge(kind: badge) }
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

/// Says where a card's data comes from. Live mode only means the provider was selected;
/// the checked badge appears only when that provider actually returned data.
/// Sleep and calendar get separate badges, because one can be live while the other isn't loaded.
struct SourceBadge: View {
    enum Kind: Equatable {
        case demo
        case liveMode
        case loaded(String)   // provider name, e.g. "Apple Health"

        static func of(mode: PlanningDataMode, loadedFrom provider: String?) -> Kind {
            guard mode == .live else { return .demo }
            return provider.map { .loaded($0) } ?? .liveMode
        }
    }

    let kind: Kind

    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.14), in: Capsule())
            .accessibilityLabel("Source: \(text)")
    }

    private var text: String {
        switch kind {
        case .demo: return "Demo data"
        case .liveMode: return "Live mode"
        case .loaded(let provider): return provider
        }
    }

    private var icon: String {
        switch kind {
        case .demo: return "wand.and.stars"
        case .liveMode: return "antenna.radiowaves.left.and.right"
        case .loaded: return "checkmark.circle.fill"
        }
    }

    private var color: Color {
        switch kind {
        case .demo: return Theme.warm
        case .liveMode: return Theme.secondaryText
        case .loaded: return Theme.accent
        }
    }
}

/// The one button look used inside cards: full width, 44 pt tall, lavender.
struct CardButton: View {
    let title: String
    let systemImage: String
    var prominent = false
    let action: () -> Void

    var body: some View {
        if prominent {
            Button(action: action) { label.foregroundStyle(Theme.background) }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: 12))
                .tint(Theme.accent)
        } else {
            Button(action: action) { label }
                .buttonStyle(.bordered)
                .buttonBorderShape(.roundedRectangle(radius: 12))
                .tint(Theme.accent)
        }
    }

    private var label: some View {
        Label(title, systemImage: systemImage)
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
    }
}

/// Short secondary text under a control, e.g. why it's disabled.
struct HintText: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Theme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
    }
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
