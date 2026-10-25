import SwiftUI

/// Offline text is always local and immediate. Only the confirmed action sends data.
@MainActor
struct ExplanationView: View {
    @ObservedObject var controller: SleepController
    @State private var confirmingShare = false
    @State private var pendingRevision: UUID?
    @Environment(\.dismiss) private var dismiss

    private var result: PlanResult? {
        controller.plan.flatMap { controller.explanationResult(for: $0) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let result {
                        Label("Offline explanation", systemImage: "wifi.slash")
                            .font(.headline).foregroundStyle(Theme.warm)
                        Text(OfflineExplainer().explain(result))
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Generated on this device. Available without a network connection.")
                            .font(.footnote).foregroundStyle(Theme.secondaryText)

                        Divider()
                        if controller.liveExplanationLoading {
                            HStack { ProgressView(); Text("Asking Claude…") }
                        }
                        if let explanation = controller.liveExplanation, explanation.source == .live {
                            Label("Claude response", systemImage: "sparkles")
                                .font(.headline).foregroundStyle(Theme.accent)
                            Text(explanation.text).fixedSize(horizontal: false, vertical: true)
                        }
                        if let error = controller.liveExplanationError {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .font(.footnote).foregroundStyle(Theme.warning)
                        }
                        Text(controller.planningDataMode == .demo
                             ? "Optional: send the demo explanation above to Anthropic for a Claude rewrite."
                             : "Optional: send the explanation above to Anthropic. It can reveal your schedule, sleep opportunity, and whether recent sleep was short or unavailable.")
                            .font(.footnote).foregroundStyle(Theme.secondaryText)
                        Text("Calendar titles, heart rate, and raw Health records are not sent.")
                            .font(.footnote).foregroundStyle(Theme.secondaryText)
                        Button {
                            pendingRevision = controller.explanationRevision
                            confirmingShare = true
                        } label: {
                            Label("Request Claude explanation", systemImage: "sparkles")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(controller.liveExplanationLoading)
                    } else {
                        Text("There's no current plan to explain yet.")
                            .foregroundStyle(Theme.secondaryText)
                    }
                }
                .padding(20)
            }
            .background(Theme.background.ignoresSafeArea())
            .foregroundStyle(Theme.text)
            .navigationTitle("Why this plan?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.tint(Theme.accent)
                }
            }
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium, .large])
        .alert("Send this explanation to Claude?", isPresented: $confirmingShare) {
            Button("Cancel", role: .cancel) { pendingRevision = nil }
            Button("Send to Anthropic") {
                guard let revision = pendingRevision else { return }
                pendingRevision = nil
                Task { await controller.requestLiveExplanation(for: revision) }
            }
        } message: {
            Text("The offline text shown here will be sent to Anthropic. In live mode it contains personal schedule and sleep-summary facts. No raw Health records, heart rate, or calendar titles are included.")
        }
        .onChange(of: controller.explanationRevision) { _, _ in
            pendingRevision = nil
            confirmingShare = false
        }
    }
}

#Preview("Offline immediately available") {
    ExplanationView(controller: SleepController())
}

#Preview("No current plan") {
    ExplanationView(controller: SleepController(planningDataMode: .live))
}
