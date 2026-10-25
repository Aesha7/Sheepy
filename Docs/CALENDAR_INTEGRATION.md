# Calendar integration for Person C

`SleepController` remains the main-actor observable app-state owner. The app targets
iOS 17+, uses one long-lived `CalendarService`/`EKEventStore` per controller, and
requests full event access. It does not write calendar events.

Controller entry points:

```swift
func selectLivePlanning()
@discardableResult func requestCalendarAccess() async -> Bool
func refreshLiveCalendarEvents(in interval: DateInterval) async
func loadPlanningDemo(referenceDate: Date, timeZone: TimeZone)
```

Selecting live mode alone never prompts. From an explicit Enable Calendar button:

```swift
Task { @MainActor in
    controller.selectLivePlanning()
    if await controller.requestCalendarAccess() {
        await controller.refreshLiveCalendarEvents(in: interval)
    }
}
```

For refresh (including after returning from Settings), call only
`refreshLiveCalendarEvents(in:)`. It checks current authorization and never prompts.
Observe `planningLoading`, `planningError`, and `calendarEvents`. Disable repeated
calendar actions while loading. An empty array with no error is a successful empty
result. Fetch failures clear old events and plans. Successful refresh also clears
the old plan so Person B can regenerate it. No planning rules run here.

Demo loading and live-mode selection invalidate outstanding requests, including a
demo → live round trip. Stale completions cannot modify data, errors, or loading
state. A system permission dialog already shown cannot be withdrawn by the app.

Events use half-open overlap: `start < interval.end && end > interval.start`.
Zero-duration events are points included at the lower boundary and excluded at the
upper boundary. All-day dates remain EventKit's Dates without timezone conversion.
Missing event timezone remains nil; destination timezone always remains nil.
Source identifiers are preserved (calendarItemIdentifier is a fallback). EventKit
identifiers can change after sync; recurring occurrences can share an identifier.
If displaying multiple occurrences in SwiftUI, use `(id, start, end)` as the row key.
Queries are chunked below EventKit's four-year predicate limit, and duplicate
occurrences across chunks are removed.

## Verification

The standalone `Tests/CalendarMappingChecks.swift` exercises pure mapping without
opening a store or requesting access. Build it with the planning models/interfaces,
SheepProtocol, and CalendarService, linking EventKit, on macOS 14+.

On a physical iPhone using Person C's buttons (no calendar UI is added here):

1. Fresh permission state: select live mode and verify no dialog. Refresh before
   granting access; verify an authorization error and no permission prompt.
2. Tap Enable Calendar, grant Full Access, and refresh. Compare timed, all-day,
   recurring, and timezone-specific events with Calendar. Test events that end at
   the query start or begin at its end; both should be excluded.
3. Query an empty interval of calendar data; expect no events and no error.
4. Deny access, then retry. Verify the error directs the user to Settings. Enable
   access in Settings and refresh; revoke it and refresh again. Test restricted
   access on a managed/restricted device if available.
5. While the permission request is outstanding, load demo inputs, then resolve
   the dialog. Demo events, mode, loading, and errors must remain unchanged. Repeat
   with demo → live before resolving to check stale completion rejection.
6. Confirm Bluetooth connection, lamp fades, and chat still work.

Permission dialogs, real-store fetching, Settings changes, and device restrictions
require device validation; the mapping checks do not verify those behaviors.
