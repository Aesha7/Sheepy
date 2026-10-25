import Foundation

/// Standalone mapping checks; never instantiate EKEventStore or request permission.
@main
struct CalendarMappingChecks {
    static func main() throws {
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        let interval = DateInterval(start: base, duration: 3600)
        func mapped(_ start: Double, _ end: Double, allDay: Bool = false,
                    zone: String? = "America/Los_Angeles", id: String? = "source-id") throws -> CalendarEvent? {
            try CalendarService.map(id: id, title: "Flight to Tokyo", start: base.addingTimeInterval(start),
                                    end: base.addingTimeInterval(end), isAllDay: allDay,
                                    timeZoneID: zone, in: interval)
        }
        func absent(_ start: Double, _ end: Double) throws {
            let event = try mapped(start, end)
            precondition(event == nil)
        }
        try absent(-60, 0) // ends exactly at query start
        try absent(3600, 7200) // begins exactly at query end
        try absent(3600, 3600) // point at excluded end
        let point = try mapped(0, 0)
        precondition(point != nil)
        let spanning = try mapped(-86400, 86400, allDay: true)
        precondition(spanning?.isAllDay == true)
        precondition(spanning?.start == base.addingTimeInterval(-86400))
        precondition(spanning?.end == base.addingTimeInterval(86400))
        precondition(spanning?.id == "source-id")
        precondition(spanning?.title == "Flight to Tokyo")
        precondition(spanning?.timeZoneID == "America/Los_Angeles")
        precondition(spanning?.destinationTimeZoneID == nil) // no title inference
        let floating = try mapped(0, 60, zone: nil)
        precondition(floating?.timeZoneID == nil)
        let repeatMapping = try mapped(0, 60, zone: nil)
        precondition(floating == repeatMapping)
        let empty = try CalendarService.map(id: "id", title: "", start: base, end: base,
                                           isAllDay: false, timeZoneID: nil,
                                           in: DateInterval(start: base, duration: 0))
        precondition(empty == nil)
        do {
            _ = try mapped(60, 0)
            preconditionFailure("Accepted reversed event dates")
        } catch { }
        do {
            _ = try mapped(0, 60, id: nil)
            preconditionFailure("Accepted missing source identifier")
        } catch { }
        print("Calendar mapping checks passed")
    }
}
