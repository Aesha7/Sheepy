import Foundation

@main struct ControllerPlanningChecks {
    @MainActor static func main() async {
        let reference = ISO8601DateFormatter().date(from: "2026-10-24T19:00:00Z")!
        let zone = TimeZone(identifier: "America/Los_Angeles")!
        let controller = SleepController(referenceDate: reference, timeZone: zone)
        let normal = controller.plan!
        let normalSleep = controller.sleepSummary!
        precondition(controller.planResult?.plan == normal)
        precondition(controller.explanationResult(for: normal) == controller.planResult)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        precondition(calendar.component(.day, from: normal.planDate) == 25)
        precondition(calendar.component(.hour, from: normal.wake) == 6)
        controller.setDemoSleepScenario(.badNight)
        let bad = controller.plan!
        let badSleep = controller.sleepSummary!
        precondition(badSleep.provenance == .demo && badSleep.totalAsleepMinutes == 330)
        precondition(badSleep.sleepEnd <= reference)
        precondition(badSleep.sleepEnd.timeIntervalSince(badSleep.sleepStart) == 330 * 60)
        precondition(controller.planResult!.isBadNightAdjusted)
        precondition(bad.wake == normal.wake && bad.morningLightStart == normal.morningLightStart)
        precondition(bad.morningLightEnd == normal.morningLightEnd)
        precondition(bad.windDown == normal.windDown.addingTimeInterval(-1800))
        precondition(bad.caffeineCutoff == normal.caffeineCutoff.addingTimeInterval(-1800))
        precondition(controller.explanationResult(for: normal) == nil)
        controller.resetPlanningDemo()
        precondition(controller.plan == normal && controller.sleepSummary == normalSleep)
        precondition(controller.demoSleepScenario == .normal)
        controller.profile.preparationMinutes = 90
        precondition(controller.plan!.wake == normal.wake.addingTimeInterval(-1800))
        controller.profile.timeZoneID = "invalid-zone"
        precondition(controller.plan == nil && controller.planResult == nil && controller.plannerError != nil)
        controller.resetPlanningDemo()
        controller.selectLivePlanning()
        precondition(controller.plan == nil && controller.planResult == nil)
        CalendarService.nextEvents = []
        await controller.refreshLiveCalendarEvents(in: DateInterval(start: reference, duration: 7 * 86400), referenceDate: reference)
        precondition(controller.plan != nil && controller.planResult?.anchorEvent == nil)
        HealthKitService.nextSummary = nil
        await controller.refreshLiveSleepSummary(before: reference)
        precondition(controller.planResult?.hadSleepData == false)
        var live = normalSleep
        live.provenance = .live
        HealthKitService.nextSummary = live
        await controller.refreshLiveSleepSummary(before: reference)
        let livePlan = controller.plan
        controller.setDemoSleepScenario(.badNight)
        precondition(controller.sleepSummary == live && controller.plan == livePlan)
        // Tomorrow uses the profile timezone, not the phone or a fixed 24h offset.
        controller.profile.timeZoneID = "Asia/Tokyo"
        var tokyo = Calendar(identifier: .gregorian)
        tokyo.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        precondition(tokyo.component(.day, from: controller.plan!.planDate) == 26)
        print("Controller normal → bad-night → reset, refresh, profile, provenance and error checks passed")
    }
}
