# Planner integration and explanation handoff

The runtime uses B's `PlanEngine`/`EventClassifier` from e3d9134 with the unchanged
shared models. `PlannerConfig()` supplies B's prototype defaults. No network,
HealthKit query, Calendar query, or Claude request is needed to generate a plan.
These are prototype planning rules, not medically validated recommendations.

## Controller contract

```swift
@Published private(set) var planResult: PlanResult?
@Published private(set) var plannerError: String?
@Published private(set) var demoSleepScenario: DemoSleepScenario
func regeneratePlan(referenceDate: Date? = nil)
func setDemoSleepScenario(_ scenario: DemoSleepScenario)
func resetPlanningDemo()
func explanationResult(for displayedPlan: DailyPlan) -> PlanResult?
```

`plan` still drives C's entire timeline. Each generation clears the prior plan and
result, computes tomorrow using a Gregorian Calendar with `profile.timeZoneID`,
and calls `PlanEngine.makeResult(...)` exactly once. The exact returned value is
retained in `planResult` and its `.plan` is published. Errors leave both nil and
appear in `plannerError` and aggregated `planningError`; provider errors remain
independent. The UI reads plannerError directly so Calendar/Health errors cannot
hide a planner failure. No previous plan is presented as current after invalidation.

Generation occurs after initial demo loading, resetting demo inputs, scenario
changes, changed profile values (including nested SwiftUI bindings), and successful
Calendar/Health refreshes, including [] and nil. Failed provider operations clear
the plan and result. Entering live mode clears demo data and the old result without
prompting; the next successful refresh or profile change creates a live-input plan.
Existing provider tokens still reject stale results before changing inputs.

`SleepController(referenceDate: fixedDate, timeZone: zone)` is deterministic for
previews/tests. With no injected date, live/profile generations use the current
clock, while demo scenarios/reset retain the demo's original reference date.
Calendar refresh accepts optional `referenceDate:` for repeatable calls; Health
refresh uses its existing supplied reference date. `loadPlanningDemo(referenceDate:
timeZone:)` can explicitly start a demo on another date.

## Demo flow

No reusable Swift bad-night fixture was found in the available branches. The shared
`PlanningDemoInputs.make(referenceDate:timeZone:scenario:)` now supports `.normal`
(480 minutes) and `.badNight` (330 minutes). Both use a completed sleep end and
calculate the start from the duration; provenance remains `.demo`.

HomeView's existing Simulate bad night action calls `setDemoSleepScenario(.badNight)`.
It is disabled in live mode, and the controller independently rejects it unless
both mode and sleep provenance are demo. Reset uses `resetPlanningDemo()` to restore
the original normal fixture and reference date. It never writes to HealthKit.

For the default 7 AM commitment and 60-minute preparation buffer:

| Output | Normal demo | Bad-night demo |
| --- | --- | --- |
| Tomorrow's wake | 6:00 AM | 6:00 AM |
| Tomorrow's light window | 6:30–7:00 AM | 6:30–7:00 AM |
| Today's caffeine cutoff | 2:00 PM | 1:30 PM |
| Today's wind-down | 9:00 PM | 8:30 PM |

These example wall times assume a normal non-DST-transition night. The planner uses
elapsed durations across DST. All four timeline outputs come from one DailyPlan.

## Entirely on-device explanations

`ExplanationView(controller:)` observes the existing SleepController and renders
`OfflineExplainer().explain(result)` synchronously from the exact retained PlanResult
matching the displayed plan. It never calls makeResult to explain, caches no text,
and starts no task or request. Changed results are reflected on redraw, including
changed explanation facts with identical plan dates. A nil or mismatched result
shows the no-current-plan message instead of stale text.

The sheet is titled **Why this plan?** and has a small **Generated on this device**
label. There is no live explanation button, confirmation, disclosure, response,
loading/error state, retry, or fallback warning. This feature needs neither a key
nor a network connection and sends no personal data anywhere.

The unused live explanation service, response type, dependency injection, controller
request state/tasks, and dedicated live-service tests have been removed. No explanation
adapter exists in the app. ClaudeAgent, AgentConfiguration.load(), and the existing
Lamp & chat feature are unchanged; chat remains a separate user-initiated network
feature with its existing local configuration. No credential values were inspected
or modified. See [OFFLINE_EXPLANATION_INTEGRATION.md](OFFLINE_EXPLANATION_INTEGRATION.md)
for Person C's current wiring and validation instructions.

## Verification and device checks

B's standalone planner runner passes 59 checks, and the offline explainer runner passes 18 checks.
`Tests/ControllerPlanningChecks` compiles the real controller against isolated
service/hardware/storage stubs and verifies initial generation, normal → bad-night
→ reset, matching retained results, stale explanation rejection, profile edits,
invalid-profile clearing, nil/empty refresh results, timezone-local tomorrow, and
live provenance protection. Explanation assertions cover normal → bad-night → reset,
missing results, and changed explanation facts with unchanged plan dates. The stubs are never included in the app target.
Existing Health/request-tracking, Calendar mapping, and hardware checks also pass.
The full SleepSheep Debug simulator build passes.

On an iPhone, repeat normal demo → Simulate bad night → Reset demo in airplane mode.
Check all four timeline rows and changed-time annotations. Test live permissions
and provider refreshes (including empty data), then verify demo simulation remains
disabled for real data. Check profile edits if exposed by the UI, switching mode
while requests are pending, HealthKit signing, and existing Lamp & chat controls.
Automated checks do not validate physical-device permissions, real-store data,
Bluetooth behavior, or visual layout.
