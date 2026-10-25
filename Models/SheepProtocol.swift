import Foundation

struct SheepFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct SheepStatus: Codable, Equatable {
    let pats: Int
    let light: Int
    let level: Double
    let target: Double
    var simulated: Bool? = nil

    static func parse(_ data: Data) throws -> SheepStatus {
        guard let text = String(data: data, encoding: .utf8) else {
            throw SheepFailure("Sheep sent invalid UTF-8.")
        }
        if text == "ERR" { throw SheepFailure("Sheep rejected the command (ERR).") }
        let fields = text.split(separator: ",", omittingEmptySubsequences: false)
        guard fields.count == 4,
              let pats = Int(fields[0]), pats >= 0,
              let light = Int(fields[1]), (0...1023).contains(light),
              let level = Int(fields[2]), (0...100).contains(level),
              let target = Int(fields[3]), (0...100).contains(target) else {
            throw SheepFailure("Sheep sent malformed status: \(text)")
        }
        return SheepStatus(pats: pats, light: light, level: Double(level), target: Double(target))
    }
}

struct LampCommand {
    let brightness: Int
    let minutes: Double
    let seconds: Double
    init(brightness: Double, minutes: Double, speedup: Double) throws {
        guard brightness.isFinite, minutes.isFinite, speedup.isFinite, speedup >= 1 else {
            throw SheepFailure("Lamp values must be finite; demo speedup must be at least 1.")
        }
        // Python round() uses ties-to-even. Match it at half-brightness boundaries.
        self.brightness = Int(max(0, min(100, brightness.rounded(.toNearestOrEven))))
        self.minutes = max(0, min(30, minutes))
        self.seconds = self.minutes * 60 / speedup
    }
    var text: String {
        String(format: "L,%d,%.1f", locale: Locale(identifier: "en_US_POSIX"), brightness, seconds)
    }
}

struct PatEntry: Codable, Equatable {
    let ts: String
    let count_since_boot: Int
}

struct PatTracker {
    private(set) var baseline: Int?
    mutating func reset() { baseline = nil }
    mutating func consume(_ count: Int, now: Date = Date()) -> [PatEntry] {
        defer { baseline = count }
        guard let previous = baseline, count > previous else { return [] }
        let timestamp = ISO8601DateFormatter().string(from: now)
        return ((previous + 1)...count).map { PatEntry(ts: timestamp, count_since_boot: $0) }
    }
}

func jsonText<T: Encodable>(_ value: T) throws -> String {
    String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
}
