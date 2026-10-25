import SwiftUI

struct SleepSummaryView: View {
    let summary: SleepSummary?
    /// The app's planning mode; live mode alone doesn't mean Health returned anything.
    let mode: PlanningDataMode
    let timeZone: TimeZone
    var loading = false
    var error: String? = nil
    var onEnable: (() -> Void)? = nil
    var onRefresh: (() -> Void)? = nil

    private var badge: SourceBadge.Kind {
        guard let summary else { return .of(mode: mode, loadedFrom: nil) }
        return summary.provenance == .live ? .loaded("Apple Health") : .demo
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(title: "Recent sleep", systemImage: "bed.double.fill", badge: badge)

            if loading {
                HStack(spacing: 10) {
                    ProgressView().tint(Theme.accent)
                    Text("Loading sleep data…")
                }
                .foregroundStyle(Theme.secondaryText)
            } else if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.subheadline)
                    .foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let summary {
                Text(DayTime.duration(minutes: summary.totalAsleepMinutes))
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .contentTransition(.numericText())
                    .accessibilityLabel("Slept \(DayTime.duration(minutes: summary.totalAsleepMinutes))")

                Text("\(DayTime.shortDay(summary.sleepEnd, in: timeZone)) · \(DayTime.time(summary.sleepStart, in: timeZone)) – \(DayTime.time(summary.sleepEnd, in: timeZone))")
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondaryText)

                if let heartRate = summary.averageHeartRateBPM {
                    Label("\(Int(heartRate.rounded())) bpm average heart rate", systemImage: "heart.fill")
                        .font(.subheadline)
                        .foregroundStyle(Theme.secondaryText)
                }
            } else {
                // nil means no readable qualifying sleep, not that access was refused.
                Text("No recent overnight sleep to show.")
                    .foregroundStyle(Theme.secondaryText)
            }

            if let onEnable {
                controls(onEnable: onEnable)
            }
        }
        .card()
    }

    @ViewBuilder private func controls(onEnable: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            if mode == .live, let onRefresh {
                CardButton(title: "Refresh sleep", systemImage: "arrow.clockwise", action: onRefresh)
            }
            CardButton(title: "Enable Health", systemImage: "heart.text.square", prominent: mode == .demo || summary == nil,
                       action: onEnable)
        }
        .disabled(loading)
        .padding(.top, 4)

        HintText(mode == .demo
                 ? "Enable Health switches to live mode and asks to read Sleep and Heart Rate."
                 : "Read access is managed in the Health app. An empty result can also mean no recent recorded sleep.")
    }
}

#Preview("Sleep card states") {
    let demo = PlanningDemoInputs.make(referenceDate: .now, timeZone: .current)
    var live = demo.sleepSummary
    live.averageHeartRateBPM = nil
    live.provenance = .live
    return ScrollView {
        VStack(spacing: 16) {
            SleepSummaryView(summary: demo.sleepSummary, mode: .demo, timeZone: .current, onEnable: {})
            SleepSummaryView(summary: live, mode: .live, timeZone: .current, onEnable: {}, onRefresh: {})
            SleepSummaryView(summary: nil, mode: .live, timeZone: .current, onEnable: {}, onRefresh: {})
            SleepSummaryView(summary: nil, mode: .live, timeZone: .current, loading: true, onEnable: {}, onRefresh: {})
            SleepSummaryView(summary: nil, mode: .live, timeZone: .current,
                             error: "Health: Health data is unavailable on this device.", onEnable: {}, onRefresh: {})
        }
        .padding(16)
    }
    .background(Theme.background)
    .foregroundStyle(Theme.text)
    .preferredColorScheme(.dark)
}
