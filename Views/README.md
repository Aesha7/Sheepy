> **Which branch has the latest UI?** `person-c-ui`. It contains everything on
> `person-a-integration` plus the Sheepy look and dashboard polish, and merges into
> `person-a-integration` as a fast-forward once A has built it. The old `ui-person-c`
> branch was a first draft and has been deleted. `drift-agent` is the earlier laptop/web
> version, not the iOS app.

# Sheepy dashboard (Person C)

HomeView observes the app's existing SleepController. The header's **Lamp & chat**
opens ContentView with the same instance. The dashboard displays planning mode,
recent sleep, calendar commitments, all four plan outputs, Sheepy state, and quests.

## Why this plan?

Plan explanations are now entirely offline. Present `ExplanationView(controller:)`.
It renders the exact retained PlanResult through OfflineExplainer with the title
**Why this plan?** and a small **Generated on this device** label. Changes to the
result update text immediately; missing results show no old explanation.
There is no explanation service injection, request button, confirmation, network
loading/error state, retry, or fallback warning. No key is required. Do not change
the separate ClaudeAgent / Lamp & chat behavior.
See `Docs/OFFLINE_EXPLANATION_INTEGRATION.md` for the contract and checks.

## Planning and demo controls

The timeline reads all four outputs from controller.plan. Plan generation is owned
by the controller using B's PlanEngine. Simulate bad night uses a completed 330-minute
demo fixture and regenerates the plan; it is disabled for live data. Reset restores
the normal fixture and preserves the injected demo reference date. Provider and
planner errors are displayed separately. PreviewPlans is only used for previews.

## Calendar and Health

Enable Calendar switches to live only if necessary, explicitly requests access,
and then refreshes the next seven days. Refresh never prompts. Calendar occurrences
are keyed by (id, start, end). Empty, loading, error, and demo states are represented.

Recent sleep shows Enable Health until the authorization flow completes successfully
in this controller session, then hides it even when no sleep is readable. Errors and
cancellation leave setup available to retry. Completion is not proof of read permission.
The post-authorization fetch remains; there is no manual Refresh sleep button. Empty
results point to Health settings without implying denial. Loading and errors come
from the controller's provider-specific properties.
Switching back to demo invalidates outstanding provider work. See the Calendar and
HealthKit integration docs for permission and device testing details.

## Project membership

`scripts/generate_project.py` synchronizes Swift source membership in App, Models,
Services, and Views without replacing project settings, resources, or scheme.
It adds files but does not remove deleted sources; remove their target references
when deleting files. HealthKit entitlements and signing settings must be preserved.

## Sheepy look and layout (Person C)

- **Name:** the dashboard title is "Sheepy". The home-screen name comes from `CFBundleDisplayName` in
  `Resources/Info.plist` (A's file).
- **Colors** (`Theme` in `DashboardStyle.swift`): night-sky gradient from indigo `#0E1130` to violet `#1C1642`,
  indigo cards `#1F2149` with a faint lavender border, moonlight text `#EFF1FF`, secondary `#BCC2E6`, lavender
  actions `#B5A6F7`, periwinkle details `#94BDFF`, soft rose warnings `#F7A8C2`.
- **Sheepy figure** (`SheepyFigure` in `SheepyView.swift`): drawn after the 3D print (puffy wool, tan face, ears
  and feet, glossy eyes, small mouth) with lively, sleepy, sleeping, drained and neutral faces. Neutral is used
  when there's no sleep data. D's `sheepy-*` images replace it automatically if added to the asset catalog.
- **Layout:** large-title nav bar (solid once scrolled, so nothing runs under the Dynamic Island) with Lamp & chat
  in the toolbar; a top card with the Demo/Live switch, I slept poorly and Reset demo; then Sheepy, the plan with
  Why this plan? under the four times, recent sleep, calendar (next commitment, coming up, happening now) and
  quests. Source badges say "Demo data", "Live mode" (nothing loaded) or the provider name only when data loaded.
- **Explanation sheet:** a summary of the four times for the wake day in the plan's time zone and where the
  inputs came from, then the offline explanation one sentence per paragraph with "Generated on this device".

## Morning light hardware demo

Lamp & chat uses the existing controller and Bluetooth service. Start morning light
demo fades to 80% over 12 seconds (independent of Stage demo speedup). The next new
pat commands an immediate light-off; pats continue to be logged normally. A pat
received while the start command is pending is handled after that command completes.
Manual lamp commands, chat, disconnects and hardware switches disarm this behavior.
A failed off command shows an error and leaves Light off available for retry.
Keep the app open and connected: this is not a scheduled alarm or background service.
Simulated sheep exposes a Simulate wake-up pat button for an offline rehearsal.
No sleep duration is inferred from these pats, and no Health data is modified.
