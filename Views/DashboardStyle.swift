import SwiftUI

// Sheepy's look: a calm night sky in cool indigo and violet, moonlight-white text,
// lavender actions and periwinkle-blue details, on rounded cards.

enum Theme {
    static let background = Color(red: 0.055, green: 0.067, blue: 0.19)  // #0E1130 deep indigo
    static let backgroundLow = Color(red: 0.11, green: 0.086, blue: 0.26) // #1C1642 violet dusk
    /// Full-screen backdrop: indigo at the top fading to violet.
    static let nightSky = LinearGradient(colors: [background, backgroundLow], startPoint: .top, endPoint: .bottom)
    static let card = Color(red: 0.12, green: 0.13, blue: 0.29)          // #1F2149
    static let cardBorder = Color(red: 0.70, green: 0.65, blue: 0.97).opacity(0.16)
    static let text = Color(red: 0.94, green: 0.95, blue: 1.0)           // #EFF1FF moonlight
    static let secondaryText = Color(red: 0.74, green: 0.76, blue: 0.90) // #BCC2E6
    static let accent = Color(red: 0.71, green: 0.65, blue: 0.97)        // #B5A6F7 lavender
    static let sky = Color(red: 0.58, green: 0.74, blue: 1.0)            // #94BDFF periwinkle
    static let warning = Color(red: 0.97, green: 0.66, blue: 0.76)       // #F7A8C2 soft rose
}

/// Colors of the Sheepy figure, matched to the 3D-printed sheep.
enum SheepColors {
    static let wool = Color(red: 0.98, green: 0.98, blue: 0.97)
    static let woolShade = Color(red: 0.84, green: 0.84, blue: 0.91)
    static let face = Color(red: 0.84, green: 0.68, blue: 0.53)          // tan
    static let faceLight = Color(red: 0.89, green: 0.75, blue: 0.62)
    static let earInner = Color(red: 0.76, green: 0.59, blue: 0.45)
    static let eye = Color(red: 0.11, green: 0.10, blue: 0.18)
    static let blush = Color(red: 0.96, green: 0.62, blue: 0.70)
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
        case .demo: return Theme.sky
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
