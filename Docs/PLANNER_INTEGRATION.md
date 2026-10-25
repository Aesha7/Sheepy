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

## Offline explanation contract

The verified offline-only commit is `10384cb`. The later live `ClaudeService`
commit on B's branch was intentionally not merged in this task.

`PlanExplainer` now accepts the exact `PlanResult`, not a DailyPlan requiring a
second lookup or generation. HomeView passes
`controller.plan.flatMap { controller.explanationResult(for: $0) }` to the sheet,
so missing or mismatched retained results cannot expose an old explanation.
The app's closure calls `OfflineExplainer().explain(result)` and wraps the text in
`PlanExplanation(text:isFallback: true)`. No makeResult call is made by the runtime
explanation path. The sheet request key includes the complete result and retry
count: explanation facts changing with identical plan dates still refresh text.
Resolved text is shown only when its key matches the current result. Missing
results immediately show the no-plan message; canceled old requests are ignored.

The UI explicitly labels this “Offline explanation” and states that it is generated
on-device with no network or Claude request. It does not claim a failed live request.
Planning and explanations both work without network access. Live explanation remains
a separate future task.

### Credential-loader source inspection (no secret values)

`Services/ClaudeAgent.swift` defines the existing `AgentConfiguration.load()`.
It resolves bundled `Secrets.plist` (source resource: `Resources/Secrets.plist`),
expects `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`, and rejects empty values or the
placeholder API key. `SleepController` owns a long-lived `ClaudeAgent()`; its
`reply(...)` method loads configuration lazily when a chat request starts.
There is no separate SDK client: it builds a URLRequest to the Anthropic Messages
endpoint and sends it using `URLSession.shared`, setting the API-key header and
model from the configuration.

For the next coordinated live-explanation task, reuse `AgentConfiguration.load()`
as the configuration boundary, and consider extracting shared HTTP transport from
ClaudeAgent. Do not duplicate plist loading or reuse its mutable chat/tool history
as explanation state. No loader/transport changes were made, no credential file was
opened, and no live request was performed for this integration.

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
