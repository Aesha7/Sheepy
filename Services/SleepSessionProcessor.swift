import Foundation

/// On-device, source-neutral inputs. No raw samples leave the provider.
enum SleepSessionProcessor {
    struct Segment {
        let source: String
        let start: Date
        let end: Date
    }
    struct HeartReading {
        let source: String
        let date: Date
        let bpm: Double
    }
    struct Session {
        let source: String
        let intervals: [DateInterval]
        var start: Date { intervals.first!.start }
        var end: Date { intervals.last!.end }
        var seconds: Double { intervals.reduce(0) { $0 + $1.duration } }
    }

    static func select(_ samples: [Segment], before reference: Date,
                       since lowerBound: Date, timeZone: TimeZone) -> Session? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        // Noon-to-noon buckets prevent bridging separate nights, even with gaps.
        struct Key: Hashable { let source: String; let noon: Date }
        var buckets: [Key: [Segment]] = [:]
        for sample in samples where sample.end > sample.start && sample.start < reference {
            let day = calendar.startOfDay(for: sample.start)
            var noon = calendar.date(bySettingHour: 12, minute: 0, second: 0, of: day)!
            if sample.start < noon { noon = calendar.date(byAdding: .day, value: -1, to: noon)! }
            buckets[Key(source: sample.source, noon: noon), default: []].append(sample)
        }
        var candidates: [Session] = []
        for (key, segments) in buckets {
            let nextDay = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: key.noon))!
            let dawn = calendar.date(bySettingHour: 6, minute: 0, second: 0, of: nextDay)!
            let nextNoon = calendar.date(byAdding: .day, value: 1, to: key.noon)!
            var clusters: [[DateInterval]] = []
            for segment in segments.sorted(by: { $0.start < $1.start }) {
                let interval = DateInterval(start: segment.start, end: segment.end)
                if var last = clusters.popLast() {
                    let tail = last.last!
                    if interval.start <= tail.end {
                        last[last.count - 1] = DateInterval(start: tail.start, end: max(tail.end, interval.end))
                        clusters.append(last)
                    } else if interval.start.timeIntervalSince(tail.end) <= 90 * 60 {
                        last.append(interval)
                        clusters.append(last)
                    } else {
                        clusters.append(last)
                        clusters.append([interval])
                    }
                } else { clusters.append([interval]) }
            }
            for intervals in clusters {
                let session = Session(source: key.source, intervals: intervals)
                guard session.start >= lowerBound, session.end <= reference,
                      session.end <= nextNoon,
                      session.end.timeIntervalSince(session.start) <= 16 * 3600,
                      session.seconds >= 2 * 3600,
                      intervals.contains(where: { $0.start < dawn && $0.end > nextDay }) else { continue }
                candidates.append(session)
            }
        }
        return candidates.sorted {
            if $0.end != $1.end { return $0.end > $1.end }
            if $0.seconds != $1.seconds { return $0.seconds > $1.seconds }
            return $0.source < $1.source
        }.first
    }

    static func summary(_ session: Session, heart: [HeartReading]) -> SleepSummary {
        let valid = heart.filter { reading in
            reading.bpm.isFinite && reading.bpm > 0 && session.intervals.contains {
                $0.start <= reading.date && reading.date < $0.end
            }
        }
        let groups = Dictionary(grouping: valid, by: \.source)
        let selected = groups[session.source] ?? groups.sorted {
            $0.value.count == $1.value.count ? $0.key < $1.key : $0.value.count > $1.value.count
        }.first?.value ?? []
        let average = selected.isEmpty ? nil : selected.reduce(0.0) { $0 + $1.bpm } / Double(selected.count)
        return SleepSummary(sleepStart: session.start, sleepEnd: session.end,
                            totalAsleepMinutes: Int(session.seconds / 60),
                            averageHeartRateBPM: average, provenance: .live)
    }
}
