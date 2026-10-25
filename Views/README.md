> Current explanation UI: offline text is immediate; **Request Claude explanation**
> asks for confirmation before sending the visible explanation to Anthropic. The
> response is labeled **Claude response** only on accepted live success. See
> `Docs/LIVE_EXPLANATION_INTEGRATION.md`; older handoff notes below are historical.

> Offline explanation is now integrated from B’s `10384cb`. The sheet receives the
> retained `PlanResult`, refreshes on complete-result changes, and explicitly labels
> on-device text as “Offline explanation.” The original handoff notes below are
> historical; see `Docs/PLANNER_INTEGRATION.md` for the current contract.

# Sheepy UI (Person C)

The redesigned dashboard, originally built on `SleepController` and the shared models from `person-a-integration` (`c3ea324`).
Only `Views/` is new; no shared models, services, app entry point or project files were changed.

**Integration status:** merged into person-a-integration and compiled with the actual SleepSheep simulator scheme. iOS 17.

The app now presents `HomeView` with its existing controller. **Lamp & chat** opens
`ContentView` using that same instance. Runtime plans now come from B’s PlanEngine through SleepController. Preview plans remain preview-only.
The demo bad-night and reset controls regenerate all four timeline outputs locally.
See `Docs/PLANNER_INTEGRATION.md` for the retained PlanResult/explanation contract.

**Health integration added by A:** Recent sleep now has explicit **Enable Health**
and **Refresh sleep** actions. Enable switches to live only when necessary, awaits
`requestHealthAccess()`, then calls `refreshLiveSleepSummary(before:)`. Completion
is not represented as read permission. Loading, errors, no readable sleep, and demo
provenance are displayed in the existing sleep card. See `Docs/HEALTHKIT_INTEGRATION.md`.

Calendar follows the same live-only transition rule so enabling it does not erase
already-loaded Health state. Each card reads its provider-specific loading/error
properties from SleepController. Combined request tracking and mode invalidation
remain in the controller; cards do not infer their errors from aggregated text.

The generator now synchronizes source membership in place, including Views, without
replacing settings, resources, entitlements, or schemes. It does not open credentials.
The instructions below describe C's original handoff; entry-point and generator
integration are now complete.

## For A: adding it to the app

1. `scripts/generate_project.py` only collects Swift files from `App`, `Models` and `Services`. Add `"Views"` to that
   folder list (line 18) and regenerate.
2. Show the dashboard from the app entry point:

   ```swift
   WindowGroup { HomeView(controller: controller) }
   ```

   The existing sheep controls and Claude chat in `ContentView` aren't part of the dashboard. Keep them reachable
   however you prefer (a tab, or a button that opens `ContentView` in a sheet).

3. When B's planner and the explanation service are ready, pass them in:

   ```swift
   HomeView(
       controller: controller,
       reportBadNight: { await controller.reportBadNight() },   // A/B: replan, update controller.plan
       explain: { plan in try await explainer.explain(plan) }   // B: returns PlanExplanation
   )
   ```

   Until then both are `nil`: the bad-night button is disabled with "Replanning connects when the planner is ready",
   and "Why this plan?" says explanations aren't connected yet.

## What the UI reads from SleepController

| Field | Shown as |
|---|---|
| `planningDataMode` | "Demo mode" / "Live" header badge; calendar card's source badge; bad-night label ("Simulate bad night" in demo, "I slept poorly" live); Reset demo button (demo only) |
| `sleepSummary` | Last night: duration, sleep window, heart rate only when present, badge from its own `provenance`. `nil` shows "No sleep data for last night" (never "access denied") |
| `calendarEvents` | Calendar card: the next commitment (earliest event that hasn't ended, in its own time zone, all-day aware, destination time zone if supplied) and up to four more as "Coming up", keyed by `(id, start, end)` |
| `plan` | Timeline of the four recommendations in `plan.timeZoneID`, Today/Tomorrow from `planDate`. **`nil` is handled**: "will appear here once your plan is ready" |
| `planningLoading`, `planningError` | Progress while building/replanning; error in place of the plan, or a "still showing your last plan" banner if one exists |
| `sheepyState` | Sheepy's image, label and a one-line status |
| `quests` | Edited through a binding (`$controller.quests`), so the controller keeps the only copy |
| `profile.timeZoneID` | Time zone for the sleep card and for Reset demo |

## Calendar (per Docs/CALENDAR_INTEGRATION.md)

- **Enable Calendar** (calendar card): `selectLivePlanning()` → `await requestCalendarAccess()` → if granted,
  `refreshLiveCalendarEvents(in:)` for the next 7 days from now. Nothing prompts until this button is tapped.
- Once a fetch succeeds the button becomes **Refresh**, which only calls `refreshLiveCalendarEvents(in:)` (never
  prompts; picks up access granted later in Settings). After an error, Enable Calendar stays for retrying and a
  **Settings** button appears.
- `planningLoading`/`planningError` are shared by calendar and planning work, so the view tracks which action is running:
  calendar loading and errors show on the calendar card, not as "Couldn't build your plan", and the bad-night button
  doesn't say "Updating your plan…" while the calendar loads. Only the latest calendar tap can update the card.
- **Back to demo data** (shown in live mode in place of Reset demo) calls `loadPlanningDemo`, which supersedes any
  outstanding calendar request.

Reset demo calls `controller.loadPlanningDemo(referenceDate:timeZone:)`, which sets `plan = nil`; whoever connects the
planner should generate a fresh plan after it.

## Asks

- **A:** the generator change and entry point above; a `reportBadNight` that sets `planningLoading`/`planningError`
  and, in demo mode, uses a simulated short night without writing to HealthKit.
- **B:** the explanation as `PlanExplanation(text:isFallback:)` (defined in `ExplanationView.swift`; happy to move or
  rename it to match yours). Throw when there's no fallback either. The sheet re-asks when the plan changes and drops
  replies for an older plan.
- **D:** four matching images named `sheepy-lively`, `sheepy-sleepy`, `sheepy-sleeping`, `sheepy-drained` in the
  asset catalog (they replace the drawn placeholder automatically), three demo quests instead of one, final copy for
  the Sheepy status lines (`SheepyState.defaultStatus` in `SheepyView.swift`).

## Files

| File | What it is |
|---|---|
| `HomeView.swift` | The scrolling dashboard, the calendar actions, and previews (including a clickable connected flow) |
| `CalendarCard.swift` | Next commitment, coming-up list, Enable Calendar / Refresh / Settings, loading and errors |
| `SleepSummaryView.swift` | Last night's sleep |
| `TimelineView.swift` | `PlanTimelineView` (named so it doesn't hide SwiftUI's `TimelineView`); marks steps that changed since the previous plan with "Updated · was …" |
| `SheepyView.swift` | Four states, D's images if present, otherwise a labeled placeholder drawing; respects Reduce Motion |
| `QuestsView.swift` | Quests with progress and 44 pt tap targets |
| `ExplanationView.swift` | Loading / success / "Offline explanation" / error + retry / not connected |
| `DashboardStyle.swift` | Theme, cards, source badge, date/time formatting in a given time zone |
| `PreviewPlans.swift` | Fixed sample `DailyPlan`s for previews only, until B's planner exists |

## Demo run (with D)

Reset demo → last night's sleep and its source → tomorrow's early commitment → the four recommendations → Simulate bad
night (shows progress, can't be double-tapped) → timeline marks what changed and Sheepy updates → check a quest → Why
this plan? → Reset demo, and repeat without restarting the app.
