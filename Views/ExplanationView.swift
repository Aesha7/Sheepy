import SwiftUI

/// Synchronously renders the current retained result. No cached text or network work.
@MainActor
struct ExplanationView: View {
    @ObservedObject var controller: SleepController
    @Environment(\.dismiss) private var dismiss

    private var result: PlanResult? {
        controller.plan.flatMap { controller.explanationResult(for: $0) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let result {
                        Text("Generated on this device")
                            .font(.caption).foregroundStyle(Theme.secondaryText)
                        Text(OfflineExplainer().explain(result))
                            .fixedSize(horizontal: false, vertical: true)
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

    }
}

#Preview("Offline immediately available") {
    ExplanationView(controller: SleepController())
}

#Preview("No current plan") {
    ExplanationView(controller: SleepController(planningDataMode: .live))
}
