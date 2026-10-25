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

Recent sleep provides Enable Health and Refresh sleep. Authorization completion is
not presented as proof of read permission. Missing readable data does not imply
denial. Loading and errors come from the controller's provider-specific properties.
Switching back to demo invalidates outstanding provider work. See the Calendar and
HealthKit integration docs for permission and device testing details.

## Project membership

`scripts/generate_project.py` synchronizes Swift source membership in App, Models,
Services, and Views without replacing project settings, resources, or scheme.
It adds files but does not remove deleted sources; remove their target references
when deleting files. HealthKit entitlements and signing settings must be preserved.
