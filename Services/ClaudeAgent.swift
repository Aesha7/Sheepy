import Foundation

struct AgentConfiguration {
    let apiKey: String
    let model: String
    static func load() throws -> AgentConfiguration {
        guard let url = Bundle.main.url(forResource: "Secrets", withExtension: "plist"),
              let values = NSDictionary(contentsOf: url) as? [String: String],
              let key = values["ANTHROPIC_API_KEY"], !key.isEmpty,
              !key.contains("PASTE_"), let model = values["ANTHROPIC_MODEL"], !model.isEmpty else {
            throw SheepFailure("Add your API key and model ID to Resources/Secrets.plist, then rebuild. Manual lamp controls work without Claude.")
        }
        return AgentConfiguration(apiKey: key, model: model)
    }
}

@MainActor
final class ClaudeAgent {
    private var messages: [[String: Any]] = []
    private var running = false
    func reset() { messages = [] }

    func reply(to text: String, context: String,
               runTool: (String, [String: Any]) async throws -> String) async throws -> String {
        guard !running else { throw SheepFailure("An agent request is already running.") }
        running = true
        defer { running = false }
        let configuration = try AgentConfiguration.load()
        guard let promptURL = Bundle.main.url(forResource: "AGENT_PROMPT", withExtension: "md"),
              let toolsURL = Bundle.main.url(forResource: "tools", withExtension: "json") else {
            throw SheepFailure("Missing bundled prompt or tool definitions.")
        }
        let system = try String(contentsOf: promptURL, encoding: .utf8) + "\n\n" + context
        let tools = try JSONSerialization.jsonObject(with: Data(contentsOf: toolsURL))
        messages.append(["role": "user", "content": text])
        // Keep completed tool exchanges even if a later HTTP request fails:
        // discarding them could cause an already executed command to be repeated.
        for _ in 0..<12 {
            var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
            request.httpMethod = "POST"; request.timeoutInterval = 60
            request.setValue(configuration.apiKey, forHTTPHeaderField: "x-api-key")
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "model": configuration.model, "max_tokens": 1024, "system": system,
                "tools": tools, "messages": messages
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw SheepFailure("No Claude HTTP response.") }
            guard (200..<300).contains(response.statusCode) else {
                // Avoid surfacing request headers or secrets in logs/UI.
                throw SheepFailure("Claude returned HTTP \(response.statusCode). Check your key, model access, credits, or connection. Lamp commands already sent may still be running.")
            }
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let content = object["content"] as? [[String: Any]],
                  let stop = object["stop_reason"] as? String else {
                throw SheepFailure("Malformed Claude response.")
            }
            // Do not execute partial/truncated tool blocks.
            guard stop != "max_tokens" else { throw SheepFailure("Claude response was truncated. Try a shorter request; no tools from this response were run.") }
            let calls = content.filter { $0["type"] as? String == "tool_use" }
            if stop == "tool_use" {
                guard !calls.isEmpty, calls.allSatisfy({ $0["id"] is String && $0["name"] is String && $0["input"] is [String: Any] }) else {
                    throw SheepFailure("Claude returned an incomplete tool call.")
                }
                messages.append(["role": "assistant", "content": content])
                var results: [[String: Any]] = []
                for call in calls {
                    var result: [String: Any] = ["type": "tool_result", "tool_use_id": call["id"]!]
                    do { result["content"] = try await runTool(call["name"] as! String, call["input"] as! [String: Any]) }
                    catch { result["is_error"] = true; result["content"] = error.localizedDescription }
                    results.append(result)
                }
                messages.append(["role": "user", "content": results])
                continue
            }
            guard calls.isEmpty else { throw SheepFailure("Unexpected tool blocks; no commands were sent.") }
            messages.append(["role": "assistant", "content": content])
            let answer = content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            guard !answer.isEmpty else { throw SheepFailure("Claude returned no explanation (\(stop)).") }
            return answer
        }
        throw SheepFailure("Stopped after 12 tool rounds. Commands already sent may still be running; inspect status before continuing.")
    }
}
