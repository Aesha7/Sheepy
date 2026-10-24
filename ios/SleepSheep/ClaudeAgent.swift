// The Drift agent on the phone: Claude decides, tools act on the sheep over Bluetooth.
// There is no official Anthropic Swift SDK, so this calls POST /v1/messages with URLSession.
// The system prompt and tool JSON are generated from the web agent (`npm run export-agent`), so both match.
// API key: put it in Secrets.plist (not committed). Fine for a private demo build; revoke it after the hackathon.

import Foundation

struct AgentStep: Identifiable {
    let id = UUID()
    let tool: String
    let input: String
    let output: String
    let isError: Bool
}

struct ScheduledAction: Identifiable {
    let id: String
    let at: Date
    let brightness: Int
    let minutes: Double
    let note: String
}

/// Safety floor that the model can't get around: no flashing (rapid light reversals or bursts of changes).
struct LampGuard {
    private var history: [(at: Date, brightness: Int, dir: Int)] = []

    mutating func check(_ brightness: Int, current: Int?, now: Date = Date()) -> String? {
        history.removeAll { now.timeIntervalSince($0.at) > 60 }
        if history.count >= 6 { return "Refused: too many light changes in the last minute. Rapid changes look like flashing. Send one slow fade." }
        let from = current ?? history.last?.brightness ?? 0
        let dir = brightness > from ? 1 : (brightness < from ? -1 : 0)
        if let last = history.last, dir != 0, last.dir != 0, dir != last.dir, now.timeIntervalSince(last.at) < 15 {
            return "Refused: reversing the light within 15 seconds would flash. Wait, or use one slow fade."
        }
        history.append((now, brightness, dir))
        return nil
    }
}

@MainActor
final class ClaudeAgent: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var note = ""
    @Published private(set) var steps: [AgentStep] = []
    @Published private(set) var error: String?
    @Published private(set) var scheduled: [ScheduledAction] = []
    @Published private(set) var stopped = false

    let sheep: SheepBluetooth
    var model = "claude-opus-5-5"
    var effort = "medium"

    private let apiKey: String
    private let driftServer: URL?
    private let systemPrompt: String
    private let tools: [[String: Any]]
    private var task: Task<Void, Never>?
    private var timers: [String: Task<Void, Never>] = [:]
    private var guardRail = LampGuard()
    private var nextId = 1

    init(sheep: SheepBluetooth) {
        self.sheep = sheep
        let secrets = Bundle.main.url(forResource: "Secrets", withExtension: "plist")
            .flatMap { NSDictionary(contentsOf: $0) as? [String: Any] } ?? [:]
        apiKey = secrets["ANTHROPIC_API_KEY"] as? String ?? ""
        driftServer = (secrets["DRIFT_SERVER_URL"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
        systemPrompt = Bundle.main.url(forResource: "system-prompt", withExtension: "txt")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        tools = Bundle.main.url(forResource: "tools", withExtension: "json")
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
    }

    var isConfigured: Bool { !apiKey.isEmpty && !systemPrompt.isEmpty && !tools.isEmpty }

    // MARK: Run / Stop

    /// One agent run, woken by an event (e.g. "the person tapped Run", "head pat", "wind-down started").
    func run(event: String, settings: String) {
        guard !running, !stopped else { return }
        guard isConfigured else {
            error = "Add ANTHROPIC_API_KEY to Secrets.plist and include system-prompt.txt and tools.json in the app target."
            return
        }
        running = true
        error = nil
        steps = []
        task = Task { await self.loop(event: event, settings: settings) }
    }

    /// Stop wins: cancel the run, drop scheduled actions, hold the light where it is.
    func stop() {
        stopped = true
        task?.cancel()
        timers.values.forEach { $0.cancel() }
        timers.removeAll()
        scheduled.removeAll()
        if let level = sheep.status?.level {
            Task { _ = try? await sheep.setLamp(brightness: Double(level), minutes: 0) }
        }
        running = false
        note = "Stopped. Nothing changes until you resume."
    }

    func resume() {
        stopped = false
        note = ""
    }

    private func loop(event: String, settings: String) async {
        defer { running = false }
        var messages: [[String: Any]] = [[
            "role": "user",
            "content": "Event: \(event)\nLocal time: \(Date().formatted(date: .abbreviated, time: .shortened)) (\(TimeZone.current.identifier))\nSettings on this phone: \(settings)\n\nDecide what the sheep's light should do now and later tonight, act with the tools, then reply with your note to the person.",
        ]]
        do {
            for _ in 0..<10 {
                try Task.checkCancellation()
                let res = try await send(messages)
                let content = res["content"] as? [[String: Any]] ?? []
                let stop = res["stop_reason"] as? String ?? ""
                if stop == "refusal" { throw AgentError.message("The model declined this request.") }
                if stop == "max_tokens" { throw AgentError.message("The reply was cut off.") }
                let toolUses = content.filter { $0["type"] as? String == "tool_use" }
                if stop != "tool_use" || toolUses.isEmpty {
                    note = content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
                    return
                }
                // Append the assistant turn unchanged, then all tool results in one user message.
                messages.append(["role": "assistant", "content": content])
                var results: [[String: Any]] = []
                for tu in toolUses {
                    let name = tu["name"] as? String ?? ""
                    let input = tu["input"] as? [String: Any] ?? [:]
                    let id = tu["id"] as? String ?? ""
                    do {
                        let out = try await execute(name, input)
                        results.append(["type": "tool_result", "tool_use_id": id, "content": out])
                        steps.append(AgentStep(tool: name, input: json(input), output: out, isError: false))
                    } catch {
                        results.append(["type": "tool_result", "tool_use_id": id, "is_error": true, "content": error.localizedDescription])
                        steps.append(AgentStep(tool: name, input: json(input), output: error.localizedDescription, isError: true))
                    }
                }
                messages.append(["role": "user", "content": results])
            }
            throw AgentError.message("The agent didn't finish within 10 steps.")
        } catch is CancellationError {
            note = "Stopped."
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func send(_ messages: [[String: Any]]) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        // A declined request is re-run on Anthropic's recommended fallback model.
        req.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        let body: [String: Any] = [
            "model": model,
            "max_tokens": 16000,
            "fallbacks": "default",
            "output_config": ["effort": effort],
            "system": [["type": "text", "text": systemPrompt, "cache_control": ["type": "ephemeral"]]],
            "tools": tools,
            "messages": messages,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let msg = (obj["error"] as? [String: Any])?["message"] as? String ?? "HTTP \(status)"
            throw AgentError.message(status == 401 ? "API key rejected. Check Secrets.plist." : "Claude API error: \(msg)")
        }
        return obj
    }

    // MARK: Tools

    private func execute(_ name: String, _ input: [String: Any]) async throws -> String {
        if stopped { throw AgentError.message("Stopped by the person. Nothing changes until they resume.") }
        switch name {
        case "set_lamp":
            let b = Int((input["brightness"] as? NSNumber)?.doubleValue ?? 0)
            let m = (input["minutes"] as? NSNumber)?.doubleValue ?? 0
            if let refusal = guardRail.check(b, current: sheep.status?.target) { throw AgentError.message(refusal) }
            let s = try await sheep.setLamp(brightness: Double(b), minutes: m)
            return json(["ok": true, "pats": s.pats, "light": s.light, "level": s.level, "target": s.target,
                         "requested": ["brightness": b, "minutes": m] as [String: Any], "demoSpeedup": SheepBluetooth.demoSpeedup] as [String: Any])
        case "get_status":
            let s = try await sheep.getStatus()
            return json(["pats": s.pats, "light": s.light, "level": s.level, "target": s.target])
        case "read_pat_log":
            let limit = (input["limit"] as? NSNumber)?.intValue ?? 50
            let iso = ISO8601DateFormatter()
            let rows = sheep.pats.suffix(max(1, min(200, limit))).map { ["ts": iso.string(from: $0.date), "count_since_boot": $0.countSinceBoot] as [String: Any] }
            return json(["pats": rows])
        case "schedule_action":
            return try schedule(input)
        case "list_scheduled":
            return json(["scheduled": scheduled.map { ["id": $0.id, "at": $0.at.formatted(date: .omitted, time: .shortened), "brightness": $0.brightness, "minutes": $0.minutes, "note": $0.note] as [String: Any] }])
        case "cancel_scheduled":
            let id = input["id"] as? String ?? ""
            guard let t = timers.removeValue(forKey: id) else { throw AgentError.message("No scheduled action \(id)") }
            t.cancel()
            scheduled.removeAll { $0.id == id }
            return json(["cancelled": id])
        case "get_drift_context":
            guard let base = driftServer else { throw AgentError.message("No Drift server configured (DRIFT_SERVER_URL in Secrets.plist).") }
            let (data, resp) = try await URLSession.shared.data(from: base.appendingPathComponent("api/agent/context"))
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw AgentError.message("Drift server didn't answer. Is the laptop on the same Wi-Fi?") }
            return String(decoding: data, as: UTF8.self)
        default:
            throw AgentError.message("Unknown tool \(name)")
        }
    }

    /// set_lamp later tonight at a local "HH:MM" (next occurrence). Timers only fire while the app is open.
    private func schedule(_ input: [String: Any]) throws -> String {
        guard (input["action"] as? String) == "set_lamp" else { throw AgentError.message("Only set_lamp can be scheduled on the phone.") }
        let parts = (input["at"] as? String ?? "").split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else { throw AgentError.message("at must be a local time like 06:40") }
        var when = Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date())!
        if when <= Date().addingTimeInterval(30) { when = Calendar.current.date(byAdding: .day, value: 1, to: when)! }
        let b = Int((input["brightness"] as? NSNumber)?.doubleValue ?? 0)
        let m = (input["minutes"] as? NSNumber)?.doubleValue ?? 0
        let id = "s\(nextId)"
        nextId += 1
        let item = ScheduledAction(id: id, at: when, brightness: b, minutes: m, note: input["note"] as? String ?? "")
        scheduled.append(item)
        timers[id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, when.timeIntervalSinceNow) * 1_000_000_000))
            guard !Task.isCancelled, let self, !self.stopped else { return }
            _ = try? await self.sheep.setLamp(brightness: Double(b), minutes: m)
            self.scheduled.removeAll { $0.id == id }
            self.timers[id] = nil
        }
        return json(["scheduled": ["id": id, "at": when.formatted(date: .omitted, time: .shortened), "brightness": b, "minutes": m] as [String: Any]])
    }

    private func json(_ obj: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

enum AgentError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let m) = self { return m }; return nil }
}
