import Foundation

/// Tracks independent providers and ignores completions from older modes/requests.
struct PlanningRequests {
    enum Provider: CaseIterable { case calendar, health }
    private var active: [UUID: Provider] = [:]
    private var latest: [Provider: UUID] = [:]
    private var errors: [Provider: String] = [:]
    func loading(for provider: Provider) -> Bool { active.values.contains(provider) }
    func error(for provider: Provider) -> String? { errors[provider] }
    var loading: Bool { !active.isEmpty }
    var error: String? {
        let messages = Provider.allCases.compactMap { errors[$0] }
        return messages.isEmpty ? nil : messages.joined(separator: "\n")
    }
    mutating func begin(_ provider: Provider) -> UUID {
        let token = UUID()
        latest[provider] = token
        active[token] = provider
        errors[provider] = nil
        return token
    }
    func isCurrent(_ token: UUID, for provider: Provider) -> Bool { latest[provider] == token }
    mutating func fail(_ message: String, token: UUID, provider: Provider) {
        guard isCurrent(token, for: provider) else { return }
        errors[provider] = message
    }
    mutating func finish(_ token: UUID) { active[token] = nil }
    mutating func reset() { self = PlanningRequests() }
}
