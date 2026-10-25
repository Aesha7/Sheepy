import Foundation

struct ExplanationOutput: Equatable {
    enum Source: Equatable {
        case offline
        case live
    }

    let text: String
    let source: Source
}

/// "Why this plan?" explanation.
///
/// The plan is always calculated first by `PlanEngine`, and the offline text is
/// always built first by `OfflineExplainer`. Claude is only asked to REWRITE that
/// text in a friendlier voice. The result is used only if it keeps exactly the
/// same times; any failure (no credentials, network, HTTP error, bad response,
/// changed times) falls back to the offline text, so the button never breaks.
///
/// Calendar titles are never sent. Credentials come from an injected closure so
/// no key is stored in this file.
struct ClaudeService {
    typealias Credentials = (apiKey: String, model: String)
    typealias Transport = (URLRequest) async throws -> (Data, URLResponse)

    var credentials: () -> Credentials?
    var timeout: TimeInterval
    var transport: Transport

    init(credentials: @escaping () -> Credentials?,
         timeout: TimeInterval = 6,
         transport: @escaping Transport = { try await URLSession.shared.data(for: $0) }) {
        self.credentials = credentials
        self.timeout = timeout
        self.transport = transport
    }

    func explain(_ result: PlanResult) async -> ExplanationOutput {
        let offline = OfflineExplainer().explain(result)
        let fallback = ExplanationOutput(text: offline, source: .offline)

        guard let creds = credentials(), !creds.apiKey.isEmpty, !creds.model.isEmpty else {
            return fallback
        }
        do {
            let live = try await requestRewrite(of: offline, credentials: creds)
            guard ClaudeService.keepsTimes(of: offline, in: live) else { return fallback }
            return ExplanationOutput(text: live, source: .live)
        } catch {
            return fallback
        }
    }

    // MARK: - Request

    static let systemPrompt = """
    You are the voice of Sleepy Sheep, a friendly sleep-planning assistant. \
    Rewrite the sleep plan explanation you are given in a warm, concise voice, \
    in 2 to 3 sentences of plain text with no lists and no markdown. \
    Keep every time exactly as written, in the same format such as 6:00 AM. \
    Do not add, remove, or change any times, and do not add medical claims or advice.
    """

    private enum ServiceError: Error {
        case badStatus
        case malformed
    }

    private func requestRewrite(of offline: String, credentials: Credentials) async throws -> String {
        var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue(credentials.apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")

        let body: [String: Any] = [
            "model": credentials.model,
            "max_tokens": 300,
            "system": ClaudeService.systemPrompt,
            "messages": [["role": "user", "content": offline]]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ServiceError.badStatus
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = object["content"] as? [[String: Any]] else {
            throw ServiceError.malformed
        }
        if let stop = object["stop_reason"] as? String, stop == "max_tokens" {
            throw ServiceError.malformed // truncated; do not show half a sentence
        }
        let text = content
            .compactMap { block -> String? in
                (block["type"] as? String) == "text" ? block["text"] as? String : nil
            }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw ServiceError.malformed }
        return text
    }

    // MARK: - Guard against changed times

    /// Normalized clock times found in the text, e.g. "6:00AM".
    static func timeTokens(in text: String) -> Set<String> {
        let pattern = #"\b\d{1,2}:\d{2}\s?[AP]M\b"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return []
        }
        let range = NSRange(text.startIndex..., in: text)
        var tokens = Set<String>()
        for match in regex.matches(in: text, range: range) {
            if let swiftRange = Range(match.range, in: text) {
                tokens.insert(String(text[swiftRange]).uppercased().replacingOccurrences(of: " ", with: ""))
            }
        }
        return tokens
    }

    /// true only when the rewrite mentions exactly the same times as the original.
    static func keepsTimes(of original: String, in candidate: String) -> Bool {
        timeTokens(in: candidate) == timeTokens(in: original)
    }
}
