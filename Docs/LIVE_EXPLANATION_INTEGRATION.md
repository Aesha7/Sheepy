# Completed explanation service integration

Verified ancestry: code `1683ff6`, handoff `4bb01f6`, both on origin/person-b-planning.
The working tree was clean before merging. The four B service files are target
members. Generator reruns are idempotent, preserving signing, HealthKit entitlements,
resources, deployment target, and scheme. Existing Calendar/Health and demo flows
remain in SleepController.

## Exact retained result and lifecycle

The sheet observes the app's existing controller. Its offline text comes immediately
from the retained result matching the displayed plan, using OfflineExplainer. It
never calls makeResult. It does not automatically contact Claude when opened.

```swift
@Published private(set) var explanationRevision: UUID
@Published private(set) var liveExplanation: PlanExplanation?
@Published private(set) var liveExplanationLoading: Bool
@Published private(set) var liveExplanationError: String?
func requestLiveExplanation(for revision: UUID) async
```

The service's `PlanExplanation` is the only response model: text plus `.offline` or
`.live` source. The controller retains live text only for `.live`; any fallback leaves
the original offline text visible with a generic failure/retry message. Missing
credentials never invoke the transport. The configured URLRequest timeout is six
seconds. Network, HTTP, malformed/truncated responses, or changed clock tokens also
fall back. B's clock-token validation is a limited consistency check, not a guarantee
that all rewritten meaning is unchanged. The computed timeline never changes from
a Claude response.

Every plan invalidation cancels the pending explanation task, creates a revision,
and clears prior live content/status. Profile, scenario, reset, and data-mode changes
invalidate even if resulting times are equal. A response must match the captured
revision and retained result. Confirmations also capture the revision, so confirming
an older prompt cannot send newly changed personal data. Cancellation plus revision
checks protect against transports that finish after cancellation.

## Explicit sharing and credentials

Opening the sheet displays only on-device text. Request Claude explanation presents
a confirmation before sending. In live mode, the disclosure states that the offline
text can reveal personal schedule times, sleep opportunity, and whether recent
sleep was short or unavailable. The exact user content is the offline text visible
in the sheet. It can also describe an early commitment or an explicitly marked
flight. Dates, timezone identifiers, names, calendar titles, event IDs, raw HealthKit
records, actual asleep sample intervals, and heart-rate readings are not sent.

The HTTP body also contains the configured model ID, B's static rewrite instruction,
and output-token limit; credentials are sent only in the API authentication header.
There is no added chat history or tool context. No request bodies or credentials are
logged by this integration. Both demo and live modes require the explicit confirmation.

The app injects a closure calling the existing `AgentConfiguration.load()` in
`Services/ClaudeAgent.swift`. The loader expects bundled `Secrets.plist`, sourced
from `Resources/Secrets.plist`, with `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`.
No second configuration file or loading path was added. Configuration is loaded
only when the explicit request reaches the service. ClaudeAgent chat behavior is
unchanged. During implementation, only this loader's Swift source was inspected;
no credential file was opened and no real API request was sent.

## Checks performed

- Handoff runners: planner 59/59, offline explainer 18/18, Claude service 27/27.
- Real-controller integration with isolated service/storage stubs: normal → bad
  night → reset, explanation consistency, nil/missing results, unavailable credentials,
  simulated timeout, fake success, and delayed stale scenario/reset/profile/mode
  responses. The profile case deliberately produces the same PlanResult.
- Existing Health/request tracking, Calendar mapping, and hardware protocol checks.
- Full SleepSheep Debug simulator build (signing disabled).

The real request, permission flows, physical UI, and device signing are not verified.
All request-related tests use fake transport or a missing-configuration stub.

## Real Claude test on the phone using demo data

1. In your local Xcode checkout, configure your own `Resources/Secrets.plist` with
   the existing API-key and model fields. Keep it ignored by Git. Do not paste its
   contents into logs, issues, or chat. Rebuild because configuration is bundled.
2. Build/install the SleepSheep scheme on the signed iPhone. Use **Reset demo** or
   **Back to demo data**; verify the Demo mode badge. Do not enable Calendar or
   Health for this test.
3. With airplane mode on, open **Why this plan?**. The Offline explanation should
   appear immediately and match all four timeline outputs. Try a confirmed Claude
   request: offline text must remain during loading and after failure.
4. Close the sheet, simulate a bad night, reopen it, and check the earlier caffeine
   cutoff and wind-down. Reset demo and confirm normal text/times are restored.
5. Enable network access while staying in demo mode. Open **Why this plan?**, tap
   **Request Claude explanation**, read the disclosure, then **Send to Anthropic**.
   Offline text remains visible. Only an accepted response receives the separate
   **Claude response** label; an error/fallback is not proof of live success.
6. Compare every displayed clock time with the timeline. Repeat the bad-night/reset
   sequence. Change inputs or mode while a request is pending if a debug harness
   permits it; old responses must never reappear.
7. To test missing configuration manually, use a separate local build with absent
   configuration and retry the explicit action. Do not modify or expose credentials
   merely to capture diagnostics. Automated checks already cover this without files.

Record device/model, whether the explicit request succeeded, and sanitized error/UI
behavior. Do not record keys, headers, or personal live payloads. No live success is
claimed by this handoff until step 5 is actually verified on-device.
