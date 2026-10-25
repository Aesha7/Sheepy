import Foundation

@main struct ControllerPlanningChecks {
    @MainActor static func main() async {
        let reference = ISO8601DateFormatter().date(from: "2026-10-24T19:00:00Z")!
        let zone = TimeZone(identifier: "America/Los_Angeles")!
        let controller = SleepController(referenceDate: reference, timeZone: zone)
        precondition(!controller.healthAuthorizationFlowCompleted)
        let normal = controller.plan!
        let normalSleep = controller.sleepSummary!
        let explainer = OfflineExplainer()
        let normalText = explainer.explain(controller.explanationResult(for: normal)!)
        precondition(normalText.contains("wakes you at 6:00 AM"))
        precondition(!normalText.contains("Last night was short"))
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
        let badText = explainer.explain(controller.explanationResult(for: bad)!)
        precondition(badText.contains("Last night was short"))
        precondition(badText.contains("winding down at 8:30 PM"))
        precondition(badText != normalText)
        precondition(bad.wake == normal.wake && bad.morningLightStart == normal.morningLightStart)
        precondition(bad.morningLightEnd == normal.morningLightEnd)
        precondition(bad.windDown == normal.windDown.addingTimeInterval(-1800))
        precondition(bad.caffeineCutoff == normal.caffeineCutoff.addingTimeInterval(-1800))
        precondition(controller.explanationResult(for: normal) == nil)
        controller.resetPlanningDemo()
        precondition(controller.plan == normal && controller.sleepSummary == normalSleep)
        precondition(controller.demoSleepScenario == .normal)
        precondition(explainer.explain(controller.explanationResult(for: normal)!) == normalText)
        // A result can change its explanation facts while the displayed dates stay equal.
        let withSleep = controller.planResult!
        controller.sleepSummary = nil
        controller.regeneratePlan()
        precondition(controller.plan == normal && controller.planResult != withSleep)
        precondition(explainer.explain(controller.explanationResult(for: normal)!).contains("No sleep data"))
        controller.resetPlanningDemo()
        controller.profile.preparationMinutes = 90
        precondition(controller.plan!.wake == normal.wake.addingTimeInterval(-1800))
        controller.profile.timeZoneID = "invalid-zone"
        precondition(controller.plan == nil && controller.planResult == nil && controller.plannerError != nil)
        precondition(controller.explanationResult(for: normal) == nil)
        controller.resetPlanningDemo()
        controller.selectLivePlanning()
        precondition(controller.plan == nil && controller.planResult == nil)
        precondition(!controller.healthAuthorizationFlowCompleted)
        HealthKitService.authorizationAction = { throw SheepFailure("Setup failed") }
        let failed = await controller.requestHealthAccess()
        precondition(!failed && !controller.healthAuthorizationFlowCompleted && controller.healthError != nil)
        HealthKitService.authorizationAction = { throw CancellationError() }
        let cancelled = await controller.requestHealthAccess()
        precondition(!cancelled && !controller.healthAuthorizationFlowCompleted)
        HealthKitService.authorizationAction = { controller.resetPlanningDemo() }
        let stale = await controller.requestHealthAccess()
        precondition(!stale && !controller.healthAuthorizationFlowCompleted)
        controller.selectLivePlanning()
        HealthKitService.authorizationAction = {}
        // Mirror HomeView's existing post-authorization fetch, including empty results.
        let completed = await controller.requestHealthAccess()
        precondition(completed && controller.healthAuthorizationFlowCompleted && controller.healthError == nil)
        HealthKitService.nextSummary = nil
        let fetchCount = HealthKitService.summaryFetchCount
        if completed { await controller.refreshLiveSleepSummary(before: reference) }
        precondition(HealthKitService.summaryFetchCount == fetchCount + 1)
        precondition(controller.sleepSummary == nil && controller.healthAuthorizationFlowCompleted)
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
        precondition(controller.healthAuthorizationFlowCompleted)
        let livePlan = controller.plan
        controller.setDemoSleepScenario(.badNight)
        precondition(controller.sleepSummary == live && controller.plan == livePlan)
        // Tomorrow uses the profile timezone, not the phone or a fixed 24h offset.
        controller.profile.timeZoneID = "Asia/Tokyo"
        var tokyo = Calendar(identifier: .gregorian)
        tokyo.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        precondition(tokyo.component(.day, from: controller.plan!.planDate) == 26)
        controller.selectSimulation(true)
        controller.connect()
        controller.simulatePat() // Existing pats must not stop a newly armed demo.
        await controller.startMorningLightDemo()
        precondition(controller.morningLightDemoActive && controller.status?.target == 80)
        controller.simulatePat()
        for _ in 0..<100 where controller.morningLightDemoActive || controller.busy { await Task.yield() }
        precondition(!controller.morningLightDemoActive && controller.status?.target == 0)
        precondition(controller.status?.level == 0 && controller.status?.pats == 2)
        await controller.startMorningLightDemo()
        precondition(controller.morningLightDemoActive)
        await controller.setLamp(brightness: 25, minutes: 0)
        controller.simulatePat()
        await Task.yield()
        precondition(!controller.morningLightDemoActive && controller.status?.target == 25)
        await controller.startMorningLightDemo()
        controller.disconnect()
        precondition(!controller.morningLightDemoActive && controller.status == nil)
        controller.connect()
        controller.simulatePat()
        await Task.yield()
        precondition(!controller.morningLightDemoActive)
        controller.disconnect()
        controller.selectSimulation(false)
        controller.connect()
        var commands: [Int] = []
        BluetoothSheep.onWrite = { hardware, command in
            commands.append(command.brightness)
            if command.brightness == 80 {
                hardware.pat()
                hardware.pat()
                await Task.yield()
            }
        }
        await controller.startMorningLightDemo()
        precondition(commands == [80, 0]) // Exactly one off, after the fade write.
        precondition(!controller.morningLightDemoActive && controller.status?.target == 0)
        BluetoothSheep.onWrite = { hardware, command in
            if command.brightness == 80 { hardware.pat() }
            else { throw SheepFailure("Off write failed") }
        }
        await controller.startMorningLightDemo()
        precondition(!controller.morningLightDemoActive && !controller.busy)
        precondition(controller.error?.contains("Try Light off") == true)
        BluetoothSheep.onWrite = nil
        await controller.setLamp(brightness: 0, minutes: 0)
        precondition(controller.error == nil && controller.status?.target == 0)
        BluetoothSheep.onWrite = { _, _ in controller.disconnect() }
        await controller.startMorningLightDemo()
        precondition(controller.status == nil && !controller.morningLightDemoActive && !controller.busy)
        BluetoothSheep.onWrite = nil
        print("Pat-during-write serialization, duplicate pats, off failure/retry and stale completion checks passed")
        print("Morning demo fade, pat-to-off, rearm, manual override and disconnect checks passed")
        print("Health setup completion, error, cancellation, stale completion and empty post-setup fetch checks passed")
        print("Controller normal → bad-night → reset, refresh, profile, provenance and error checks passed")
    }
}
