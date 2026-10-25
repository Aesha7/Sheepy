import CoreBluetooth
import Foundation

@MainActor
// CoreBluetooth callbacks use the explicitly configured main queue below.
final class BluetoothSheep: NSObject, SheepHardware, @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    static let serviceID = CBUUID(string: "A06E5F31-0600-46ED-8657-17C3712FB50F")
    static let commandID = CBUUID(string: "C8C9C213-A1FB-4AF2-A0D6-BED87FCEAD6C")
    static let statusID = CBUUID(string: "5781D30D-37B4-4463-A8D8-8019495468C1")
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var commandCharacteristic: CBCharacteristic?
    private var statusCharacteristic: CBCharacteristic?
    private var wantsConnection = false
    private var ready = false
    private var lastUpdate: Date?
    private var connectionTimeout: Task<Void, Never>?
    private var commandTimeout: Task<Void, Never>?
    private var pending: CheckedContinuation<SheepStatus, Error>?
    private var waitingForWrite = false
    private(set) var latest: SheepStatus?
    var onStatus: ((SheepStatus) -> Void)?
    var onConnection: ((String, Bool) -> Void)?
    var onNewSession: (() -> Void)?

    func connect() {
        guard !ready, !wantsConnection else { return }
        wantsConnection = true
        onConnection?("Checking Bluetooth…", false)
        if central == nil { central = CBCentralManager(delegate: self, queue: .main) }
        else { centralManagerDidUpdateState(central) }
    }
    func disconnect() {
        wantsConnection = false
        central?.stopScan()
        connectionTimeout?.cancel()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        clearConnection("Disconnected. The sheep may still be fading.")
    }
    private func clearConnection(_ message: String) {
        ready = false; latest = nil; lastUpdate = nil
        commandCharacteristic = nil; statusCharacteristic = nil
        peripheral = nil
        connectionTimeout?.cancel()
        finish(.failure(SheepFailure(message)))
        onConnection?(message, false)
    }
    private func failConnection(_ message: String) {
        wantsConnection = false
        central?.stopScan()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        clearConnection(message)
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard wantsConnection else { return }
        switch central.state {
        case .poweredOn:
            guard peripheral == nil else { return }
            onConnection?("Looking for SleepSheep…", false)
            central.scanForPeripherals(withServices: [Self.serviceID], options: nil)
            connectionTimeout?.cancel()
            connectionTimeout = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
                self?.failConnection("Could not connect. Power on the sheep and move closer, then try again.")
            }
        case .unknown, .resetting: onConnection?("Waiting for Bluetooth…", false)
        case .poweredOff: failConnection("Bluetooth is off. Enable it in Settings, then reconnect.")
        case .unauthorized: failConnection("Bluetooth permission denied. Allow Sleep Sheep in Settings.")
        case .unsupported: failConnection("Bluetooth is unavailable here. Use a real iPhone or simulation.")
        @unknown default: failConnection("Bluetooth is unavailable.")
        }
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard wantsConnection, self.peripheral == nil else { return }
        central.stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        onConnection?("Connecting to SleepSheep…", false)
        central.connect(peripheral, options: nil)
    }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral === self.peripheral, wantsConnection else { return }
        onNewSession?()
        peripheral.discoverServices([Self.serviceID])
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }
        failConnection(error?.localizedDescription ?? "Could not connect to sheep.")
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }
        wantsConnection = false
        clearConnection("Sheep disconnected. Move closer and reconnect. Its fade may still be running.")
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === self.peripheral else { return }
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == Self.serviceID }) else {
            failConnection("Sheep service unavailable. Check firmware."); return
        }
        peripheral.discoverCharacteristics([Self.commandID, Self.statusID], for: service)
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard peripheral === self.peripheral else { return }
        guard error == nil else { failConnection(error!.localizedDescription); return }
        commandCharacteristic = service.characteristics?.first { $0.uuid == Self.commandID }
        statusCharacteristic = service.characteristics?.first { $0.uuid == Self.statusID }
        guard let commandCharacteristic, let statusCharacteristic,
              commandCharacteristic.properties.contains(.write),
              statusCharacteristic.properties.contains(.notify),
              statusCharacteristic.properties.contains(.read) else {
            failConnection("Sheep characteristics do not match the firmware contract."); return
        }
        peripheral.setNotifyValue(true, for: statusCharacteristic)
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === self.peripheral, characteristic.uuid == Self.statusID else { return }
        guard error == nil, characteristic.isNotifying else {
            failConnection("Could not subscribe to sheep status."); return
        }
        // Stay unready until the first valid status establishes the pat baseline.
        peripheral.readValue(for: characteristic)
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === self.peripheral, characteristic.uuid == Self.statusID else { return }
        do {
            if let error { throw error }
            guard let data = characteristic.value else { throw SheepFailure("Empty sheep status.") }
            let status = try SheepStatus.parse(data)
            latest = status; lastUpdate = Date()
            if !ready {
                ready = true; connectionTimeout?.cancel()
                onConnection?("Connected to SleepSheep", true)
            }
            onStatus?(status)
            if !waitingForWrite { finish(.success(status)) }
        } catch {
            finish(.failure(error))
            // Invalid data must not leave a previously fresh snapshot usable.
            latest = nil; lastUpdate = nil
            onConnection?(error.localizedDescription, ready)
        }
    }
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === self.peripheral, characteristic.uuid == Self.commandID, pending != nil else { return }
        if let error { finish(.failure(error)); return }
        waitingForWrite = false
        // Firmware pushes status every second. Wait for a notification after the
        // acknowledged write rather than returning a pre-command cached snapshot.
    }
    func getStatus() throws -> SheepStatus {
        guard ready, let latest, let lastUpdate, Date().timeIntervalSince(lastUpdate) < 5 else {
            throw SheepFailure("No fresh sheep status. Connect over Bluetooth and move closer.")
        }
        return latest
    }
    func setLamp(_ command: LampCommand) async throws -> SheepStatus {
        _ = try getStatus()
        guard pending == nil else { throw SheepFailure("Another lamp command is still pending.") }
        guard let peripheral, let characteristic = commandCharacteristic else {
            throw SheepFailure("Sheep not connected over Bluetooth. Move closer and reconnect.")
        }
        let data = Data(command.text.utf8)
        guard data.count <= 40, data.count <= peripheral.maximumWriteValueLength(for: .withResponse) else {
            throw SheepFailure("Lamp command exceeds Bluetooth write limit.")
        }
        return try await withCheckedThrowingContinuation { continuation in
            pending = continuation; waitingForWrite = true
            commandTimeout = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                self?.finish(.failure(SheepFailure("Timed out waiting for sheep status. The fade may have started; check status before retrying.")))
            }
            peripheral.writeValue(data, for: characteristic, type: .withResponse)
        }
    }
    private func finish(_ result: Result<SheepStatus, Error>) {
        let continuation = pending
        pending = nil; waitingForWrite = false
        commandTimeout?.cancel(); commandTimeout = nil
        continuation?.resume(with: result)
    }
}
