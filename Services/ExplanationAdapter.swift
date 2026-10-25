import Foundation

enum ExplanationAdapterError: Error, LocalizedError, Equatable {
    /// The displayed plan is no longer the controller's current plan.
    case stalePlan

    var errorDescription: String? {
        "The plan changed, so this explanation was not shown. Try again."
    }
}

/// Connects B's explanation service to C's explanation view.
///
/// Follows Docs/PLANNER_INTEGRATION.md: the PlanResult comes from
/// `controller.explanationResult(for:)` and is never recomputed here. The result
/// is looked up before the request and checked again afterwards, so an
/// explanation for a plan that changed while the request was running is rejected
/// instead of being shown against the wrong plan.
///
/// `PlanExplanation` and `PlanExplainer` are C's types (Views/ExplanationView.swift).
/// `isFallback` is true for the offline text, which the view labels
/// "Offline explanation".
///
/// Example wiring (owned by whoever builds HomeView):
///
///     let explain = ExplanationAdapter.makeExplainer(
///         resultFor: { controller.explanationResult(for: $0) },
///         service: ClaudeService(credentials: {
///             guard let c = try? AgentConfiguration.load() else { return nil }
///             return (apiKey: c.apiKey, model: c.model)
///         }))
///     HomeView(..., explain: explain)
enum ExplanationAdapter {
    @MainActor
    static func makeExplainer(
        resultFor: @escaping @MainActor (DailyPlan) -> PlanResult?,
        service: ClaudeService
    ) -> PlanExplainer {
        return { displayedPlan in
            guard let result = resultFor(displayedPlan) else {
                throw ExplanationAdapterError.stalePlan
            }
            let output = await service.explain(result)
            guard resultFor(displayedPlan) == result else {
                throw ExplanationAdapterError.stalePlan
            }
            return PlanExplanation(text: output.text, isFallback: output.source == .offline)
        }
    }
}
