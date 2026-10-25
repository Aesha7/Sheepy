import SwiftUI

/// "Why this plan?" for the plan on screen. Offline text is local and immediate; Claude is
/// asked only after the user reviews exactly what will be sent and confirms.
/// Request state (loading, response, error, revision) is owned by SleepController; this view
/// only holds presentation state: which text tab is shown and an open confirmation.
@MainActor
struct ExplanationView: View {
    @ObservedObject var controller: SleepController
    /// Non-nil while the confirmation is open; the revision it was opened for.
    @State private var pendingRevision: UUID?
    @State private var showingOffline = false
    @Environment(\.dismiss) private var dismiss

    /// The retained result that produced the displayed plan; never recomputed here.
    private var result: PlanResult? {
        controller.plan.flatMap { controller.explanationResult(for: $0) }
    }

    /// Only an accepted live response counts as a Claude response; fallbacks never do.
    private var claudeText: String? {
        guard let explanation = controller.liveExplanation, explanation.source == .live else { return nil }
        return explanation.text
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let result {
                        let offline = OfflineExplainer().explain(result)
                        PlanSummaryCard(result: result, inputs: inputsLine(for: result))
                        explanationCard(offline: offline)
                        claudeCard(offline: offline)
                    } else {
                        noPlan
                    }
                }
                .padding(16)
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
        .onChange(of: controller.explanationRevision) { _, _ in
            // New plan or inputs: an open confirmation would describe old text, so close it.
            pendingRevision = nil
            showingOffline = false
        }
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

    @ViewBuilder private func explanationCard(offline: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let claudeText {
                Picker("Explanation", selection: $showingOffline) {
                    Text("Claude response").tag(false)
                    Text("Offline").tag(true)
                }
                .pickerStyle(.segmented)

                if showingOffline {
                    offlineBlock(offline)
                } else {
                    Label("Claude response", systemImage: "sparkles")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                        .accessibilityAddTraits(.isHeader)
                    Text(claudeText)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    HintText("Claude reworded the offline explanation it was sent. It doesn't change your plan or confirm the recommendations.")
                }
            } else {
                offlineBlock(offline)
            }
        }
        .card()
    }

    @ViewBuilder private func offlineBlock(_ text: String) -> some View {
        Label("Offline explanation", systemImage: "iphone")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.sky)
            .accessibilityAddTraits(.isHeader)
        Text(text)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        HintText("Written on this phone from the planning rules. Works without a connection. Simple rules, not medical advice.")
    }

    @ViewBuilder private func claudeCard(offline: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if pendingRevision != nil {
                confirmation(offline: offline)
            } else if controller.liveExplanationLoading {
                HStack(spacing: 10) {
                    ProgressView().tint(Theme.accent)
                    Text("Asking Claude…")
                }
                .foregroundStyle(Theme.secondaryText)
                .accessibilityElement(children: .combine)
                HintText("Your offline explanation stays available while you wait.")
            } else if controller.liveExplanationError != nil {
                Label("Couldn't get a Claude response", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                HintText("Claude may be unavailable or not set up on this build. Your offline explanation is unchanged.")
                CardButton(title: "Try again", systemImage: "arrow.clockwise", action: askToSend)
            } else if claudeText == nil {
                CardButton(title: "Request Claude explanation", systemImage: "sparkles", prominent: true, action: askToSend)
                HintText("Optional. Claude rewords the offline explanation. Nothing is sent until you confirm.")
            } else {
                HintText("This Claude response belongs to the plan above. If the plan changes, it's cleared and you can ask again.")
            }
        }
        .card()
    }

    private func confirmation(offline: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Send to Anthropic?", systemImage: "paperplane")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Text("Claude will reword your explanation. This exact text is sent to Anthropic, with a fixed instruction to keep every time unchanged:")
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Text(offline)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityLabel("Text to be sent: \(offline)")
            HintText(controller.planningDataMode == .demo
                     ? "This is demo data, not your Health or Calendar data."
                     : "This comes from your live data. It can reveal your schedule times, how much sleep the plan allows, and whether recent sleep was short or unavailable.")
            HStack(spacing: 10) {
                CardButton(title: "Cancel", systemImage: "xmark") { pendingRevision = nil }
                CardButton(title: "Send", systemImage: "paperplane.fill", prominent: true, action: send)
                    .disabled(controller.liveExplanationLoading)
            }
        }
    }

    // MARK: Actions

    private func askToSend() {
        guard !controller.liveExplanationLoading else { return }
        pendingRevision = controller.explanationRevision
    }

    private func send() {
        // The controller rejects a revision that no longer matches the displayed plan.
        guard let revision = pendingRevision else { return }
        pendingRevision = nil
        showingOffline = false
        Task { await controller.requestLiveExplanation(for: revision) }
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

// MARK: Previews
// Mocked services only: no network, no real credentials. Tap the buttons in the canvas.

private enum PreviewService {
    /// Echoes the sent text back with a friendlier opening, so the time check passes.
    static let success = ClaudeService(credentials: { (apiKey: "preview-only", model: "preview-model") },
                                       transport: { request in
        let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
        let sent = ((body?["messages"] as? [[String: Any]])?.first?["content"] as? String) ?? ""
        try await Task.sleep(for: .seconds(1.5))
        let reply: [String: Any] = ["content": [["type": "text", "text": "Here's the thinking behind tomorrow.\n\n\(sent)"]],
                                    "stop_reason": "end_turn"]
        let data = try JSONSerialization.data(withJSONObject: reply)
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    })

    static let timeout = ClaudeService(credentials: { (apiKey: "preview-only", model: "preview-model") },
                                       transport: { _ in
        try await Task.sleep(for: .seconds(1))
        throw URLError(.timedOut)
    })

    static let notConfigured = ClaudeService(credentials: { nil })
}

#Preview("Demo · mock success") {
    ExplanationView(controller: SleepController(explanationService: PreviewService.success))
}

#Preview("Demo · mock timeout") {
    ExplanationView(controller: SleepController(explanationService: PreviewService.timeout))
}

#Preview("Not configured") {
    ExplanationView(controller: SleepController(explanationService: PreviewService.notConfigured))
}

#Preview("Bad night · large text") {
    let controller = SleepController(explanationService: PreviewService.success)
    controller.setDemoSleepScenario(.badNight)
    return ExplanationView(controller: controller).dynamicTypeSize(.accessibility1)
}

#Preview("No current plan") {
    ExplanationView(controller: SleepController(planningDataMode: .live, explanationService: PreviewService.notConfigured))
}
