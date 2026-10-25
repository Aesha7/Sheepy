import Foundation

@MainActor
final class PatLog {
    private var tracker = PatTracker()
    private let url: URL
    private(set) var entries: [PatEntry]
    init(simulated: Bool) throws {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory,
            in: .userDomainMask, appropriateFor: nil, create: true)
        url = directory.appendingPathComponent(simulated ? "simulated-pats.json" : "pats.json")
        if FileManager.default.fileExists(atPath: url.path) {
            entries = try JSONDecoder().decode([PatEntry].self, from: Data(contentsOf: url))
        } else { entries = [] }
    }
    func resetBaseline() { tracker.reset() }
    func record(_ count: Int) throws {
        var nextTracker = tracker
        let new = nextTracker.consume(count)
        if !new.isEmpty {
            let next = entries + new
            try JSONEncoder().encode(next).write(to: url, options: .atomic)
            entries = next
        }
        tracker = nextTracker
    }
    func recent(_ limit: Int = 50) -> [PatEntry] { Array(entries.suffix(max(1, min(200, limit)))) }
}
