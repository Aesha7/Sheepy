import SwiftUI

// Named PlanTimelineView so it doesn't hide SwiftUI's own TimelineView.
// Shows the DailyPlan's four recommendations exactly as supplied; it never computes a time.
// `previous` is the plan shown before the latest replan: steps whose times changed get an
// "Updated" tag and the old time, so the change is easy to see.
struct PlanTimelineView: View {
    let plan: DailyPlan
    var previous: DailyPlan? = nil
    var now: Date = .now
    /// Opens "Why this plan?"; nil when there's no retained result to explain.
    var onExplain: (() -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var timeZone: TimeZone { DayTime.zone(plan.timeZoneID) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(title: "Your plan", systemImage: "list.bullet.clipboard")

            VStack(alignment: .leading, spacing: 2) {
                Text(DayTime.day(plan.planDate, now: now, in: timeZone))
                    .font(.headline)
                if let zone = DayTime.zoneNote(timeZone, at: plan.planDate) {
                    Label("Times shown in \(zone)", systemImage: "globe")
                        .font(.footnote)
                        .foregroundStyle(Theme.warm)
                }
            }

            ForEach(PlanStep.steps(of: plan)) { step in
                TimelineRow(step: step, before: changedFrom(step), timeZone: timeZone, now: now)
            }

            if let onExplain {
                CardButton(title: "Why this plan?", systemImage: "questionmark.bubble", action: onExplain)
                    .padding(.top, 2)
            } else {
                HintText("The explanation for this plan isn't available.")
            }
        }
        .card()
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.35), value: plan)
    }

    private func changedFrom(_ step: PlanStep) -> PlanStep? {
        guard let previous, let old = PlanStep.steps(of: previous).first(where: { $0.kind == step.kind }) else { return nil }
        return old.start != step.start || old.end != step.end ? old : nil
    }
}

/// One row of the timeline, read straight from DailyPlan's fields.
struct PlanStep: Identifiable, Equatable {
    enum Kind: CaseIterable { case windDown, wake, morningLight, caffeineCutoff }
    let kind: Kind
    let start: Date
    var end: Date? = nil
    var id: Kind { kind }

    static func steps(of plan: DailyPlan) -> [PlanStep] {
        [
            PlanStep(kind: .windDown, start: plan.windDown),
            PlanStep(kind: .wake, start: plan.wake),
            PlanStep(kind: .morningLight, start: plan.morningLightStart, end: plan.morningLightEnd),
            PlanStep(kind: .caffeineCutoff, start: plan.caffeineCutoff),
        ].sorted { $0.start < $1.start }
    }
}

private struct TimelineRow: View {
    let step: PlanStep
    let before: PlanStep?
    let timeZone: TimeZone
    let now: Date

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: step.kind.icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(step.kind.tint)
                .frame(width: 40, height: 40)
                .background(step.kind.tint.opacity(0.15), in: Circle())
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(step.kind.title)
                        .font(.headline)
                    if before != nil {
                        Text("Updated")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Theme.background)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Theme.accent, in: Capsule())
                            .transition(.opacity)
                    }
                }

                Text(timeText(step))
                    .font(.title3.weight(.semibold).monospacedDigit())
                    .contentTransition(.numericText())

                Text(dayText)
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondaryText)

                if let before {
                    Text("was \(timeText(before))")
                        .font(.footnote)
                        .strikethrough()
                        .foregroundStyle(Theme.secondaryText)
                }

                Text(step.kind.hint)
                    .font(.footnote)
                    .foregroundStyle(Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(before == nil ? Color.clear : Theme.accent.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var dayText: String {
        DayTime.relativeDay(step.start, now: now, in: timeZone) ?? DayTime.shortDay(step.start, in: timeZone)
    }

    private func timeText(_ step: PlanStep) -> String {
        let start = DayTime.time(step.start, in: timeZone)
        guard let end = step.end else { return start }
        return "\(start) – \(DayTime.time(end, in: timeZone))"
    }
}

extension PlanStep.Kind {
    var title: String {
        switch self {
        case .wake: return "Wake up"
        case .morningLight: return "Morning light"
        case .caffeineCutoff: return "Last caffeine"
        case .windDown: return "Start winding down"
        }
    }

    var hint: String {
        switch self {
        case .wake: return "Time to get up."
        case .morningLight: return "Step outside or sit by a bright window."
        case .caffeineCutoff: return "Last coffee, tea or energy drink."
        case .windDown: return "Dim the lights and put screens away."
        }
    }

    var icon: String {
        switch self {
        case .wake: return "alarm.fill"
        case .morningLight: return "sun.max.fill"
        case .caffeineCutoff: return "cup.and.saucer.fill"
        case .windDown: return "moon.stars.fill"
        }
    }

    var tint: Color {
        switch self {
        case .wake, .morningLight: return Theme.warm
        case .caffeineCutoff, .windDown: return Theme.accent
        }
    }
}

#Preview("Normal") {
    ScrollView { PlanTimelineView(plan: PreviewPlans.normal()).padding(16) }
        .background(Theme.background)
        .foregroundStyle(Theme.text)
        .preferredColorScheme(.dark)
}

#Preview("After a bad night") {
    ScrollView { PlanTimelineView(plan: PreviewPlans.badNight(), previous: PreviewPlans.normal()).padding(16) }
        .background(Theme.background)
        .foregroundStyle(Theme.text)
        .preferredColorScheme(.dark)
}

#Preview("Other time zone") {
    ScrollView { PlanTimelineView(plan: PreviewPlans.normal(timeZone: TimeZone(identifier: "America/New_York")!)).padding(16) }
        .background(Theme.background)
        .foregroundStyle(Theme.text)
        .preferredColorScheme(.dark)
}
