import Foundation

// Standalone check runner for ExplanationAdapter. No network, no API key, no SwiftUI.
// Compile with -parse-as-library.

// Stand-ins matching C's types in Views/ExplanationView.swift (without SwiftUI).
struct PlanExplanation: Equatable {
    var text: String
    var isFallback: Bool
}

typealias PlanExplainer = @MainActor (DailyPlan) async throws -> PlanExplanation

@main
enum AdapterCheck {
    final class Box {
        var result: PlanResult?
        var lookups = 0
        var lastPlan: DailyPlan?
    }

    @MainActor
    static func main() async {
        var checks = 0
        var failures = 0

        func expect(_ ok: Bool, _ label: String) {
            checks += 1
            if !ok {
                failures += 1
                print("FAIL: \(label)")
            }
        }

        let zoneID = "America/Los_Angeles"
        let tz = TimeZone(identifier: zoneID)!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = tz
        let cal = calendar

        func at(_ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
            var c = DateComponents()
            c.year = 2026
            c.month = month
            c.day = day
            c.hour = hour
            c.minute = minute
            return cal.date(from: c)!
        }

        let profile = SleepProfile(preferredWakeHour: 7, preferredWakeMinute: 0,
                                   timeZoneID: zoneID, preparationMinutes: 60,
                                   targetSleepMinutes: 480)
        let sleepEnd = at(10, 25, 7)
        let sleep = SleepSummary(sleepStart: sleepEnd.addingTimeInterval(-480 * 60), sleepEnd: sleepEnd,
                                 totalAsleepMinutes: 480, averageHeartRateBPM: nil, provenance: .demo)
        let meetingStart = at(10, 26, 7)
        let meeting = CalendarEvent(id: "m", title: "Meeting", start: meetingStart,
                                    end: meetingStart.addingTimeInterval(3600), isAllDay: false,
                                    timeZoneID: zoneID, destinationTimeZoneID: nil)

        let result = try! PlanEngine().makeResult(for: at(10, 26, 15, 30), profile: profile,
                                                  sleepSummary: sleep, events: [meeting])
        let displayed = result.plan
        let offline = OfflineExplainer().explain(result)
        let apiURL = URL(string: "https://api.anthropic.com/v1/messages")!

        func jsonBody(_ text: String) -> Data {
            let object: [String: Any] = ["content": [["type": "text", "text": text]], "stop_reason": "end_turn"]
            return try! JSONSerialization.data(withJSONObject: object)
        }

        func respond(_ body: Data) -> URLResponse {
            HTTPURLResponse(url: apiURL, statusCode: 200, httpVersion: nil, headerFields: nil)!
        }

        struct Boom: Error {}

        func expectStale(_ explain: PlanExplainer, _ label: String) async {
            do {
                _ = try await explain(displayed)
                expect(false, "\(label): should throw")
            } catch let error as ExplanationAdapterError {
                expect(error == .stalePlan, label)
            } catch {
                expect(false, "\(label): wrong error type")
            }
        }

        // 1. No key: offline text, isFallback true, looked up before and after the request.
        do {
            let box = Box()
            box.result = result
            let explain = ExplanationAdapter.makeExplainer(
                resultFor: { plan in
                    box.lastPlan = plan
                    box.lookups += 1
                    return box.result
                },
                service: ClaudeService(credentials: { nil }))
            let out = try? await explain(displayed)
            expect(out == PlanExplanation(text: offline, isFallback: true), "no key: offline text, isFallback true")
            expect(box.lastPlan == displayed && box.lookups == 2, "no key: result looked up before and after")
        }

        // 2. Valid live rewrite: used, isFallback false.
        do {
            let live = "Rise and shine! " + offline
            let box = Box()
            box.result = result
            let service = ClaudeService(
                credentials: { (apiKey: "test-key", model: "test-model") },
                transport: { _ in (jsonBody(live), respond(jsonBody(live))) })
            let explain = ExplanationAdapter.makeExplainer(resultFor: { _ in box.result }, service: service)
            let out = try? await explain(displayed)
            expect(out == PlanExplanation(text: live, isFallback: false), "live rewrite: used, isFallback false")
        }

        // 3. Transport failure still gives the offline fallback.
        do {
            let box = Box()
            box.result = result
            let service = ClaudeService(
                credentials: { (apiKey: "test-key", model: "test-model") },
                transport: { _ in throw Boom() })
            let explain = ExplanationAdapter.makeExplainer(resultFor: { _ in box.result }, service: service)
            let out = try? await explain(displayed)
            expect(out == PlanExplanation(text: offline, isFallback: true), "network failure: offline fallback")
        }

        // 4. No current result for the displayed plan: rejected.
        do {
            let explain = ExplanationAdapter.makeExplainer(resultFor: { _ in nil },
                                                           service: ClaudeService(credentials: { nil }))
            await expectStale(explain, "missing result is rejected as stale")
        }

        // 5. The plan changes while the request is running: rejected.
        do {
            let box = Box()
            box.result = result
            let live = "Rise and shine! " + offline
            let service = ClaudeService(
                credentials: { (apiKey: "test-key", model: "test-model") },
                transport: { _ in
                    box.result = nil // controller invalidated the plan mid-request
                    return (jsonBody(live), respond(jsonBody(live)))
                })
            let explain = ExplanationAdapter.makeExplainer(resultFor: { _ in box.result }, service: service)
            await expectStale(explain, "plan changed during request is rejected as stale")
        }

        print("\(checks) checks, \(failures) failures")
        exit(failures == 0 ? 0 : 1)
    }
}
