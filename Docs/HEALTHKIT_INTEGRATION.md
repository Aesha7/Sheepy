# HealthKit integration

`HealthKitService` conforms to the unchanged `SleepProviding` interface:

```swift
let dataMode: PlanningDataMode = .live
func requestAccess() async throws
func sleepSummary(before referenceDate: Date) async throws -> SleepSummary?
```

The service checks HealthKit availability before accessing its long-lived, lazily
created HKHealthStore. Authorization is an explicit operation, requesting only read
access to sleepAnalysis and heartRate, with an empty write set. Refresh never asks
for permission. Completion of authorization does not prove read permission, and
empty results do not distinguish denial from no data. The service does not use
`authorizationStatus(for:)` to infer read permission.

## Person C's controller methods

```swift
@discardableResult func requestHealthAccess() async -> Bool
func refreshLiveSleepSummary(before referenceDate: Date) async
```

Use the existing `selectLivePlanning()` to change mode without prompting. From an
explicit Enable Health button, await `requestHealthAccess()`, then refresh if it
returns true. That Bool means the authorization operation completed and is still
current; do not display “read access granted.” For subsequent refreshes, call only
`refreshLiveSleepSummary(before:)`. A nil summary should be described as “No readable
recent overnight sleep,” with an optional suggestion to review Health access.

Observe `sleepSummary`, `planningLoading`, and `planningError`. Calendar entry
points are unchanged. Calendar and Health requests have independent tokens and
error slots. Loading stays true until all requests in the current mode finish;
a successful Health operation cannot clear a Calendar error and vice versa.
Starting a new operation clears only that provider's error. Within each provider,
the latest request owns state updates. Mode changes invalidate all outstanding
requests, including demo → live round trips. Already displayed system dialogs
cannot be dismissed by this mechanism. Stale work may finish locally but cannot
replace current data or errors. Refresh clears the previous plan for B to regenerate.

No UI, planning rules, or changes to Bluetooth/chat are included. Health samples
are queried and reduced on-device, held transiently in memory, never logged,
persisted by this code, or added to Claude context/tools. Only SleepSummary reaches
controller state. A future chat integration must not silently add health data.

## Session-selection heuristic

This is a bounded heuristic for overnight sleep, not clinical sleep detection:

- Look back exactly 14 × 24 hours from the injected reference date. Query overlapping
  samples, including any known interval that crosses the reference boundary.
- Keep only asleepCore, asleepDeep, asleepREM, and asleepUnspecified. Ignore inBed
  and awake. Group by source bundle identifier, without mixing sources. Multiple
  devices publishing under the same source bundle are treated as one source.
- Use Gregorian noon-to-noon local-day buckets in the service's injected timezone
  (controller initialization timezone by default). This is not inferred travel
  timezone metadata. Each bucket is processed independently; nights never join.
- Within a bucket, merge overlapping/touching asleep intervals. Gaps up to 90
  minutes remain part of a session but are excluded from asleep duration. Longer
  gaps split sessions. Keep sessions with at least two hours of merged asleep time,
  at most 16 hours elapsed, some asleep time between local midnight and 6 AM, and
  no spill past the following noon.
- Require the entire session to start within the lookback and end on or before
  referenceDate. A known interval crossing referenceDate excludes its session;
  it is not clipped into a falsely completed night. Exact end equality is allowed.
- Choose the qualifying session with latest end, then most asleep duration, then
  source bundle identifier as a deterministic tie-break. No source data is blended.
- Completion means the latest available recorded intervals have ended; HealthKit
  cannot guarantee that more stages will not arrive later. Naps, daytime/shift-work
  sleep, unusually fragmented nights, and sessions outside these bounds may be
  excluded. Refresh after source synchronization to incorporate new data.
- Total asleep minutes is the floor of merged asleep seconds / 60. Start/end are
  the first/last asleep bounds, so elapsed time can exceed total asleep time.

Heart rate is queried only across the selected session. Keep positive finite BPM
readings whose start timestamp lies in a merged asleep interval `[start, end)`.
Use readings from the sleep source if available; otherwise choose one HR source
with the most qualifying readings (bundle identifier breaks ties). Report the
arithmetic sample mean, not a time-weighted mean. Missing, unreadable, or failed HR
queries yield nil HR without discarding sleep. Sleep query errors surface through
planningError; successful queries with no qualifying session return nil. All
returned summaries have `.live` provenance.

## Configuration and verification

The actual target uses `Resources/Info.plist`, now containing
`NSHealthShareUsageDescription`, and `Resources/SleepSheep.entitlements`, containing
`com.apple.developer.healthkit = true`. Both Debug and Release set
`CODE_SIGN_ENTITLEMENTS` to that path. No update usage description is added because
no writes are requested. iOS 17 is the deployment target.

Run the pure checks without HealthKit access:

```sh
swiftc -module-cache-path /tmp/sleep-sheep-swift-cache \
  Models/PlanningModels.swift Models/PlanningRequests.swift \
  Services/SleepSessionProcessor.swift Tests/HealthSleepChecks.swift \
  -o /tmp/health-sleep-checks
/tmp/health-sleep-checks
```

These cover overlapping/duplicate intervals, source isolation, multiple nights,
reference boundaries, lookback, daytime exclusion, awake gaps, missing HR, empty
samples, and concurrent/stale request tracking. They do not access a user's Health
store or validate a system permission sheet.

Physical iPhone checks, through Person C's UI or a local debug harness:

1. Ensure the signing team/App ID and provisioning profile support HealthKit.
   Build/install the signed app. Capability/provisioning errors are signing blockers,
   not Swift compilation errors. The unsigned simulator build does not verify this.
2. Select live mode and verify no prompt. Explicitly enable Health: the permission
   sheet should offer read access to Sleep and Heart Rate only, with no writes.
3. Allow both, refresh after a synced completed night, and compare the summary with
   Health's source samples using the documented heuristic. Check `.live` provenance.
4. Allow sleep but disable HR; readable sleep must remain with nil HR. Test no
   samples and denied sleep access; never claim denial from an empty result or
   claim grant solely from authorization completion.
5. Test unsupported-device availability and query failures where possible. Verify
   errors are separate from successful empty results.
6. Start Calendar and Health operations together; completing one must leave loading
   true while the other runs, and must not clear the other provider's error.
7. While authorization/query is pending, load demo inputs (also try demo → live),
   then finish the old operation. Current state must remain unchanged.
8. Smoke-test Calendar refresh, demo fixtures, Bluetooth lamp controls, and chat.

Reference: [Apple's HealthKit authorization guidance](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data).
