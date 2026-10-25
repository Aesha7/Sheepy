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

## Offline and explicit Claude explanations

B's completed service handoff through `4bb01f6` is integrated. See
[LIVE_EXPLANATION_INTEGRATION.md](LIVE_EXPLANATION_INTEGRATION.md) for the sharing
contract, request lifecycle, verification, and exact phone test steps.

The sheet observes the existing controller and renders `OfflineExplainer().explain`
from its exact retained PlanResult immediately. Claude is optional and runs only
after the user requests it and confirms sending the visible offline text to Anthropic.
The service's `PlanExplanation(text:source:)` is now the single shared response type;
C's duplicate `isFallback` wrapper and old PlanExplainer closure have been removed.

Every plan invalidation creates a new explanation revision, cancels pending work,
and clears the previous live text/error/loading state. This includes profile changes
that happen to produce equal PlanResults. Confirmations capture a revision, and
responses must still match that revision and result. No plan is regenerated to
explain it. Missing results show no prior text.

Credentials come from the existing `AgentConfiguration.load()` in ClaudeAgent.swift,
which reads bundled `Secrets.plist` using `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`.
The explanation service receives a closure calling that loader; it does not add a
second loader or copy credentials. The chat agent's mutable history/tools remain
separate. No credential file was inspected and no real Claude request was made
while integrating this service.

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
