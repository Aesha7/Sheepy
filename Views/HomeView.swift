import SwiftUI

// The dashboard. All data comes from SleepController; the bad-night action comes in as a
// closure from the app, and the explanation sheet uses the same controller. Only presentation
// details live here: open sheets and the plan shown before the last change.
@MainActor
struct HomeView: View {
    @ObservedObject var controller: SleepController
    let reportBadNight: (@MainActor () async -> Void)?
    /// Fixed time for previews; nil reads the clock on every redraw.
    let fixedNow: Date?

    @State private var showingExplanation = false
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var showingControls = false
    @State private var reporting = false
    @State private var lastPlan: DailyPlan?
    @State private var previousPlan: DailyPlan?
    // Provider-specific status comes from the controller; local state only tracks UI actions.
    private var calendarBusy: Bool { controller.calendarLoading }
    private var calendarError: String? { controller.calendarError }
    @State private var calendarConnected = false
    @State private var calendarRun = 0   // only the latest calendar action may update the card

    init(controller: SleepController,
         reportBadNight: (@MainActor () async -> Void)? = nil,
         now: Date? = nil) {
        _controller = ObservedObject(wrappedValue: controller)
        self.reportBadNight = reportBadNight
        self.fixedNow = now
    }

    private var now: Date { fixedNow ?? Date() }
    private var mode: PlanningDataMode { controller.planningDataMode }
    private var profileZone: TimeZone { DayTime.zone(controller.profile.timeZoneID) }
    private var busy: Bool { reporting || controller.planningLoading }
    private var planError: String? { controller.plannerError }
    private var badNightActive: Bool { controller.demoSleepScenario == .badNight }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    modeCard
                    // Sheepy's state is only shown when there's sleep data behind it.
                    SheepyView(state: controller.sleepSummary == nil ? nil : controller.sheepyState).card()
                    planSection
                    SleepSummaryView(summary: controller.sleepSummary, mode: mode, timeZone: profileZone,
                                     loading: controller.healthLoading, error: controller.healthError,
                                     onEnable: { Task { await enableHealth() } },
                                     onRefresh: { Task { await refreshHealth() } })
                    CalendarCard(
                        events: controller.calendarEvents, mode: mode, fallbackZone: profileZone, now: now,
                        loading: calendarBusy, error: calendarError, connected: calendarConnected,
                        onEnable: { Task { await enableCalendar() } },
                        onRefresh: { Task { await refreshCalendar() } }
                    )
                    QuestsView(quests: $controller.quests)
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .background(Theme.nightSky.ignoresSafeArea())
            .navigationTitle("Sheepy")
            .navigationBarTitleDisplayMode(.large)
            // A solid bar appears once content scrolls, so text never runs under the status bar.
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingControls = true } label: {
                        Label("Lamp & chat", systemImage: "lightbulb")
                            .labelStyle(.titleAndIcon)
                    }
                    .tint(Theme.accent)
                    .accessibilityHint("Opens the sheep lamp controls and chat")
                }
            }
        }
        .foregroundStyle(Theme.text)
        .fontDesign(.rounded)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showingExplanation) {
            ExplanationView(controller: controller)
        }
        .sheet(isPresented: $showingControls) { ContentView(controller: controller) }
        .onAppear { lastPlan = controller.plan }
        .onChange(of: controller.plan) { _, new in
            // Remember what was on screen before a new plan, so the timeline can mark changes.
            guard let new else { lastPlan = nil; previousPlan = nil; return }
            if let lastPlan, lastPlan != new { previousPlan = lastPlan }
            lastPlan = new
        }
    }

    // MARK: Sections

    private var modeBinding: Binding<PlanningDataMode> {
        Binding(get: { controller.planningDataMode }, set: { switchMode(to: $0) })
    }

    private var modeCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Your sleep plan · \(now.formatted(.dateTime.weekday(.wide).month(.wide).day()))")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.secondaryText)
            Picker("Planning data", selection: modeBinding) {
                Text("Demo").tag(PlanningDataMode.demo)
                Text("Live").tag(PlanningDataMode.live)
            }
            .pickerStyle(.segmented)
            .disabled(reporting)
            if mode == .demo {
                HintText("Sample sleep and calendar.")
                let buttons = typeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
                buttons {
                    CardButton(title: badNightActive ? "Short night" : "I slept poorly",
                               systemImage: "moon.zzz.fill", prominent: !badNightActive) {
                        Task { await runBadNight() }
                    }
                    .disabled(busy || reportBadNight == nil || badNightActive)
                    CardButton(title: "Reset demo", systemImage: "arrow.counterclockwise", action: resetDemo)
                        .disabled(reporting)
                }
                HintText(badNightHint)
            } else {
                HintText("Your own data. Enable Health and Calendar on their cards; nothing loads until you do. \"I slept poorly\" is part of demo mode and never changes your Health data.")
            }
            HintText("The sheep lamp's simulation switch is separate, in Lamp & chat.")
        }
        .card()
    }

    @ViewBuilder private var planSection: some View {
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
        if let plan = controller.plan {
            // Enabled only when the controller retains the exact result behind this plan.
            PlanTimelineView(plan: plan, previous: previousPlan, now: now,
                             onExplain: controller.explanationResult(for: plan) == nil
                                 ? nil : { showingExplanation = true })
        } else {
            planPlaceholder
        }
    }

    private var planPlaceholder: some View {
        VStack(alignment: .leading, spacing: 10) {
            CardHeader(title: "Your plan", systemImage: "list.bullet.clipboard")
            if reporting {
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
                Text("Your wake time, morning light, caffeine cutoff and wind-down will appear here once your plan is ready, with Why this plan? below them.")
                    .foregroundStyle(Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .card()
    }

    private var badNightHint: String {
        if reportBadNight == nil { return "Replanning isn't connected yet." }
        if badNightActive {
            let slept = controller.sleepSummary.map { " (\(DayTime.duration(minutes: $0.totalAsleepMinutes)) of sleep)" } ?? ""
            return "Showing the plan after a short simulated night\(slept). Reset demo to go back."
        }
        return "I slept poorly replaces last night with a short simulated night. Nothing is written to Apple Health."
    }

    // MARK: Actions

    private func switchMode(to newMode: PlanningDataMode) {
        guard newMode != mode, !reporting else { return }
        switch newMode {
        case .demo:
            resetDemo()
        case .live:
            // Selecting live mode never prompts; each card's Enable button asks for access.
            calendarConnected = false
            calendarRun += 1
            controller.selectLivePlanning()
        }
    }

    private func runBadNight() async {
        guard let reportBadNight, !busy, mode == .demo else { return }
        reporting = true
        await reportBadNight()
        reporting = false
    }

    /// Explicit user action: switch to live data, ask for access, then load the next 7 days.
    private func enableCalendar() async {
        guard !busy else { return }
        if mode != .live { controller.selectLivePlanning() }
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
        return calendarRun
    }

    private func loadWeek(_ run: Int) async {
        await controller.refreshLiveCalendarEvents(in: DateInterval(start: Date(), duration: 7 * 24 * 60 * 60))
        finishCalendar(run, succeeded: controller.calendarError == nil)
    }

    private func finishCalendar(_ run: Int, succeeded: Bool) {
        // A newer action, or a mode change such as Back to demo data, supersedes this one.
        guard run == calendarRun else { return }
        guard mode == .live else { return }
        if succeeded { calendarConnected = true }
    }

    private func enableHealth() async {
        guard !busy else { return }
        if mode != .live { controller.selectLivePlanning() }
        if await controller.requestHealthAccess() {
            await controller.refreshLiveSleepSummary(before: Date())
        }
    }

    private func refreshHealth() async {
        guard !busy, mode == .live else { return }
        await controller.refreshLiveSleepSummary(before: Date())
    }

    private func resetDemo() {
        lastPlan = nil
        previousPlan = nil
        calendarConnected = false
        calendarRun += 1
        controller.resetPlanningDemo()
    }
}

// MARK: Previews (the planner runs for real; no sample plans are installed)

#Preview("Demo") {
    let controller = SleepController()
    return HomeView(controller: controller, reportBadNight: { controller.setDemoSleepScenario(.badNight) })
}

#Preview("Demo, bad night") {
    let controller = SleepController()
    controller.setDemoSleepScenario(.badNight)
    return HomeView(controller: controller, reportBadNight: { controller.setDemoSleepScenario(.badNight) })
}

#Preview("Live, no data yet") {
    HomeView(controller: SleepController(planningDataMode: .live))
}

#Preview("Long title, larger text") {
    let controller = SleepController()
    if var event = controller.calendarEvents.first {
        event.title = "Organic Chemistry II Midterm Review Session with the Teaching Assistants in Room 120"
        controller.calendarEvents = [event]
    }
    return HomeView(controller: controller).dynamicTypeSize(.accessibility2)
}
