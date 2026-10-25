import SwiftUI

/// What "Why this plan?" displays. Person B's explanation service produces it;
/// `isFallback` labels locally generated text as "Offline explanation".
struct PlanExplanation: Equatable {
    var text: String
    var isFallback: Bool
}

/// B's explanation service, as the UI calls it. Throwing means no explanation and no fallback.
typealias PlanExplainer = @MainActor (PlanResult) async throws -> PlanExplanation

// The sheet asks for an explanation of the plan it is showing. If the plan changes while it
// is open, the request restarts and any late reply for the old plan is dropped.
@MainActor
struct ExplanationView: View {
    let result: PlanResult?
    let explain: PlanExplainer?

    @State private var phase: Phase = .loading
    @State private var attempt = 0
    @State private var resolvedRequest: RequestKey?
    @Environment(\.dismiss) private var dismiss

    init(result: PlanResult?, explain: PlanExplainer?) {
        self.result = result
        self.explain = explain
    }

    private enum Phase: Equatable {
        case loading, ready(String), fallback(String), failed(String)
    }

    private struct RequestKey: Equatable {
        let result: PlanResult?
        let attempt: Int
    }

    private var requestKey: RequestKey { RequestKey(result: result, attempt: attempt) }

    var body: some View {
        NavigationStack {
            ScrollView {
                content
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
            }
            .background(Theme.background.ignoresSafeArea())
            .foregroundStyle(Theme.text)
            .navigationTitle("Why this plan?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .tint(Theme.accent)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .preferredColorScheme(.dark)
        .task(id: requestKey) { await load() }
    }

    private func load() async {
        resolvedRequest = nil
        phase = .loading
        let key = requestKey
        guard let result, let explain else { return }
        do {
            let explanation = try await explain(result)
            guard !Task.isCancelled else { return }   // the plan changed while this was in flight
            phase = explanation.isFallback ? .fallback(explanation.text) : .ready(explanation.text)
            resolvedRequest = key
        } catch {
            guard !Task.isCancelled else { return }
            phase = .failed(error.localizedDescription)
            resolvedRequest = key
        }
    }

    @ViewBuilder private var content: some View {
        if result == nil {
            message("There's no plan to explain yet.")
        } else if explain == nil {
            message("Explanations will appear here once the explanation service is connected.")
        } else {
            switch resolvedRequest == requestKey ? phase : .loading {
            case .loading:
                VStack(spacing: 12) {
                    ProgressView().tint(Theme.accent)
                    Text("Preparing your explanation…")
                        .foregroundStyle(Theme.secondaryText)
                }
                .frame(maxWidth: .infinity, minHeight: 160)

            case .ready(let text):
                Text(text)
                    .fixedSize(horizontal: false, vertical: true)

            case .fallback(let text):
                VStack(alignment: .leading, spacing: 12) {
                    Label("Offline explanation", systemImage: "wifi.slash")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.warm)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Theme.warm.opacity(0.14), in: Capsule())
                    Text(text)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Generated on this device from your current plan. No network or Claude request is used.")
                        .font(.footnote)
                        .foregroundStyle(Theme.secondaryText)
                }

            case .failed(let error):
                VStack(alignment: .leading, spacing: 12) {
                    Label("Couldn't load the explanation.", systemImage: "exclamationmark.triangle")
                        .font(.headline)
                        .foregroundStyle(Theme.warning)
                    Text(error)
                        .foregroundStyle(Theme.secondaryText)
                    Button {
                        attempt += 1
                    } label: {
                        Label("Try again", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .tint(Theme.accent)
                }
            }
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(Theme.secondaryText)
            .frame(maxWidth: .infinity, minHeight: 120)
    }
}

private struct PreviewFailure: LocalizedError {
    var errorDescription: String? { "The explanation service didn't respond." }
}

#Preview("Success") {
    Color.clear.sheet(isPresented: .constant(true)) {
        ExplanationView(result: PreviewPlans.result()) { _ in
            try await Task.sleep(for: .seconds(1))
            return PlanExplanation(text: "Your 7 AM commitment sets the wake time; the rest of the plan works back from there.", isFallback: false)
        }
    }
}

#Preview("Offline fallback") {
    Color.clear.sheet(isPresented: .constant(true)) {
        ExplanationView(result: PreviewPlans.result()) { _ in
            PlanExplanation(text: "Wake time comes from your first commitment; wind-down leaves room for your usual sleep.", isFallback: true)
        }
    }
}

#Preview("Error, no fallback") {
    Color.clear.sheet(isPresented: .constant(true)) {
        ExplanationView(result: PreviewPlans.result()) { _ in throw PreviewFailure() }
    }
}

#Preview("Not connected yet") {
    Color.clear.sheet(isPresented: .constant(true)) {
        ExplanationView(result: PreviewPlans.result(), explain: nil)
    }
}
