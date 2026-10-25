# Planner Interface Proposal (Person B)

**Status:** Draft, awaiting feedback from A and C
**Owner:** Person B
**Note:** Type names below are provisional. They will be aligned with `SharedModels.swift` once A confirms. No duplicate models will be created.

## Goal

C's screen needs two calls: one synchronous call to build the plan, and one async call to explain it. Everything else is internal to B.

## Proposed API

```swift
struct PlanRequest {
    var targetWakeDate: Date          // Date the user wakes up (e.g. tomorrow)
    var timeZone: TimeZone            // Planning time zone
    var sleepSummary: SleepSummary?   // nil = no sleep data
    var events: [CalendarEvent]       // Order is NOT guaranteed
    var preferences: UserPreferences
    var badNightOverride: Bool?       // nil = infer from sleep data; used for demo toggle
}

enum PlanEngine {
    static func makePlan(_ request: PlanRequest) -> DailyPlan
}

enum ExplanationSource { case offline, live }

struct PlanExplanation {
    var text: String
    var source: ExplanationSource
}

enum ClaudeService {
    /// Falls back to the offline explanation automatically if the live call fails.
    static func explain(plan: DailyPlan, request: PlanRequest) async -> PlanExplanation
}
```

## Required `DailyPlan` fields

- `wakeTime`
- `lightReminder`
- `caffeineCutoff`
- `windDownStart`
- `plannedBedtime`
- `anchorEvent` (the event that determined wake time, or `nil`)
- `isBadNightAdjusted`

## Prototype rules (not medically validated)

| Item | Rule |
|---|---|
| Default wake | 7:30 AM |
| Commitment buffer | Wake at least 60 min before the commitment |
| Early commitment | Timed event starting before 9:00 AM |
| Sleep opportunity | 8 hours |
| Bad-night adjustment | +30 min sleep opportunity, wake time stays fixed |
| Light reminder | Wake + 30 min |
| Caffeine cutoff | Planned bedtime - 8 hours |
| Wind-down | Planned bedtime - 60 min |

## Calendar classifier rules

- Only timed events on the target date are considered.
- All-day events are ignored when choosing wake time.
- The earliest relevant event wins, regardless of array order.
- Flights are recognized only via explicit fixture metadata. Free-text calendar titles never invent a destination or time zone.

## Design decisions

- **Date math:** use `Calendar` / `Date` arithmetic with the planning `TimeZone`. Do not subtract clock times manually.
- **Daylight saving:** "8 hours before" means elapsed time, not wall-clock difference.
- **Offline first:** `explain` must work with no network. Live Claude is an enhancement.
- **API key:** lives only in backend secrets. Never in Swift code, GitHub, or chat.

## Open questions

See `open-questions.md`.
