import Foundation

@MainActor
enum LiveExplanationChecks {
    final class Pending {
        var continuation: CheckedContinuation<(Data, URLResponse), Error>?
        var request: URLRequest?
        func transport(_ request: URLRequest) async throws -> (Data, URLResponse) {
            self.request = request
            return try await withCheckedThrowingContinuation { continuation = $0 }
        }
        func complete() {
            let body = try! JSONSerialization.jsonObject(with: request!.httpBody!) as! [String: Any]
            let messages = body["messages"] as! [[String: Any]]
            let offline = messages[0]["content"] as! String
            let data = try! JSONSerialization.data(withJSONObject: [
                "content": [["type": "text", "text": "Claude rewrite: " + offline]],
                "stop_reason": "end_turn"
            ])
            let response = HTTPURLResponse(url: request!.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            continuation!.resume(returning: (data, response))
            continuation = nil
        }
    }

    static func run() async {
        let date = ISO8601DateFormatter().date(from: "2026-10-24T19:00:00Z")!
        let zone = TimeZone(identifier: "America/Los_Angeles")!
        // The stub configuration loader throws; no credentials or real network used.
        let missing = SleepController(referenceDate: date, timeZone: zone)
        let original = missing.planResult!
        await missing.requestLiveExplanation(for: missing.explanationRevision)
        precondition(missing.liveExplanation == nil && missing.liveExplanationError != nil)
        precondition(!missing.liveExplanationLoading && missing.planResult == original)

        let timeout = ClaudeService(credentials: { ("unit-test-key", "unit-test-model") },
                                    transport: { _ in throw URLError(.timedOut) })
        let timed = SleepController(referenceDate: date, timeZone: zone, explanationService: timeout)
        await timed.requestLiveExplanation(for: timed.explanationRevision)
        precondition(timed.liveExplanation == nil && timed.liveExplanationError != nil && timed.plan != nil)

        for mutation in 0...4 {
            let pending = Pending()
            let service = ClaudeService(credentials: { ("unit-test-key", "unit-test-model") },
                                        transport: { try await pending.transport($0) })
            let controller = SleepController(referenceDate: date, timeZone: zone, explanationService: service)
            let originalResult = controller.planResult!
            let revision = controller.explanationRevision
            let task = Task { await controller.requestLiveExplanation(for: revision) }
            for _ in 0..<1000 {
                if pending.continuation != nil { break }
                await Task.yield()
            }
            precondition(pending.continuation != nil && controller.liveExplanationLoading)
            switch mutation {
            case 1: controller.setDemoSleepScenario(.badNight)
            case 2: controller.resetPlanningDemo()
            case 3: controller.profile.preferredWakeHour = 8 // same anchor gives same plan
            case 4: controller.selectLivePlanning()
            default: break
            }
            if mutation == 3 { precondition(controller.planResult == originalResult) }
            pending.complete()
            await task.value
            precondition(!controller.liveExplanationLoading)
            if mutation == 0 {
                precondition(controller.liveExplanation?.source == .live)
                precondition(controller.planResult == originalResult)
            } else {
                precondition(controller.liveExplanation == nil && controller.liveExplanationError == nil)
                // An old confirmation cannot send a fresh plan after a mode/input change.
                await controller.requestLiveExplanation(for: revision)
                precondition(!controller.liveExplanationLoading && pending.continuation == nil)
            }
        }
        print("Live explanation integration checks passed (fake transport only): missing credentials, timeout, success and stale scenario/reset/profile/mode responses")
    }
}
