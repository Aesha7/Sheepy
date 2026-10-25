# Open Questions for A, C, and D

Please reply in a GitHub Issue or PR comment so decisions are tracked.

## For A (shared models and Xcode)

1. Do `SleepSummary`, `CalendarEvent`, `UserPreferences`, and `DailyPlan` already exist in `SharedModels.swift`? If not, who creates them?
2. What counts as a "bad night"? (Example: under 6 hours of sleep.)
3. How are flights marked in fixtures? (Example: an `isFlight` flag plus departure time zone.)
4. Can `DailyPlan` be `Codable`? It is needed to send plans to the live Claude backend.
5. Who compiles and tests B's files if B does not have Xcode?

## For C (UI)

1. Is a synchronous `makePlan(_:)` and an async `explain(plan:request:)` enough for your screens?
2. Can the "Why this plan?" button show an "Offline explanation" label when `source == .offline`?

## For D (demo data)

1. Please include fixtures for: no events, all-day only, 7 AM meeting, 10 AM meeting, shuffled multiple events, and a flight.
2. Can the demo include a bad-night sleep sample and a missing-data case?

## Assumption to confirm

Only events starting before 9:00 AM affect wake time. A 10 AM meeting produces the same plan as having no events.
