import SwiftUI

struct SleepSummaryView: View {
    let summary: SleepSummary?
    /// The app's planning mode, used for the badge when there is no summary to label.
    let mode: PlanningDataMode
    let timeZone: TimeZone
    var loading = false
    var error: String? = nil
    var onEnable: (() -> Void)? = nil
    var onRefresh: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(title: "Recent sleep", systemImage: "bed.double.fill", source: summary?.provenance ?? mode)

            if loading {
                HStack { ProgressView(); Text("Loading sleep data…") }
                    .foregroundStyle(Theme.secondaryText)
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(Theme.warning)
            } else if let summary {
                Text(DayTime.duration(minutes: summary.totalAsleepMinutes))
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .contentTransition(.numericText())
                    .accessibilityLabel("Slept \(DayTime.duration(minutes: summary.totalAsleepMinutes))")

                Text(DayTime.shortDay(summary.sleepEnd, in: timeZone))
                    .font(.subheadline).foregroundStyle(Theme.secondaryText)

                Text("\(DayTime.time(summary.sleepStart, in: timeZone)) – \(DayTime.time(summary.sleepEnd, in: timeZone))")
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondaryText)

                if let heartRate = summary.averageHeartRateBPM {
                    Label("\(Int(heartRate.rounded())) bpm average heart rate", systemImage: "heart.fill")
                        .font(.subheadline)
                        .foregroundStyle(Theme.secondaryText)
                }
            } else {
                // nil means no sleep data was available, not that access was refused.
                Text("No readable recent overnight sleep.")
                    .foregroundStyle(Theme.secondaryText)
            }
            if let onEnable {
                HStack {
                    Button("Enable Health", action: onEnable)
                        .buttonStyle(.borderedProminent)
                    if mode == .live, let onRefresh {
                        Button("Refresh sleep", action: onRefresh).buttonStyle(.bordered)
                    }
                }
                .disabled(loading)
                Text(mode == .demo
                     ? "Switches to live data and asks to read Sleep and Heart Rate."
                     : "Read access is controlled in Health. No readable data can also mean no recent recorded sleep.")
                    .font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
        .card()
    }
}

#Preview("Sleep card states") {
    let demo = PlanningDemoInputs.make(referenceDate: .now, timeZone: .current)
    var noHeartRate = demo.sleepSummary
    noHeartRate.averageHeartRateBPM = nil
    noHeartRate.provenance = .live
    return ScrollView {
        VStack(spacing: 16) {
            SleepSummaryView(summary: demo.sleepSummary, mode: .demo, timeZone: .current)
            SleepSummaryView(summary: noHeartRate, mode: .live, timeZone: .current)
            SleepSummaryView(summary: nil, mode: .live, timeZone: .current)
        }
        .padding(16)
    }
    .background(Theme.background)
    .foregroundStyle(Theme.text)
    .preferredColorScheme(.dark)
}
