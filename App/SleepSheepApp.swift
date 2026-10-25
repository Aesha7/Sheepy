import SwiftUI

@main
struct SleepSheepApp: App {
    @StateObject private var controller = SleepController()
    var body: some Scene {
        WindowGroup {
            HomeView(controller: controller,
                     reportBadNight: { controller.setDemoSleepScenario(.badNight) })
        }
    }
}

struct ContentView: View {
    @ObservedObject var controller: SleepController
    @State private var brightness = 80.0
    @State private var minutes = 25.0
    @State private var message = ""
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 16) {
                        Text("🐑").font(.system(size: 52))
                        VStack(alignment: .leading, spacing: 4) {
                            Text("A softer start").font(.title2.bold())
                            Text("Your light, at your pace.").foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 8)
                    Toggle("Simulated sheep", isOn: Binding(get: { controller.simulated }, set: controller.selectSimulation))
                        .disabled(controller.busy)
                    Text(controller.connection).font(.subheadline).accessibilityIdentifier("connectionStatus")
                    HStack {
                        Button("Connect", action: controller.connect).disabled(controller.connected || controller.busy)
                        Spacer()
                        Button("Disconnect", action: controller.disconnect)
                    }.buttonStyle(.bordered)
                    if controller.simulated {
                        Text("SIMULATED · Sensor readings and pats are test data.").font(.caption).foregroundStyle(.orange)
                    }
                }
                Section("Sheep right now") {
                    if let status = controller.status {
                        LabeledContent("Lamp", value: "\(Int(status.level.rounded()))% → \(Int(status.target))%")
                        LabeledContent("Room light", value: "\(status.light) / 1023 · relative")
                        LabeledContent("Pats since power-on", value: "\(status.pats)")
                    } else { Text("Connect to receive live status.").foregroundStyle(.secondary) }
                }
                Section("Morning light demo") {
                    Text(controller.morningLightDemoActive
                         ? "Pat Sheepy to turn the light off."
                         : "Fade to 80% over 12 seconds, then pat Sheepy to turn it off.")
                    Button("Start morning light demo") {
                        Task { await controller.startMorningLightDemo() }
                    }
                    .disabled(!controller.connected || controller.busy || controller.morningLightDemoActive)
                    if controller.simulated {
                        Button("Simulate wake-up pat", action: controller.simulatePat)
                            .disabled(!controller.morningLightDemoActive)
                    }
                    Text("Keep Sheepy open and connected for pat detection. This starts now; it does not schedule an alarm. Manual lamp controls or chat end the demo's pat-to-off mode.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Warm light") {
                    LabeledContent("Brightness", value: "\(Int(brightness))%")
                    Slider(value: $brightness, in: 0...100, step: 1)
                    LabeledContent("Fade duration", value: "\(Int(minutes)) minutes")
                    Slider(value: $minutes, in: 0...30, step: 1)
                    Toggle("Stage demo · 60× faster", isOn: $controller.stageDemo)
                    if controller.stageDemo {
                        Text("Demo timing is sped up: a 30-minute fade takes 30 seconds.").font(.caption).foregroundStyle(.orange)
                    }
                    HStack {
                        Button("Start fade") { Task { await controller.setLamp(brightness: brightness, minutes: minutes) } }
                        Spacer()
                        Button("Light off") { Task { await controller.setLamp(brightness: 0, minutes: 0) } }
                    }.buttonStyle(.borderedProminent).disabled(!controller.connected)
                }.disabled(controller.busy)
                Section("Ask your sheep") {
                    ForEach(controller.chat) { entry in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.role).font(.caption.bold()).foregroundStyle(.secondary)
                            Text(entry.text).textSelection(.enabled)
                        }
                    }
                    TextField("Try: Start a gentle sunrise now", text: $message, axis: .vertical)
                        .lineLimit(2...5).disabled(controller.busy)
                    Button {
                        let text = message; message = ""
                        Task { await controller.send(text) }
                    } label: {
                        HStack { Text("Send"); if controller.busy { ProgressView() } }
                    }.disabled(controller.busy || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Text("This starter starts fades now. It does not schedule alarms or future wake-ups.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Recent head pats") {
                    if controller.simulated {
                        Button("Simulate a head pat", action: controller.simulatePat).disabled(!controller.connected)
                    }
                    if controller.pats.isEmpty { Text("No pats recorded yet.").foregroundStyle(.secondary) }
                    ForEach(Array(controller.pats.suffix(10).enumerated()), id: \.offset) { _, pat in
                        LabeledContent("Pat \(pat.count_since_boot)", value: pat.ts)
                            .font(.caption)
                    }
                    Text("Phone-observed timestamps. Pats are a sleep proxy, not clinical sleep data. Logging requires the app to be running.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error = controller.error {
                    Section("Needs attention") { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                }
            }
            .navigationTitle("Sheepy")
            .tint(Color(red: 0.55, green: 0.32, blue: 0.13))
        }
    }
}
