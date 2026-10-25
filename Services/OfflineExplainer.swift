import Foundation

/// Offline "Why this plan?" text.
/// Pure: it reads only the `PlanResult` it is given, so it works with no network
/// and always matches the plan that was actually calculated. It never echoes
/// calendar titles. Prototype rules only; not medical advice.
struct OfflineExplainer {
    func explain(_ result: PlanResult) -> String {
        let plan = result.plan
        let zone = TimeZone(identifier: plan.timeZoneID) ?? TimeZone(secondsFromGMT: 0)!

        func time(_ date: Date) -> String {
            OfflineExplainer.format(date, in: zone)
        }

        var sentences: [String] = []

        if let anchor = result.anchorEvent {
            let subject = anchor.isFlight ? "flight departs" : "first commitment starts"
            sentences.append("Your \(subject) at \(time(anchor.event.start)), so your plan wakes you at \(time(plan.wake)) to leave time to get ready.")
        } else {
            sentences.append("Nothing on your calendar needs an earlier start, so your plan keeps your usual wake time of \(time(plan.wake)).")
        }

        if result.isBadNightAdjusted {
            sentences.append("Last night was short, so tonight's plan allows \(OfflineExplainer.duration(result.sleepOpportunityMinutes)) of sleep and moves wind-down and bedtime earlier.")
        } else if !result.hadSleepData {
            sentences.append("No sleep data was available, so this plan uses your target sleep time.")
        }

        sentences.append("Start winding down at \(time(plan.windDown)) and aim to be in bed by \(time(result.bedtime)).")
        sentences.append("Have your last caffeine by \(time(plan.caffeineCutoff)).")
        sentences.append("Get bright morning light between \(time(plan.morningLightStart)) and \(time(plan.morningLightEnd)).")

        return sentences.joined(separator: " ")
    }

    private static func format(_ date: Date, in zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }

    private static func duration(_ minutes: Int) -> String {
        let hours = minutes / 60
        let rest = minutes % 60
        if rest == 0 { return "\(hours) h" }
        if hours == 0 { return "\(rest) min" }
        return "\(hours) h \(rest) min"
    }
}
