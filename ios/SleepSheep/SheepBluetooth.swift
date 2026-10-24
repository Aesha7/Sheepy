// Bluetooth link to the Sleep Sheep (CoreBluetooth). Contract from the hardware guide:
//   write "L,<brightness 0-100>,<seconds 0-1800>" or "S" (UTF-8, ≤ 40 chars) to the command characteristic;
//   status notifications "pats,light,level,target" arrive every second and on every pat ("ERR" on bad input).
// Needs a real iPhone (the Simulator has no Bluetooth) and NSBluetoothAlwaysUsageDescription in Info.plist.

import CoreBluetooth
import Foundation

struct SheepStatus: Codable, Equatable {
    var pats: Int
    var light: Int   // relative 0-1023, not lux
    var level: Int   // 0-100
    var target: Int  // 0-100
}

struct PatEntry: Identifiable, Codable {
    var id = UUID()
    let date: Date
    let countSinceBoot: Int
}

enum SheepError: LocalizedError {
    case notConnected, rejected, bluetoothOff
    var errorDescription: String? {
        switch self {
        case .notConnected: return "Sheep not connected over Bluetooth. Ask the person to move closer and tap Connect."
        case .rejected: return "The sheep rejected the command (ERR)."
        case .bluetoothOff: return "Bluetooth is off or not allowed for this app."
        }
    }
}

@MainActor
final class SheepBluetooth: NSObject, ObservableObject {
    static let serviceUUID = CBUUID(string: "A06E5F31-0600-46ED-8657-17C3712FB50F")
    static let commandUUID = CBUUID(string: "C8C9C213-A1FB-4AF2-A0D6-BED87FCEAD6C")
    static let statusUUID = CBUUID(string: "5781D30D-37B4-4463-A8D8-8019495468C1")
    /// 1 for real use; 60 on stage so a 30-minute sunrise plays in 30 seconds. The agent always thinks in real minutes.
    static let demoSpeedup: Double = 1

    @Published private(set) var connectionText = "Not connected"
    @Published private(set) var status: SheepStatus?
    @Published private(set) var pats: [PatEntry] = []

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var commandChar: CBCharacteristic?
    private var lastPats: Int?
    private var waiters: [UUID: CheckedContinuation<SheepStatus, Error>] = [:]

    var isConnected: Bool { commandChar != nil && peripheral?.state == .connected }

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: nil)
    }

    /// Scan by service UUID (not only by name) so the app can't grab another team's board.
    func connect() {
        guard central.state == .poweredOn else {
            connectionText = SheepError.bluetoothOff.localizedDescription
            return
        }
        connectionText = "Scanning…"
        central.scanForPeripherals(withServices: [Self.serviceUUID])
    }

    func disconnect() {
        if let p = peripheral { central.cancelPeripheralConnection(p) }
    }

    // MARK: Commands (same clamps and speedup as sheep.py)

    func setLamp(brightness: Double, minutes: Double) async throws -> SheepStatus {
        let b = Int(max(0, min(100, brightness.rounded())))
        let m = max(0, min(30, minutes))
        let seconds = (m * 60 / Self.demoSpeedup * 10).rounded() / 10
        try write(String(format: "L,%d,%.1f", b, seconds))
        return try await nextStatus()
    }

    func getStatus() async throws -> SheepStatus {
        if let s = status, isConnected { return s }
        try write("S")
        return try await nextStatus()
    }

    private func write(_ text: String) throws {
        guard let p = peripheral, let c = commandChar, p.state == .connected else { throw SheepError.notConnected }
        p.writeValue(Data(text.utf8), for: c, type: .withResponse)
    }

    /// Resolves with the next status notification (pushed within about a second), or the latest one after 2 s.
    private func nextStatus() async throws -> SheepStatus {
        let id = UUID()
        return try await withCheckedThrowingContinuation { cont in
            waiters[id] = cont
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if let c = self.waiters.removeValue(forKey: id) {
                    if let s = self.status { c.resume(returning: s) } else { c.resume(throwing: SheepError.notConnected) }
                }
            }
        }
    }

    // MARK: Status handling

    fileprivate func handleStatus(_ text: String) {
        if text == "ERR" {
            for (_, c) in waiters { c.resume(throwing: SheepError.rejected) }
            waiters.removeAll()
            return
        }
        let parts = text.split(separator: ",").compactMap { Int($0) }
        guard parts.count == 4 else { return }
        let s = SheepStatus(pats: parts[0], light: parts[1], level: parts[2], target: parts[3])
        // The Arduino has no clock: timestamp new pats on the phone. A lower count means it restarted.
        if let last = lastPats, s.pats > last {
            for n in (last + 1)...s.pats { pats.append(PatEntry(date: Date(), countSinceBoot: n)) }
            if pats.count > 500 { pats.removeFirst(pats.count - 500) }
        }
        lastPats = s.pats
        status = s
        for (_, c) in waiters { c.resume(returning: s) }
        waiters.removeAll()
    }

    fileprivate func setConnection(_ text: String, peripheral p: CBPeripheral? = nil, command: CBCharacteristic? = nil, clear: Bool = false) {
        connectionText = text
        if let p { peripheral = p }
        if let command { commandChar = command }
        if clear {
            commandChar = nil
            lastPats = nil
            for (_, c) in waiters { c.resume(throwing: SheepError.notConnected) }
            waiters.removeAll()
        }
    }
}

// The central manager uses the main queue (queue: nil), so every callback already runs on the main
// thread; MainActor.assumeIsolated (iOS 17+) lets us touch state synchronously, which also retains
// the peripheral before connecting, as CoreBluetooth requires.
extension SheepBluetooth: CBCentralManagerDelegate, CBPeripheralDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated {
            self.setConnection(central.state == .poweredOn ? "Ready to connect" : SheepError.bluetoothOff.localizedDescription)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        MainActor.assumeIsolated {
            central.stopScan()
            self.setConnection("Connecting…", peripheral: peripheral)
            peripheral.delegate = self
            central.connect(peripheral)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([SheepBluetooth.serviceUUID])
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated { self.setConnection("Disconnected", clear: true) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = peripheral.services?.first(where: { $0.uuid == SheepBluetooth.serviceUUID }) else { return }
        peripheral.discoverCharacteristics([SheepBluetooth.commandUUID, SheepBluetooth.statusUUID], for: svc)
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let chars = service.characteristics ?? []
        if let status = chars.first(where: { $0.uuid == SheepBluetooth.statusUUID }) {
            peripheral.setNotifyValue(true, for: status)
            peripheral.readValue(for: status)
        }
        let command = chars.first(where: { $0.uuid == SheepBluetooth.commandUUID })
        MainActor.assumeIsolated { self.setConnection("Connected to \(peripheral.name ?? "SleepSheep")", command: command) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == SheepBluetooth.statusUUID, let data = characteristic.value,
              let text = String(data: data, encoding: .utf8) else { return }
        MainActor.assumeIsolated { self.handleStatus(text.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
}
