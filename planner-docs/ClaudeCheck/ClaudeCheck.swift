import Foundation

// Standalone check runner for ClaudeService. Uses fake transports only:
// no network, no API key. Compile with -parse-as-library.

@main
enum ClaudeCheck {
    final class Capture {
        var request: URLRequest?
        var calls = 0
    }

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
        let meeting = CalendarEvent(id: "m", title: "SECRET TITLE", start: meetingStart,
                                    end: meetingStart.addingTimeInterval(3600), isAllDay: false,
                                    timeZoneID: zoneID, destinationTimeZoneID: nil)

        let result = try! PlanEngine().makeResult(for: at(10, 26, 15, 30), profile: profile,
                                                  sleepSummary: sleep, events: [meeting])
        let offline = OfflineExplainer().explain(result)

        let apiURL = URL(string: "https://api.anthropic.com/v1/messages")!

        func jsonBody(text: String, stop: String = "end_turn") -> Data {
            let object: [String: Any] = ["content": [["type": "text", "text": text]], "stop_reason": stop]
            return try! JSONSerialization.data(withJSONObject: object)
        }

        func fake(status: Int = 200, body: Data) -> ClaudeService.Transport {
            return { _ in
                let response: URLResponse = HTTPURLResponse(url: apiURL, statusCode: status,
                                                            httpVersion: nil, headerFields: nil)!
                return (body, response)
            }
        }

        struct Boom: Error {}

        func service(_ transport: @escaping ClaudeService.Transport) -> ClaudeService {
            ClaudeService(credentials: { (apiKey: "test-key", model: "test-model") }, transport: transport)
        }

        // 1. No credentials: offline, and the network is never touched.
        do {
            let capture = Capture()
            let spy: ClaudeService.Transport = { _ in
                capture.calls += 1
                throw Boom()
            }
            let noCreds = ClaudeService(credentials: { nil }, transport: spy)
            let out = await noCreds.explain(result)
            expect(out.source == .offline, "no credentials: offline source")
            expect(out.text == offline, "no credentials: offline text")
            expect(capture.calls == 0, "no credentials: no network call")

            let emptyKey = ClaudeService(credentials: { (apiKey: "", model: "m") }, transport: spy)
            let out2 = await emptyKey.explain(result)
            expect(out2.source == .offline && capture.calls == 0, "empty key: offline, no network call")
        }

        // 2. Good rewrite that keeps the times is accepted.
        do {
            let live = "Rise and shine! " + offline
            let out = await service(fake(body: jsonBody(text: live))).explain(result)
            expect(out.source == .live, "valid rewrite: live source")
            expect(out.text == live, "valid rewrite: live text")
        }

        // 3. Rewrites that change, add, or drop a time are rejected.
        do {
            let changed = offline.replacingOccurrences(of: "6:00 AM", with: "5:00 AM")
            let out = await service(fake(body: jsonBody(text: changed))).explain(result)
            expect(out.source == .offline && out.text == offline, "changed time: falls back")

            let added = offline + " Maybe nap at 3:00 PM."
            let out2 = await service(fake(body: jsonBody(text: added))).explain(result)
            expect(out2.source == .offline, "added time: falls back")

            let dropped = "Sleep well tonight and get some light in the morning."
            let out3 = await service(fake(body: jsonBody(text: dropped))).explain(result)
            expect(out3.source == .offline, "dropped times: falls back")
        }

        // 4. Failures fall back to offline.
        do {
            let http500 = await service(fake(status: 500, body: jsonBody(text: offline))).explain(result)
            expect(http500.source == .offline, "HTTP 500: falls back")

            let throwing: ClaudeService.Transport = { _ in throw Boom() }
            let thrown = await service(throwing).explain(result)
            expect(thrown.source == .offline && thrown.text == offline, "transport error: falls back")

            let garbage = await service(fake(body: Data("not json".utf8))).explain(result)
            expect(garbage.source == .offline, "malformed JSON: falls back")

            let truncated = await service(fake(body: jsonBody(text: offline, stop: "max_tokens"))).explain(result)
            expect(truncated.source == .offline, "truncated response: falls back")

            let empty = await service(fake(body: jsonBody(text: "   "))).explain(result)
            expect(empty.source == .offline, "empty text: falls back")
        }

        // 5. The request itself: right endpoint, headers, body, and no calendar titles.
        do {
            let capture = Capture()
            let spy: ClaudeService.Transport = { request in
                capture.request = request
                capture.calls += 1
                let response: URLResponse = HTTPURLResponse(url: apiURL, statusCode: 200,
                                                            httpVersion: nil, headerFields: nil)!
                return (jsonBody(text: "Hi! " + offline), response)
            }
            _ = await service(spy).explain(result)
            expect(capture.calls == 1, "request: exactly one call")
            if let request = capture.request {
                expect(request.url?.absoluteString == "https://api.anthropic.com/v1/messages", "request: endpoint")
                expect(request.httpMethod == "POST", "request: POST")
                expect(request.value(forHTTPHeaderField: "x-api-key") == "test-key", "request: api key header")
                expect(request.value(forHTTPHeaderField: "anthropic-version") == "2023-06-01", "request: version header")
                expect(request.timeoutInterval == 6, "request: 6 second timeout")
                if let data = request.httpBody,
                   let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    expect(body["model"] as? String == "test-model", "request: model")
                    expect((body["max_tokens"] as? Int) == 300, "request: max_tokens")
                    let messages = body["messages"] as? [[String: Any]]
                    expect(messages?.first?["content"] as? String == offline, "request: sends the offline text")
                    let bodyText = String(decoding: data, as: UTF8.self)
                    expect(!bodyText.contains("SECRET"), "request: calendar title is never sent")
                } else {
                    expect(false, "request: body is valid JSON")
                }
            } else {
                expect(false, "request: was captured")
            }
        }

        // 6. Time token helper.
        do {
            let tokens = ClaudeService.timeTokens(in: "Wake at 6:00 AM, bed by 9:30 pm, not 6 AM.")
            expect(tokens == ["6:00AM", "9:30PM"], "time tokens normalized")
            expect(ClaudeService.keepsTimes(of: "At 6:00 AM.", in: "Around 6:00 am!"), "case-insensitive match")
            expect(!ClaudeService.keepsTimes(of: "At 6:00 AM.", in: "At 6 AM."), "format change is rejected")
        }

        print("\(checks) checks, \(failures) failures")
        exit(failures == 0 ? 0 : 1)
    }
}
