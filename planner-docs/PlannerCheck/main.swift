import Foundation

// Standalone check runner for EventClassifier + PlanEngine.
// Compile together with the shared models; no Xcode, signing, or simulator needed.
// Prototype rules only; not medically validated.

var checks = 0
var failures = 0

func check(_ ok: Bool, _ label: String) {
    checks += 1
    if !ok {
        failures += 1
        print("FAIL: \(label)")
    }
}

let zoneID = "America/Los_Angeles"
let tz = TimeZone(identifier: zoneID)!
var cal = Calendar(identifier: .gregorian)
cal.timeZone = tz

let fmt = DateFormatter()
fmt.locale = Locale(identifier: "en_US_POSIX")
fmt.timeZone = tz
fmt.dateFormat = "EEE MMM d, h:mm a"

func show(_ d: Date) -> String { fmt.string(from: d) }

/// Local wall-clock date in America/Los_Angeles.
func at(_ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0, year: Int = 2026) -> Date {
    var c = DateComponents()
    c.year = year
    c.month = month
    c.day = day
    c.hour = hour
    c.minute = minute
    return cal.date(from: c)!
}

func same(_ actual: Date, _ expected: Date, _ label: String) {
    checks += 1
    if actual != expected {
        failures += 1
        print("FAIL: \(label)")
        print("   expected \(show(expected))")
        print("   actual   \(show(actual))")
    }
}

func parts(_ d: Date) -> (month: Int, day: Int, hour: Int, minute: Int) {
    let c = cal.dateComponents([.month, .day, .hour, .minute], from: d)
    return (c.month!, c.day!, c.hour!, c.minute!)
}

// MARK: - Fixtures

func profile(wakeHour: Int = 7, wakeMinute: Int = 0, prep: Int = 60,
             sleep: Int = 480, zone: String = "America/Los_Angeles") -> SleepProfile {
    SleepProfile(preferredWakeHour: wakeHour, preferredWakeMinute: wakeMinute,
                 timeZoneID: zone, preparationMinutes: prep, targetSleepMinutes: sleep)
}

func sleepSummary(_ minutes: Int) -> SleepSummary {
    let end = at(10, 25, 7)
    return SleepSummary(sleepStart: end.addingTimeInterval(-Double(minutes) * 60),
                        sleepEnd: end, totalAsleepMinutes: minutes,
                        averageHeartRateBPM: nil, provenance: .demo)
}

func event(_ id: String, _ start: Date, title: String = "Meeting",
           allDay: Bool = false, dest: String? = nil) -> CalendarEvent {
    CalendarEvent(id: id, title: title, start: start, end: start.addingTimeInterval(3600),
                  isAllDay: allDay, timeZoneID: zoneID, destinationTimeZoneID: dest)
}

let engine = PlanEngine()

/// Default plan day: Monday Oct 26, 2026 (the wake day). Passing a mid-day Date
/// also checks that the planner snaps to the local start of day.
func plan(day: Date = at(10, 26, 15, 30), profile p: SleepProfile = profile(),
          sleep: SleepSummary? = sleepSummary(480),
          events: [CalendarEvent] = []) -> PlanResult {
    try! engine.makeResult(for: day, profile: p, sleepSummary: sleep, events: events)
}

func expectThrow(_ label: String, _ body: () throws -> Void) {
    checks += 1
    do {
        try body()
        failures += 1
        print("FAIL: \(label) did not throw")
    } catch {
        // expected
    }
}

// MARK: - 1. 7 AM meeting, normal night

do {
    let r = plan(events: [event("m", at(10, 26, 7))])
    same(r.plan.wake, at(10, 26, 6), "7AM meeting: wake 6:00 AM")
    same(r.plan.morningLightStart, at(10, 26, 6, 30), "7AM meeting: light start 6:30 AM")
    same(r.plan.morningLightEnd, at(10, 26, 7), "7AM meeting: light end 7:00 AM")
    same(r.bedtime, at(10, 25, 22), "7AM meeting: bedtime 10:00 PM")
    same(r.plan.caffeineCutoff, at(10, 25, 14), "7AM meeting: caffeine cutoff 2:00 PM")
    same(r.plan.windDown, at(10, 25, 21), "7AM meeting: wind-down 9:00 PM")
    same(r.plan.planDate, at(10, 26, 0), "planDate is local start of day")
    check(r.plan.timeZoneID == zoneID, "timeZoneID carried through")
    check(!r.isBadNightAdjusted, "480 min is not a bad night")
    check(r.hadSleepData, "sleep data present")
    check(r.anchorEvent?.event.id == "m", "7AM meeting is the anchor")
}

// MARK: - 2. 7 AM meeting, bad night (wake fixed, everything else earlier)

do {
    let r = plan(sleep: sleepSummary(330), events: [event("m", at(10, 26, 7))])
    same(r.plan.wake, at(10, 26, 6), "bad night: wake still 6:00 AM")
    same(r.plan.morningLightStart, at(10, 26, 6, 30), "bad night: light start 6:30 AM")
    same(r.bedtime, at(10, 25, 21, 30), "bad night: bedtime 9:30 PM")
    same(r.plan.caffeineCutoff, at(10, 25, 13, 30), "bad night: caffeine cutoff 1:30 PM")
    same(r.plan.windDown, at(10, 25, 20, 30), "bad night: wind-down 8:30 PM")
    check(r.isBadNightAdjusted, "330 min is a bad night")
    check(r.sleepOpportunityMinutes == 510, "bad night: 510 min opportunity")
}

// MARK: - 3. Bad-night threshold edges

do {
    check(!plan(sleep: sleepSummary(360)).isBadNightAdjusted, "360 min is not bad")
    check(plan(sleep: sleepSummary(359)).isBadNightAdjusted, "359 min is bad")
}

// MARK: - 4. No events

let baseline = plan(events: [])
do {
    same(baseline.plan.wake, at(10, 26, 7), "no events: wake 7:00 AM")
    same(baseline.bedtime, at(10, 25, 23), "no events: bedtime 11:00 PM")
    same(baseline.plan.caffeineCutoff, at(10, 25, 15), "no events: caffeine 3:00 PM")
    same(baseline.plan.windDown, at(10, 25, 22), "no events: wind-down 10:00 PM")
    check(baseline.anchorEvent == nil, "no events: no anchor")
}

// MARK: - 5. Events that must not move the wake time

do {
    let allDay = plan(events: [event("a", at(10, 26, 7), allDay: true)])
    check(allDay.plan == baseline.plan, "all-day event ignored")

    let ten = plan(events: [event("t", at(10, 26, 10))])
    check(ten.plan == baseline.plan, "10 AM meeting is not early")

    let notBinding = plan(events: [event("n", at(10, 26, 8, 30))])
    same(notBinding.plan.wake, at(10, 26, 7), "8:30 meeting: wake stays 7:00 AM")
    check(notBinding.anchorEvent == nil, "8:30 meeting does not anchor the wake time")

    let otherDays = plan(events: [event("d1", at(10, 27, 7)), event("d0", at(10, 25, 7))])
    check(otherDays.plan == baseline.plan, "events on other days ignored")
}

// MARK: - 6. Several events: earliest wins regardless of array order

do {
    let list = [event("late", at(10, 26, 10)), event("mid", at(10, 26, 7, 30)),
                event("early", at(10, 26, 6, 45))]
    let forward = plan(events: list)
    let backward = plan(events: Array(list.reversed()))
    same(forward.plan.wake, at(10, 26, 5, 45), "earliest event 6:45 gives wake 5:45 AM")
    check(forward.plan == backward.plan, "array order does not matter")
    check(forward.anchorEvent?.event.id == "early", "earliest event is the anchor")
}

// MARK: - 7. Missing sleep data

do {
    let r = plan(sleep: nil, events: [event("m", at(10, 26, 7))])
    check(!r.hadSleepData, "nil sleep: hadSleepData false")
    check(!r.isBadNightAdjusted, "nil sleep: not a bad night")
    same(r.plan.wake, at(10, 26, 6), "nil sleep: wake still computed")
}

// MARK: - 8. Flights come only from explicit metadata

do {
    let classifier = EventClassifier()
    let items = classifier.classify(
        events: [event("f", at(10, 26, 7), title: "Flight", dest: "Asia/Tokyo"),
                 event("t", at(10, 26, 8), title: "Flight to Tokyo")],
        planDate: at(10, 26, 12), timeZone: tz)
    check(items.count == 2, "classifier keeps both timed events")
    check(items.first?.isFlight == true, "explicit destination marks a flight")
    check(items.first?.isEarly == true, "7 AM flight is early")
    check(items.last?.isFlight == false, "title text never marks a flight")

    let r = plan(events: [event("f", at(10, 26, 7), title: "Flight", dest: "Asia/Tokyo")])
    same(r.plan.wake, at(10, 26, 6), "flight at 7 AM: wake 6:00 AM")
    check(r.anchorEvent?.isFlight == true, "flight anchors the wake time")

    let badDest = classifier.classify(
        events: [event("x", at(10, 26, 7), dest: "Not/AZone")],
        planDate: at(10, 26, 12), timeZone: tz)
    check(badDest.first?.isFlight == false, "invalid destination id is not a flight")
}

// MARK: - 9. Midnight crossing

do {
    let r = plan(profile: profile(wakeHour: 9))
    let bed = parts(r.bedtime)
    check(bed.month == 10 && bed.day == 26 && bed.hour == 1,
          "9 AM wake: bedtime is 1:00 AM on the wake day")
    let wind = parts(r.plan.windDown)
    check(wind.day == 26 && wind.hour == 0 && wind.minute == 0,
          "9 AM wake: wind-down is midnight on the wake day")
    let caf = parts(r.plan.caffeineCutoff)
    check(caf.day == 25 && caf.hour == 17, "9 AM wake: caffeine cutoff 5 PM the evening before")
}

// MARK: - 10. Daylight saving (elapsed time, not wall clock)

do {
    // Fall back: Sunday Nov 1, 2026. The night before has 9 wall-clock hours
    // between 10 PM and 7 AM, so 8 elapsed hours before 7:00 AM is midnight.
    let r = plan(day: at(11, 1, 12))
    check(parts(r.plan.wake).hour == 7, "fall back: wake 7:00 AM local")
    check(r.plan.wake.timeIntervalSince(r.bedtime) == 8 * 3600,
          "fall back: exactly 8 elapsed hours of sleep")
    let bed = parts(r.bedtime)
    check(bed.month == 11 && bed.day == 1 && bed.hour == 0, "fall back: bedtime is midnight Nov 1")
}

do {
    // Spring forward: Sunday Mar 8, 2026. 8 elapsed hours before 7:00 AM PDT is 10 PM PST.
    let r = plan(day: at(3, 8, 12))
    check(parts(r.plan.wake).hour == 7, "spring forward: wake 7:00 AM local")
    check(r.plan.wake.timeIntervalSince(r.bedtime) == 8 * 3600,
          "spring forward: exactly 8 elapsed hours of sleep")
    let bed = parts(r.bedtime)
    check(bed.month == 3 && bed.day == 7 && bed.hour == 22, "spring forward: bedtime 10 PM Mar 7")
}

// MARK: - 11. Invalid preferences throw

do {
    let day = at(10, 26, 12)
    expectThrow("unknown time zone") {
        _ = try engine.makeResult(for: day, profile: profile(zone: "Not/AZone"), sleepSummary: nil, events: [])
    }
    expectThrow("wake hour 25") {
        _ = try engine.makeResult(for: day, profile: profile(wakeHour: 25), sleepSummary: nil, events: [])
    }
    expectThrow("wake minute 60") {
        _ = try engine.makeResult(for: day, profile: profile(wakeMinute: 60), sleepSummary: nil, events: [])
    }
    expectThrow("preparation 0") {
        _ = try engine.makeResult(for: day, profile: profile(prep: 0), sleepSummary: nil, events: [])
    }
    expectThrow("target sleep 0") {
        _ = try engine.makeResult(for: day, profile: profile(sleep: 0), sleepSummary: nil, events: [])
    }
}

// MARK: - 12. Stateless: same input, same output

do {
    let list = [event("m", at(10, 26, 7))]
    check(plan(events: list) == plan(events: list), "repeated calls give identical results")
    let withEvent = plan(events: list)
    let afterRefresh = plan(events: [])
    check(withEvent.plan.wake != afterRefresh.plan.wake, "removing the event changes the wake time")
}

// MARK: - Summary

print("\(checks) checks, \(failures) failures")
exit(failures == 0 ? 0 : 1)
