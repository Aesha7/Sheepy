> Current integration: plan explanations are entirely offline. The live explanation
> path from this original handoff has been removed. Use
> [OFFLINE_EXPLANATION_INTEGRATION.md](../Docs/OFFLINE_EXPLANATION_INTEGRATION.md).

# Planner handoff (Person B)

Branch: `person-b-planning`. Code verified at commit `1683ff6` (code unchanged since).
This file replaces the early draft in `planner-interface.md`, whose type names were provisional.

## Files to add to the Xcode target

I did not commit `project.pbxproj`, so these must be added to the target by whoever owns Xcode config:

- `Services/EventClassifier.swift`
- `Services/PlanEngine.swift`
- `Services/OfflineExplainer.swift`

No shared model was changed. Everything uses `SleepProfile`, `SleepSummary`, `CalendarEvent`, `DailyPlan` as they are.

## How to call it

```swift
let result = try PlanEngine().makeResult(for: wakeDay,
                                         profile: profile,
                                         sleepSummary: sleepSummary,
                                         events: calendarEvents)
plan = result.plan                                  // DailyPlan, for the UI
let offlineText = OfflineExplainer().explain(result) // works with no network

```

`PlanEngine().generatePlan(for:profile:sleepSummary:events:)` also exists and satisfies `PlanGenerating`; it returns `makeResult(...).plan`.

## Behavior to know

- `planDate` is the day the user WAKES UP. Events are read from that local day (in `profile.timeZoneID`). For the demo (reference date today, 7 AM event tomorrow) call it with tomorrow; with today the event is ignored.
- Caffeine cutoff and wind-down fall on the evening before the wake day. `DailyPlan` has no bedtime or anchoring-event field, so those are in `PlanResult` (`bedtime`, `anchorEvent`, `isBadNightAdjusted`, `hadSleepData`).
- Pure, synchronous, stateless: same input gives the same output, nothing is cached. After a Calendar refresh clears `plan`, call it again.
- Invalid preferences throw `PlannerError` (unknown time zone, wake hour/minute out of range, preparation or target sleep outside 1...1440).
- Empty events and `nil` sleep summary are fine.
- All time offsets are elapsed time, so daylight saving changes are handled (checked for Nov 1 and Mar 8).

## Prototype rules (not medically validated)

| Item | Rule |
|---|---|
| Wake | `preferredWake`, or earlier if an early event needs `preparationMinutes` |
| Early event | timed event starting before 9:00 AM local; all-day events ignored; earliest one wins regardless of array order |
| Sleep opportunity | `targetSleepMinutes`, plus 30 min after a bad night (wake stays fixed) |
| Bad night | last sleep under 360 minutes asleep |
| Morning light | starts 30 min after wake, window 30 min |
| Caffeine cutoff | 8 hours before bedtime |
| Wind-down | 60 minutes before bedtime |
| Flight | only when `destinationTimeZoneID` is a valid time zone; never read from the title |

All values live in `PlannerConfig`.

## Example outputs (checked by the runners)

Profile: wake 7:00, preparation 60, target sleep 480, America/Los_Angeles. Wake day Mon Oct 26 2026, one 7:00 AM event.

| | Normal night (480 min) | Bad night (330 min) |
|---|---|---|
| Wake | Mon 6:00 AM | Mon 6:00 AM |
| Morning light | 6:30 to 7:00 AM | 6:30 to 7:00 AM |
| Caffeine cutoff | Sun 2:00 PM | Sun 1:30 PM |
| Wind-down | Sun 9:00 PM | Sun 8:30 PM |
| Bedtime | Sun 10:00 PM | Sun 9:30 PM |

Offline explanation (normal night):

> Your first commitment starts at 7:00 AM, so your plan wakes you at 6:00 AM to leave time to get ready. Start winding down at 9:00 PM and aim to be in bed by 10:00 PM. Have your last caffeine by 2:00 PM. Get bright morning light between 6:30 AM and 7:00 AM.

To show a bad night in the demo, pass a `SleepSummary` with `totalAsleepMinutes` under 360 (there is no override flag).

## How it was verified

From the repo root, no Xcode or signing needed:

```bash
swiftc -o /tmp/plannercheck Models/SleepProfile.swift Models/PlanningModels.swift Services/PlanningInterfaces.swift Services/EventClassifier.swift Services/PlanEngine.swift planner-docs/PlannerCheck/main.swift && /tmp/plannercheck
swiftc -parse-as-library -o /tmp/explaincheck Models/SleepProfile.swift Models/PlanningModels.swift Services/PlanningInterfaces.swift Services/EventClassifier.swift Services/PlanEngine.swift Services/OfflineExplainer.swift planner-docs/ExplainCheck/ExplainCheck.swift && /tmp/explaincheck
```

Retained runner results: planner 59/59 and offline explainer 18/18. The removed live service runner no longer applies.

## Not verified / open

- Full Xcode app build. Signing and the missing `Resources/Secrets` blocked it on my machine; only the planner files plus the three shared model files were compiled together.
- Physical-device UI and airplane-mode walkthrough.
- Waiting on A: confirm `planDate` = wake day, and the bad-night threshold of 360 minutes.
- Edge case: an event starting before about 1 AM would clamp the wake time to local midnight.
