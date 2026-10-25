import SwiftUI

// The dashboard. All data comes from SleepController; the two actions it can't do yet
// (replanning after a bad night, explaining a plan) come in as closures from A/B.
// Only presentation details live here: the open sheet and the plan shown before the last change.
@MainActor
struct HomeView: View {
    @ObservedObject var controller: SleepController
    let reportBadNight: (@MainActor () async -> Void)?
    let explain: PlanExplainer?
    /// Fixed time for previews; nil reads the clock on every redraw.
    let fixedNow: Date?

    @State private var showingExplanation = false
    @State private var reporting = false
    @State private var lastPlan: DailyPlan?
    @State private var previousPlan: DailyPlan?
    // planningLoading/planningError are shared by calendar and planning work; these say
    // which one they belong to, so a calendar error isn't shown as a planning error.
    @State private var calendarBusy = false
    @State private var calendarError: String?
    @State private var calendarConnected = false
    @State private var calendarRun = 0   // only the latest calendar action may update the card

    init(controller: SleepController,
         reportBadNight: (@MainActor () async -> Void)? = nil,
         explain: PlanExplainer? = nil,
         now: Date? = nil) {
        _controller = ObservedObject(wrappedValue: controller)
        self.reportBadNight = reportBadNight
        self.explain = explain
        self.fixedNow = now
    }

    private var now: Date { fixedNow ?? Date() }
    private var mode: PlanningDataMode { controller.planningDataMode }
    private var profileZone: TimeZone { DayTime.zone(controller.profile.timeZoneID) }
    private var busy: Bool { reporting || controller.planningLoading }
    private var replanning: Bool { reporting || (controller.planningLoading && !calendarBusy) }
    private var planError: String? {
        guard let error = controller.planningError, error != calendarError else { return nil }
        return error
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                header
                SheepyView(state: controller.sheepyState).card()
                SleepSummaryView(summary: controller.sleepSummary, mode: mode, timeZone: profileZone)
                CalendarCard(
                    events: controller.calendarEvents, mode: mode, fallbackZone: profileZone, now: now,
                    loading: calendarBusy, error: calendarError, connected: calendarConnected,
                    onEnable: { Task { await enableCalendar() } },
                    onRefresh: { Task { await refreshCalendar() } }
                )
                if let plan = controller.plan {
                    PlanTimelineView(plan: plan, previous: previousPlan, now: now)
                } else {
                    planPlaceholder
                }
                QuestsView(quests: $controller.quests)
                actions
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .background(Theme.background.ignoresSafeArea())
        .foregroundStyle(Theme.text)
        .fontDesign(.rounded)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showingExplanation) {
            ExplanationView(plan: controller.plan, explain: explain)
        }
        .onAppear { lastPlan = controller.plan }
        .onChange(of: controller.plan) { _, new in
            // Remember what was on screen before a new plan, so the timeline can mark changes.
            guard let new else { return }
            if let lastPlan, lastPlan != new { previousPlan = lastPlan }
            lastPlan = new
        }
    }

    // MARK: Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            ModeBadge(mode: mode)
            Text("Your sleep plan")
                .font(.largeTitle.weight(.bold))
                .accessibilityAddTraits(.isHeader)
            Text(now.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                .font(.subheadline)
                .foregroundStyle(Theme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }

    private var planPlaceholder: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(title: "Your plan", systemImage: "list.bullet.clipboard")
            if controller.planningLoading && !calendarBusy {
                HStack(spacing: 10) {
                    ProgressView().tint(Theme.accent)
                    Text("Building your plan…")
                }
                .foregroundStyle(Theme.secondaryText)
            } else if let error = planError {
                Label("Couldn't build your plan", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Theme.secondaryText)
            } else {
                Text("Your wake time, morning light, caffeine cutoff and wind-down will appear here once your plan is ready.")
                    .foregroundStyle(Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .card()
    }

    private var actions: some View {
        VStack(spacing: 12) {
            // A failed replan keeps the last plan on screen and says so.
            if controller.plan != nil, let error = planError {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Couldn't update your plan", systemImage: "exclamationmark.triangle")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.warning)
                    Text("Still showing your last plan. \(error)")
                        .font(.footnote)
                        .foregroundStyle(Theme.secondaryText)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Theme.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }

            Button {
                Task { await runBadNight() }
            } label: {
                HStack(spacing: 10) {
                    if replanning {
                        ProgressView().tint(Theme.background)
                        Text("Updating your plan…")
                    } else {
                        Image(systemName: "moon.zzz.fill")
                        Text(mode == .demo ? "Simulate bad night" : "I slept poorly")
                    }
                }
                .font(.headline)
                .foregroundStyle(Theme.background)
                .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 16))
            .tint(Theme.accent)
            .disabled(busy || reportBadNight == nil)

            if reportBadNight == nil {
                caption("Replanning connects when the planner is ready.")
            } else if mode == .demo {
                caption("Demo: simulates a short night. Nothing is written to Apple Health.")
            }

            Button {
                showingExplanation = true
            } label: {
                Label("Why this plan?", systemImage: "questionmark.bubble")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.roundedRectangle(radius: 16))
            .tint(Theme.accent)
            .disabled(controller.plan == nil)

            Button(action: resetDemo) {
                Label(mode == .demo ? "Reset demo" : "Back to demo data", systemImage: "arrow.counterclockwise")
                    .font(.subheadline)
                    .frame(minHeight: 44)
            }
            .tint(Theme.secondaryText)
            .disabled(reporting)
        }
        .padding(.top, 4)
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Theme.secondaryText)
            .multilineTextAlignment(.center)
    }

    // MARK: Actions

    private func runBadNight() async {
        guard let reportBadNight, !busy else { return }
        reporting = true
        await reportBadNight()
        reporting = false
    }

    /// Explicit user action: switch to live data, ask for access, then load the next 7 days.
    private func enableCalendar() async {
        guard !busy else { return }
        controller.selectLivePlanning()
        let run = startCalendar()
        if await controller.requestCalendarAccess() {
            await loadWeek(run)
        } else {
            finishCalendar(run, succeeded: false)
        }
    }

    /// Never prompts; also picks up access granted later in Settings.
    private func refreshCalendar() async {
        guard !busy else { return }
        await loadWeek(startCalendar())
    }

    private func startCalendar() -> Int {
        calendarRun += 1
        calendarBusy = true
        calendarError = nil
        return calendarRun
    }

    private func loadWeek(_ run: Int) async {
        await controller.refreshLiveCalendarEvents(in: DateInterval(start: Date(), duration: 7 * 24 * 60 * 60))
        finishCalendar(run, succeeded: controller.planningError == nil)
    }

    private func finishCalendar(_ run: Int, succeeded: Bool) {
        // A newer action, or a mode change such as Back to demo data, supersedes this one.
        guard run == calendarRun else { return }
        calendarBusy = false
        guard mode == .live else { return }
        calendarError = controller.planningError
        if succeeded { calendarConnected = true }
    }

    private func resetDemo() {
        lastPlan = nil
        previousPlan = nil
        calendarBusy = false
        calendarError = nil
        calendarConnected = false
        calendarRun += 1
        controller.loadPlanningDemo(referenceDate: Date(), timeZone: profileZone)
    }
}

private struct ModeBadge: View {
    let mode: PlanningDataMode

    var body: some View {
        Label(mode == .demo ? "Demo mode" : "Live",
              systemImage: mode == .demo ? "wand.and.stars" : "dot.radiowaves.left.and.right")
            .font(.caption.weight(.bold))
            .foregroundStyle(mode == .demo ? Theme.warm : Theme.accent)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background((mode == .demo ? Theme.warm : Theme.accent).opacity(0.15), in: Capsule())
    }
}

// MARK: Previews (preview-only sample plans; the app uses Person B's planner)

#Preview("Demo, plan not ready") {
    HomeView(controller: SleepController())
}

#Preview("Connected flow (tap the buttons)") {
    let controller = SleepController()
    controller.plan = PreviewPlans.normal()
    return HomeView(
        controller: controller,
        reportBadNight: {
            controller.planningLoading = true
            try? await Task.sleep(for: .seconds(1.2))
            controller.plan = PreviewPlans.badNight()
            controller.sheepyState = .drained
            controller.planningLoading = false
        },
        explain: { _ in
            try await Task.sleep(for: .seconds(0.8))
            return PlanExplanation(text: "Preview text. Your 7 AM commitment sets the wake time; the rest works back from there.",
                                   isFallback: true)
        }
    )
}

#Preview("Live, no data yet") {
    HomeView(controller: SleepController(planningDataMode: .live))
}

#Preview("Replanning failed") {
    let controller = SleepController()
    controller.plan = PreviewPlans.normal()
    controller.planningError = "The planner didn't respond."
    return HomeView(controller: controller, reportBadNight: {})
}

#Preview("Long title, larger text") {
    let controller = SleepController()
    controller.plan = PreviewPlans.normal()
    if var event = controller.calendarEvents.first {
        event.title = "Organic Chemistry II Midterm Review Session with the Teaching Assistants in Room 120"
        controller.calendarEvents = [event]
    }
    return HomeView(controller: controller).dynamicTypeSize(.accessibility2)
}
