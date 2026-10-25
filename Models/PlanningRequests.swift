import Foundation

/// Tracks independent providers and ignores completions from older modes/requests.
struct PlanningRequests {
    enum Provider: CaseIterable { case calendar, health }
    private var active: Set<UUID> = []
    private var latest: [Provider: UUID] = [:]
    private var errors: [Provider: String] = [:]
    var loading: Bool { !active.isEmpty }
    var error: String? {
        let messages = Provider.allCases.compactMap { errors[$0] }
        return messages.isEmpty ? nil : messages.joined(separator: "\n")
    }
    mutating func begin(_ provider: Provider) -> UUID {
        let token = UUID()
        latest[provider] = token
        active.insert(token)
        errors[provider] = nil
        return token
    }
    func isCurrent(_ token: UUID, for provider: Provider) -> Bool { latest[provider] == token }
    mutating func fail(_ message: String, token: UUID, provider: Provider) {
        guard isCurrent(token, for: provider) else { return }
        errors[provider] = message
    }
    mutating func finish(_ token: UUID) { active.remove(token) }
    mutating func reset() { self = PlanningRequests() }
}
