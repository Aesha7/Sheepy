import Foundation

@MainActor
protocol SheepHardware: AnyObject {
    var latest: SheepStatus? { get }
    var onStatus: ((SheepStatus) -> Void)? { get set }
    var onConnection: ((String, Bool) -> Void)? { get set }
    var onNewSession: (() -> Void)? { get set }
    func connect()
    func disconnect()
    func setLamp(_ command: LampCommand) async throws -> SheepStatus
    func getStatus() throws -> SheepStatus
}

@MainActor
final class SimulatedSheep: SheepHardware {
    private(set) var latest: SheepStatus?
    var onStatus: ((SheepStatus) -> Void)?
    var onConnection: ((String, Bool) -> Void)?
    var onNewSession: (() -> Void)?
    private var timer: Task<Void, Never>?
    private var start = Date()
    private var from = 0.0
    private var target = 0.0
    private var duration = 0.0
    private var pats = 0
    func connect() {
        guard timer == nil else { return }
        onNewSession?()
        onConnection?("Connected · simulated sheep", true)
        publish()
        timer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
                self?.publish()
            }
        }
    }
    func disconnect() {
        timer?.cancel(); timer = nil; latest = nil
        onConnection?("Disconnected · simulated sheep", false)
    }
    private func publish() {
        let progress = duration <= 0 ? 1 : min(1, max(0, Date().timeIntervalSince(start) / duration))
        let status = SheepStatus(pats: pats, light: 400, level: from + (target - from) * progress,
                                 target: target, simulated: true)
        latest = status; onStatus?(status)
    }
    func pat() { guard timer != nil else { return }; pats += 1; publish() }
    func setLamp(_ command: LampCommand) async throws -> SheepStatus {
        _ = try getStatus()
        publish(); from = latest!.level; target = Double(command.brightness)
        duration = command.seconds; start = Date(); publish()
        return try getStatus()
    }
    func getStatus() throws -> SheepStatus {
        guard let latest else { throw SheepFailure("Simulated sheep is disconnected.") }
        return latest
    }
}
