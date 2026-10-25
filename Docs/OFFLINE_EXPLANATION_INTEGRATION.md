# Offline “Why this plan?” integration

Plan explanations are entirely on-device. Person C should continue presenting
`ExplanationView(controller: controller)` from HomeView, with the same controller
owned by SleepSheepApp. No closure, credentials, service injection, or async action
is required. Keep the title “Why this plan?” and the small “Generated on this device”
label. Do not restore live-response, fallback, network error, or retry UI.

The sheet resolves `controller.plan.flatMap { controller.explanationResult(for: $0) }`
and immediately renders `OfflineExplainer().explain(result)`. It uses the exact
retained result that generated the displayed timeline; it never regenerates a plan
just to explain. No explanation text is stored in view/controller state. Observed
result changes redraw the text; missing or mismatched plans show an empty-state
message. This also covers changes to explanation facts with unchanged timeline dates.

Removed: ClaudeService, its response model, exclusive controller state/tasks/methods/
injection, the live request UI, and dedicated live-service tests. The existing
ClaudeAgent and its credential loader remain untouched for Lamp & chat. The header's
Lamp & chat button still opens ContentView with the same controller instance.
Opening an explanation or changing a plan does not call chat or access credentials.

## Validation

- Planner runner: 59 checks; offline-explainer runner: 18 checks.
- Real-controller checks compiled with isolated storage/provider stubs and no
  credential-loader implementation: normal demo → explanation → bad night → updated
  explanation → reset; missing plan; changed facts with identical plan dates;
  profile errors; provider refresh; preservation of live sleep provenance.
- A chat stub traps if accidentally called, ensuring planning/explanation checks
  cannot silently use chat or networking.
- Existing Health/request tracking, Calendar mapping, and hardware protocol checks.
- Full Debug simulator build and project-membership/settings audit.

Run the controller checks without keys or network dependencies:

```sh
swiftc -module-cache-path /tmp/sleep-sheep-swift-cache \
  Models/SleepProfile.swift Models/PlanningModels.swift Models/PlanningDemoInputs.swift \
  Models/PlanningRequests.swift Models/SheepProtocol.swift Services/PlanningInterfaces.swift \
  Services/SheepHardware.swift Services/EventClassifier.swift Services/PlanEngine.swift \
  Services/OfflineExplainer.swift App/SleepController.swift \
  Tests/ControllerPlanningChecks/Stubs.swift Tests/ControllerPlanningChecks/Checks.swift \
  -o /tmp/controller-planning-checks
/tmp/controller-planning-checks
```

On the phone, enable airplane mode, reset demo, open Why this plan?, close it,
simulate a bad night, reopen, then reset and compare again. Verify the earlier
wind-down/caffeine times after the short night, normal text after reset, and the
no-current-plan state after switching to live before loading data. No permission,
credential, or network prompt should appear for explanations. Physical-device
layout/airplane-mode tapping remains a manual check; automated validation exercises
the same pure explanation path without credentials or networking.

`demo-ready-v1` remains on its original commit; this removal does not retag it.
