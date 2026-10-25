// Compile only with the standalone controller runner, never into the app.
import Foundation

typealias BluetoothSheep = SimulatedSheep

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
    init(timeZone: TimeZone) { }
    func requestAccess() async throws { }
    func sleepSummary(before referenceDate: Date) async throws -> SleepSummary? { Self.nextSummary }
}
