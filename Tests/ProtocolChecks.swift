import Foundation

@main
struct ProtocolChecks {
    @MainActor
    static func main() async throws {
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(), message)
        }
        let status = try SheepStatus.parse(Data("4,412,35,80".utf8))
        check(status == SheepStatus(pats: 4, light: 412, level: 35, target: 80), "CSV fields")
        for text in ["ERR", "1,2,3", "1,2,3,4,5", "-1,0,0,0", "0,1024,0,0", "0,0,101,0", "0,0,3.5,4", "0,,0,0"] {
            do { _ = try SheepStatus.parse(Data(text.utf8)); preconditionFailure("Accepted malformed status \(text)") }
            catch { }
        }
        let clamped = try LampCommand(brightness: 500, minutes: 9999, speedup: 1)
        check(clamped.text == "L,100,1800.0", "Firmware bounds")
        let demo = try LampCommand(brightness: 80, minutes: 30, speedup: 60)
        check(demo.text == "L,80,30.0", "Speedup once, below agent")
        let off = try LampCommand(brightness: -20, minutes: -1, speedup: 1)
        check(off.text == "L,0,0.0", "Lower bounds")
        let even = try LampCommand(brightness: 80.5, minutes: 0, speedup: 1)
        let odd = try LampCommand(brightness: 81.5, minutes: 0, speedup: 1)
        check(even.brightness == 80 && odd.brightness == 82, "Python round parity")
        do { _ = try LampCommand(brightness: .nan, minutes: 1, speedup: 1); preconditionFailure("NaN accepted") } catch { }
        do { _ = try LampCommand(brightness: 1, minutes: 1, speedup: 0); preconditionFailure("Invalid speedup") } catch { }
        var tracker = PatTracker()
        check(tracker.consume(4).isEmpty, "First status establishes baseline")
        let entries = tracker.consume(7, now: Date(timeIntervalSince1970: 0))
        check(entries.map(\.count_since_boot) == [5, 6, 7], "One timestamped entry per new pat")
        check(Set(entries.map(\.ts)).count == 1, "Batched observed pats share observation time")
        check(tracker.consume(7).isEmpty, "No duplicates")
        check(tracker.consume(0).isEmpty, "Restart resets baseline")
        check(tracker.consume(1).count == 1, "Pats resume after reboot")
        tracker.reset()
        check(tracker.consume(20).isEmpty, "Reconnect never logs unseen historical pats")
        let simulated = SimulatedSheep()
        var observed = [SheepStatus]()
        simulated.onStatus = { observed.append($0) }
        simulated.connect()
        let initial = try simulated.getStatus()
        check(initial.simulated == true, "Simulation labeled")
        simulated.pat()
        let patted = try simulated.getStatus()
        check(patted.pats == 1, "Simulated pat notification")
        _ = try await simulated.setLamp(LampCommand(brightness: 100, minutes: 1, speedup: 1))
        let fading = try simulated.getStatus()
        check(fading.level < 1 && fading.target == 100, "Simulation preserves Arduino-managed fade semantics")
        _ = try await simulated.setLamp(LampCommand(brightness: 0, minutes: 0, speedup: 1))
        let dark = try simulated.getStatus()
        check(dark.level == 0, "Instant off")
        simulated.disconnect()
        do { _ = try simulated.getStatus(); preconditionFailure("Disconnected snapshot returned") } catch { }
        check(observed.count >= 4, "Simulation publishes updates")
        print("Swift protocol checks passed")
    }
}
