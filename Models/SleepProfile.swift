import Foundation

/// User preferences, not values inferred from hardware pats.
/// Hours are 0...23, minutes 0...59; durations are positive minutes.
struct SleepProfile: Codable, Equatable {
    var preferredWakeHour: Int
    var preferredWakeMinute: Int
    var timeZoneID: String
    var preparationMinutes: Int
    var targetSleepMinutes: Int
}
