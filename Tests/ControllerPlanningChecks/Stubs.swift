// Compile only with the standalone controller runner, never into the app.
import Foundation

// Controlled transport lets checks deliver pats during an outstanding write.
@MainActor final class BluetoothSheep: SheepHardware {
    static var onWrite: ((SimulatedSheep, LampCommand) async throws -> Void)?
    private let base = SimulatedSheep()
    var latest: SheepStatus? { base.latest }
    var onStatus: ((SheepStatus) -> Void)? {
        get { base.onStatus } set { base.onStatus = newValue }
    }
    var onConnection: ((String, Bool) -> Void)? {
        get { base.onConnection } set { base.onConnection = newValue }
    }
    var onNewSession: (() -> Void)? {
        get { base.onNewSession } set { base.onNewSession = newValue }
    }
    func connect() { base.connect() }
    func disconnect() { base.disconnect() }
    func getStatus() throws -> SheepStatus { try base.getStatus() }
    func setLamp(_ command: LampCommand) async throws -> SheepStatus {
        try await Self.onWrite?(base, command)
        return try await base.setLamp(command)
    }
}

@MainActor final class PatLog {
    init(simulated: Bool) throws { }
    func recent(_ limit: Int = 50) -> [PatEntry] { [] }
    func resetBaseline() { }
    func record(_ count: Int) throws { }
}
@MainActor final class ClaudeAgent {
    func reset() { }
    func reply(to text: String, context: String,
               runTool: (String, [String: Any]) async throws -> String) async throws -> String {
        fatalError("Controller planning checks must not call chat")
    }
}
@MainActor final class CalendarService {
    static var nextEvents: [CalendarEvent] = []
    func requestAccess() async throws { }
    func events(in interval: DateInterval) async throws -> [CalendarEvent] { Self.nextEvents }
}
@MainActor final class HealthKitService {
    static var nextSummary: SleepSummary?
    static var authorizationAction: () async throws -> Void = {}
    static var summaryFetchCount = 0
    init(timeZone: TimeZone) { }
    func requestAccess() async throws { try await Self.authorizationAction() }
    func sleepSummary(before referenceDate: Date) async throws -> SleepSummary? {
        Self.summaryFetchCount += 1
        return Self.nextSummary
    }
}
