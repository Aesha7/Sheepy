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

## Contract for B's optional explanation service

B's original `planner-docs/planner-interface.md` proposal is superseded by the
implemented `PlanResult` contract. There is no `PlanRequest` or `UserPreferences`
type to add. Use `SleepProfile` and the retained result instead of recomputing a plan.

C currently accepts `PlanExplainer = @MainActor (DailyPlan) async throws ->
PlanExplanation`, where `PlanExplanation` contains `text` and `isFallback`.
An adapter should obtain `controller.explanationResult(for: displayedPlan)` once,
then pass that captured immutable PlanResult to B's explanation service. That
result carries the same plan, bedtime, sleepOpportunityMinutes, anchorEvent,
isBadNightAdjusted, and hadSleepData used by the timeline. Never call makeResult
again for explanation context. Reject nil as a stale/missing plan. If the future
service needs input snapshots beyond these facts, add an explicit snapshot contract
rather than reading mutable inputs after awaiting a response.

The explanation service is not present on B's merged branch. The existing optional
UI therefore displays its not-connected state. It cannot block or clear the plan.
No new network or health-data-sharing behavior is introduced. This document is the
repository handoff for B; no external message or PR comment was sent.

## Verification and device checks

B's standalone runner (`planner-docs/PlannerCheck/main.swift`) passes 59 checks.
`Tests/ControllerPlanningChecks` compiles the real controller against isolated
service/hardware/storage stubs and verifies initial generation, normal → bad-night
→ reset, matching retained results, stale explanation rejection, profile edits,
invalid-profile clearing, nil/empty refresh results, timezone-local tomorrow, and
live provenance protection. The stubs are never included in the app target.
Existing Health/request-tracking, Calendar mapping, and hardware checks also pass.
The full SleepSheep Debug simulator build passes.

On an iPhone, repeat normal demo → Simulate bad night → Reset demo in airplane mode.
Check all four timeline rows and changed-time annotations. Test live permissions
and provider refreshes (including empty data), then verify demo simulation remains
disabled for real data. Check profile edits if exposed by the UI, switching mode
while requests are pending, HealthKit signing, and existing Lamp & chat controls.
Automated checks do not validate physical-device permissions, real-store data,
Bluetooth behavior, or visual layout.
