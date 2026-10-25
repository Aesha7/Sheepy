import Combine
import CoreFoundation
import Foundation

@MainActor
final class SleepController: ObservableObject {
    @Published var connection = "Disconnected"
    @Published var connected = false
    @Published var status: SheepStatus?
    @Published var pats: [PatEntry] = []
    @Published var error: String?
    @Published var busy = false
    @Published var chat: [ChatEntry] = []
    @Published var stageDemo = false
    @Published private(set) var simulated: Bool
    @Published var profile: SleepProfile
    @Published var sleepSummary: SleepSummary?
    @Published var calendarEvents: [CalendarEvent] = []
    @Published var plan: DailyPlan?
    @Published var sheepyState: SheepyState = .lively
    @Published var quests: [Quest] = []
    @Published private(set) var planningDataMode: PlanningDataMode
    @Published var planningLoading = false
    @Published var planningError: String?
    private var hardware: SheepHardware
    private var patLog: PatLog?
    private var logError: String?
    private let agent = ClaudeAgent()
    private let calendarService = CalendarService()
    private let healthService: HealthKitService
    private var planningRequests = PlanningRequests()

    init(referenceDate: Date = Date(), timeZone: TimeZone = .current,
         planningDataMode: PlanningDataMode = .demo) {
        healthService = HealthKitService(timeZone: timeZone)
        profile = SleepProfile(preferredWakeHour: 7, preferredWakeMinute: 0,
                               timeZoneID: timeZone.identifier, preparationMinutes: 60,
                               targetSleepMinutes: 480)
        self.planningDataMode = planningDataMode
        #if targetEnvironment(simulator)
        simulated = true
        hardware = SimulatedSheep()
        #else
        simulated = false
        hardware = BluetoothSheep()
        #endif
        wireHardware()
        if planningDataMode == .demo { loadPlanningDemo(referenceDate: referenceDate, timeZone: timeZone) }
    }
    /// Replaces planning inputs only. Does not connect hardware or call Claude.
    func loadPlanningDemo(referenceDate: Date, timeZone: TimeZone) {
        planningRequests.reset()
        let demo = PlanningDemoInputs.make(referenceDate: referenceDate, timeZone: timeZone)
        planningDataMode = .demo
        profile = demo.profile
        sleepSummary = demo.sleepSummary
        calendarEvents = demo.calendarEvents
        plan = nil
        sheepyState = demo.sheepyState
        quests = demo.quests
        planningLoading = false
        planningError = nil
    }
    /// Clear fixtures before future live providers populate state. Retain preferences.
    /// This does not request permissions or start live data loading.
    func selectLivePlanning() {
        planningRequests.reset()
        planningDataMode = .live
        sleepSummary = nil
        calendarEvents = []
        plan = nil
        sheepyState = .lively
        quests = []
        planningLoading = false
        planningError = nil
    }
    /// Explicit user action only. Selecting live mode does not call this method.
    /// Returns false for denial, failure, or a request superseded by a mode change.
    @discardableResult
    func requestCalendarAccess() async -> Bool {
        guard planningDataMode == .live else { return false }
        let requestID = planningRequests.begin(.calendar)
        publishPlanningRequests()
        defer {
            planningRequests.finish(requestID)
            publishPlanningRequests()
        }
        do {
            try await calendarService.requestAccess()
            return planningRequests.isCurrent(requestID, for: .calendar) && planningDataMode == .live
        } catch {
            guard planningRequests.isCurrent(requestID, for: .calendar), planningDataMode == .live else { return false }
            calendarEvents = []
            plan = nil
            planningRequests.fail("Calendar: \(error.localizedDescription)", token: requestID, provider: .calendar)
            return false
        }
    }

    /// Fetches authorized data only; reports errors through planningError.
    func refreshLiveCalendarEvents(in interval: DateInterval) async {
        guard planningDataMode == .live else { return }
        let requestID = planningRequests.begin(.calendar)
        publishPlanningRequests()
        defer {
            planningRequests.finish(requestID)
            publishPlanningRequests()
        }
        do {
            let events = try await calendarService.events(in: interval)
            guard planningRequests.isCurrent(requestID, for: .calendar), planningDataMode == .live else { return }
            calendarEvents = events
            plan = nil
        } catch {
            guard planningRequests.isCurrent(requestID, for: .calendar), planningDataMode == .live else { return }
            calendarEvents = []
            plan = nil
            planningRequests.fail("Calendar: \(error.localizedDescription)", token: requestID, provider: .calendar)
        }
    }
    private func publishPlanningRequests() {
        planningLoading = planningRequests.loading
        planningError = planningRequests.error
    }

    /// Explicit user action only. true means the flow completed, not read permission.
    @discardableResult
    func requestHealthAccess() async -> Bool {
        guard planningDataMode == .live else { return false }
        let token = planningRequests.begin(.health)
        publishPlanningRequests()
        defer {
            planningRequests.finish(token)
            publishPlanningRequests()
        }
        do {
            try await healthService.requestAccess()
            return planningRequests.isCurrent(token, for: .health) && planningDataMode == .live
        } catch {
            guard planningRequests.isCurrent(token, for: .health), planningDataMode == .live else { return false }
            planningRequests.fail("Health: \(error.localizedDescription)", token: token, provider: .health)
            sleepSummary = nil
            plan = nil
            return false
        }
    }

    /// Never prompts. nil sleep means no readable qualifying session, not denial.
    func refreshLiveSleepSummary(before referenceDate: Date) async {
        guard planningDataMode == .live else { return }
        let token = planningRequests.begin(.health)
        publishPlanningRequests()
        defer {
            planningRequests.finish(token)
            publishPlanningRequests()
        }
        do {
            let summary = try await healthService.sleepSummary(before: referenceDate)
            guard planningRequests.isCurrent(token, for: .health), planningDataMode == .live else { return }
            sleepSummary = summary
            plan = nil
        } catch {
            guard planningRequests.isCurrent(token, for: .health), planningDataMode == .live else { return }
            sleepSummary = nil
            plan = nil
            planningRequests.fail("Health: \(error.localizedDescription)", token: token, provider: .health)
        }
    }

    private func wireHardware() {
        do { patLog = try PatLog(simulated: simulated); logError = nil }
        catch { patLog = nil; logError = error.localizedDescription; self.error = "Could not load pat log: \(error.localizedDescription)" }
        pats = patLog?.recent() ?? []
        hardware.onNewSession = { [weak self] in self?.patLog?.resetBaseline() }
        hardware.onConnection = { [weak self] text, connected in
            self?.connection = text; self?.connected = connected
            if !connected { self?.status = nil }
        }
        hardware.onStatus = { [weak self] status in
            guard let self else { return }
            self.status = status
            do {
                try self.patLog?.record(status.pats)
                self.pats = self.patLog?.recent() ?? []
            } catch {
                self.logError = error.localizedDescription
                self.error = "Pat log could not be saved: \(error.localizedDescription)"
            }
        }
    }
    func selectSimulation(_ enabled: Bool) {
        guard !busy, enabled != simulated else { return }
        hardware.disconnect()
        hardware.onStatus = nil; hardware.onConnection = nil; hardware.onNewSession = nil
        simulated = enabled
        hardware = enabled ? SimulatedSheep() : BluetoothSheep()
        status = nil; connection = "Disconnected"; connected = false
        agent.reset(); chat = []
        wireHardware()
    }
    func connect() { error = nil; hardware.connect() }
    func disconnect() { hardware.disconnect() }
    func simulatePat() { (hardware as? SimulatedSheep)?.pat() }
    func setLamp(brightness: Double, minutes: Double) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let command = try LampCommand(brightness: brightness, minutes: minutes, speedup: stageDemo ? 60 : 1)
            status = try await hardware.setLamp(command)
        } catch { self.error = error.localizedDescription }
    }
    func send(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, !text.isEmpty else { return }
        busy = true; error = nil
        defer { busy = false }
        chat.append(ChatEntry(role: "You", text: text))
        do {
            let context = "Current phone time: \(ISO8601DateFormatter().string(from: Date())). Timezone: \(TimeZone.current.identifier). Hardware simulation: \(simulated)."
            let answer = try await agent.reply(to: text, context: context) { [weak self] name, input in
                guard let self else { throw SheepFailure("App controller unavailable.") }
                return try await self.runTool(name, input)
            }
            chat.append(ChatEntry(role: "Sleep Sheep", text: answer))
        } catch {
            self.error = error.localizedDescription
            chat.append(ChatEntry(role: "Error", text: error.localizedDescription))
        }
    }
    private func number(_ input: [String: Any], _ key: String) throws -> Double {
        guard let number = input[key] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else {
            throw SheepFailure("\(key) must be a finite number.")
        }
        return number.doubleValue
    }
    private func runTool(_ name: String, _ input: [String: Any]) async throws -> String {
        switch name {
        case "set_lamp":
            let command = try LampCommand(brightness: number(input, "brightness"), minutes: number(input, "minutes"), speedup: stageDemo ? 60 : 1)
            return try jsonText(await hardware.setLamp(command))
        case "get_status": return try jsonText(hardware.getStatus())
        case "read_pat_log":
            guard let patLog, logError == nil else { throw SheepFailure("Pat log unavailable: \(logError ?? "storage error")") }
            let value = try input["limit"] == nil ? 50 : number(input, "limit")
            guard value.rounded() == value else { throw SheepFailure("limit must be an integer.") }
            let limit = Int(max(1, min(200, value)))
            struct Result: Encodable { let pats: [PatEntry]; let simulated: Bool }
            return try jsonText(Result(pats: patLog.recent(limit), simulated: simulated))
        default: throw SheepFailure("Unknown tool: \(name)")
        }
    }
}

struct ChatEntry: Identifiable {
    let id = UUID()
    let role: String
    let text: String
}
