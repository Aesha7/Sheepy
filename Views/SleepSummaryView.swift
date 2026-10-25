import SwiftUI

struct SleepSummaryView: View {
    let summary: SleepSummary?
    /// The app's planning mode, used for the badge when there is no summary to label.
    let mode: PlanningDataMode
    let timeZone: TimeZone

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(title: "Last night", systemImage: "bed.double.fill", source: summary?.provenance ?? mode)

            if let summary {
                Text(DayTime.duration(minutes: summary.totalAsleepMinutes))
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .contentTransition(.numericText())
                    .accessibilityLabel("Slept \(DayTime.duration(minutes: summary.totalAsleepMinutes))")

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
                Text("No sleep data for last night.")
                    .foregroundStyle(Theme.secondaryText)
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
