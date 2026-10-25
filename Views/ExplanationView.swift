import SwiftUI

/// "Why this plan?" for the plan on screen, entirely on this device: the text comes from
/// OfflineExplainer and the result SleepController retained for the displayed plan. Nothing is
/// stored here, so the sheet follows the controller: a new plan shows its own explanation, and
/// no valid plan shows no explanation at all.
@MainActor
struct ExplanationView: View {
    @ObservedObject var controller: SleepController
    @Environment(\.dismiss) private var dismiss

    /// The retained result that produced the displayed plan; never recomputed here.
    private var result: PlanResult? {
        controller.plan.flatMap { controller.explanationResult(for: $0) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let result {
                        PlanSummaryCard(result: result, inputs: inputsLine(for: result))
                        explanationCard(OfflineExplainer().explain(result))
                    } else {
                        noPlan
                    }
                }
                .padding(16)
                .animation(.easeInOut(duration: 0.25), value: result?.plan)
            }
            .background(Theme.nightSky.ignoresSafeArea())
            .foregroundStyle(Theme.text)
            .fontDesign(.rounded)
            .navigationTitle("Why this plan?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .tint(Theme.accent)
                }
            }
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.large])
    }

    // MARK: Sections

    private var noPlan: some View {
        VStack(alignment: .leading, spacing: 8) {
            CardHeader(title: "No plan to explain", systemImage: "list.bullet.clipboard")
            Text("Once your plan is ready, its explanation appears here. In live mode, enable Health or Calendar first; in demo mode, try Reset demo.")
                .foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .card()
    }

    private func explanationCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(title: "Why these times", systemImage: "lightbulb")
            // One sentence per paragraph reads more easily than a single block.
            ForEach(Array(Self.sentences(in: text).enumerated()), id: \.offset) { _, sentence in
                Text(sentence)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .textSelection(.enabled)
            Label("Generated on this device", systemImage: "iphone")
                .font(.footnote)
                .foregroundStyle(Theme.secondaryText)
            HintText("Simple planning rules, not medical advice.")
        }
        .card()
        .accessibilityElement(children: .contain)
    }

    /// Splits the explainer's text at sentence ends. Clock times like "7:00 AM" contain no
    /// period followed by a space, so they stay intact.
    private static func sentences(in text: String) -> [String] {
        let parts = text.components(separatedBy: ". ")
        return parts.enumerated().map { index, part in
            index < parts.count - 1 ? part + "." : part
        }
    }

    /// Where the plan's inputs came from, without implying Health data that wasn't there.
    private func inputsLine(for result: PlanResult) -> String {
        if controller.planningDataMode == .demo {
            return result.isBadNightAdjusted ? "Demo data · short night simulated" : "Demo data"
        }
        let sleep = result.hadSleepData ? "Sleep from Apple Health" : "No readable sleep, so your target sleep is used"
        let calendar = controller.calendarEvents.isEmpty ? "no calendar events loaded" : "calendar events loaded"
        return "Live mode · \(sleep) · \(calendar)"
    }
}

/// The four outputs of the retained result, for the wake day, in the plan's time zone.
private struct PlanSummaryCard: View {
    let result: PlanResult
    let inputs: String

    private var zone: TimeZone { DayTime.zone(result.plan.timeZoneID) }

    var body: some View {
        let now = Date()
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(title: "For waking \(DayTime.day(result.plan.planDate, now: now, in: zone))",
                       systemImage: "calendar")
            ForEach(PlanStep.steps(of: result.plan)) { step in
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        icon(step)
                        Text(step.kind.title)
                        Spacer(minLength: 8)
                        Text("\(day(step)) \(time(step))")
                            .monospacedDigit()
                            .foregroundStyle(Theme.secondaryText)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Label { Text(step.kind.title) } icon: { icon(step) }
                        Text("\(day(step)) \(time(step))")
                            .foregroundStyle(Theme.secondaryText)
                    }
                }
                .font(.subheadline)
                .accessibilityElement(children: .combine)
            }
            Divider().overlay(Theme.cardBorder)
            HintText("Times in \(zone.abbreviation(for: result.plan.planDate) ?? zone.identifier). \(inputs).")
        }
        .card()
    }

    private func icon(_ step: PlanStep) -> some View {
        Image(systemName: step.kind.icon)
            .foregroundStyle(step.kind.tint)
            .frame(width: 22)
            .accessibilityHidden(true)
    }

    private func day(_ step: PlanStep) -> String {
        DayTime.relativeDay(step.start, now: Date(), in: zone) ?? DayTime.shortDay(step.start, in: zone)
    }

    private func time(_ step: PlanStep) -> String {
        let start = DayTime.time(step.start, in: zone)
        guard let end = step.end else { return start }
        return "\(start) – \(DayTime.time(end, in: zone))"
    }
}

// MARK: Previews (the real planner and offline explainer; no network)

#Preview("Demo") {
    ExplanationView(controller: SleepController())
}

#Preview("Bad night · large text") {
    let controller = SleepController()
    controller.setDemoSleepScenario(.badNight)
    return ExplanationView(controller: controller).dynamicTypeSize(.accessibility1)
}

#Preview("No current plan") {
    ExplanationView(controller: SleepController(planningDataMode: .live))
}
