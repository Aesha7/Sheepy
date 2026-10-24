// Sleep Sheep phone app: connect to the sheep over Bluetooth, run the Drift agent, see why it acted.

import SwiftUI

@main
struct SleepSheepApp: App {
    @StateObject private var sheep: SheepBluetooth
    @StateObject private var agent: ClaudeAgent

    init() {
        let s = SheepBluetooth()
        _sheep = StateObject(wrappedValue: s)
        _agent = StateObject(wrappedValue: ClaudeAgent(sheep: s))
    }

    var body: some Scene {
        WindowGroup { ContentView().environmentObject(sheep).environmentObject(agent) }
    }
}

struct ContentView: View {
    @EnvironmentObject var sheep: SheepBluetooth
    @EnvironmentObject var agent: ClaudeAgent
    // Fallback context when the Drift server isn't reachable.
    @AppStorage("bedtime") private var bedtime = "23:00"
    @AppStorage("wakeTime") private var wakeTime = "07:00"
    @AppStorage("maxBrightness") private var maxBrightness = 80.0

    private var settings: String { "bedtime \(bedtime), wake time \(wakeTime), brightness limit \(Int(maxBrightness))%" }

    var body: some View {
        NavigationStack {
            List {
                Section("Sheep") {
                    Text(sheep.connectionText)
                    if let s = sheep.status {
                        LabeledContent("Light", value: "\(s.level)% → \(s.target)%")
                        LabeledContent("Room light", value: "\(s.light) (relative, not lux)")
                        LabeledContent("Head pats", value: "\(s.pats) since power-on")
                    }
                    Button(sheep.isConnected ? "Disconnect" : "Connect") { sheep.isConnected ? sheep.disconnect() : sheep.connect() }
                }
                Section("Agent") {
                    Button(agent.running ? "Thinking…" : "Run agent now") { agent.run(event: "the person tapped Run agent now", settings: settings) }
                        .disabled(agent.running || agent.stopped || !sheep.isConnected)
                    if agent.stopped {
                        Button("Resume") { agent.resume() }
                    } else {
                        Button("Stop", role: .destructive) { agent.stop() }
                    }
                    if !agent.note.isEmpty { Text(agent.note) }
                    if let e = agent.error { Text(e).foregroundStyle(.red) }
                    ForEach(agent.steps) { step in
                        VStack(alignment: .leading) {
                            Text(step.tool).bold()
                            Text(step.input).font(.caption.monospaced()).foregroundStyle(.secondary)
                            Text(step.output).font(.caption.monospaced()).foregroundStyle(step.isError ? .red : .secondary).lineLimit(3)
                        }
                    }
                }
                if !agent.scheduled.isEmpty {
                    Section("Scheduled by the agent (app must stay open)") {
                        ForEach(agent.scheduled) { item in
                            Text("\(item.at.formatted(date: .omitted, time: .shortened)): light \(item.brightness)% over \(Int(item.minutes)) min. \(item.note)")
                        }
                    }
                }
                Section("Settings (used if the Drift server can't be reached)") {
                    TextField("Bedtime HH:MM", text: $bedtime)
                    TextField("Wake time HH:MM", text: $wakeTime)
                    Slider(value: $maxBrightness, in: 5...100, step: 5) { Text("Brightness limit") }
                    Text("Brightness limit \(Int(maxBrightness))%")
                }
            }
            .navigationTitle("Sleep Sheep")
        }
        // A new head pat is an event worth deciding on (bedtime or waking up).
        .onChange(of: sheep.pats.count) { old, new in
            if new > old, sheep.isConnected { agent.run(event: "head pat on the sheep", settings: settings) }
        }
    }
}
