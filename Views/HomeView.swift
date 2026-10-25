import SwiftUI

// The dashboard. All data comes from SleepController; the two actions it can't do yet
// (replanning after a bad night, explaining a plan) come in as closures from A/B.
// Only presentation details live here: the open sheet and the plan shown before the last change.
@MainActor
struct HomeView: View {
    @ObservedObject var controller: SleepController
    let reportBadNight: (@MainActor () async -> Void)?
    let explain: PlanExplainer?
    let now: Date

    @State private var showingExplanation = false
    @State private var reporting = false
    @State private var lastPlan: DailyPlan?
    @State private var previousPlan: DailyPlan?

    init(controller: SleepController,
         reportBadNight: (@MainActor () async -> Void)? = nil,
         explain: PlanExplainer? = nil,
         now: Date = .now) {
        _controller = ObservedObject(wrappedValue: controller)
        self.reportBadNight = reportBadNight
        self.explain = explain
        self.now = now
    }

    private var mode: PlanningDataMode { controller.planningDataMode }
    private var profileZone: TimeZone { DayTime.zone(controller.profile.timeZoneID) }
    private var busy: Bool { reporting || controller.planningLoading }

    private var nextEvent: CalendarEvent? {
        controller.calendarEvents.filter { $0.end > now }.min { $0.start < $1.start }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                header
                SheepyView(state: controller.sheepyState).card()
                SleepSummaryView(summary: controller.sleepSummary, mode: mode, timeZone: profileZone)
                CommitmentCard(event: nextEvent, mode: mode, fallbackZone: profileZone, now: now)
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
            if controller.planningLoading {
                HStack(spacing: 10) {
                    ProgressView().tint(Theme.accent)
                    Text("Building your plan…")
                }
                .foregroundStyle(Theme.secondaryText)
            } else if let error = controller.planningError {
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
            if controller.plan != nil, let error = controller.planningError {
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
                    if busy {
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

            if mode == .demo {
                Button(action: resetDemo) {
                    Label("Reset demo", systemImage: "arrow.counterclockwise")
                        .font(.subheadline)
                        .frame(minHeight: 44)
                }
                .tint(Theme.secondaryText)
                .disabled(busy)
            }
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

    private func resetDemo() {
        lastPlan = nil
        previousPlan = nil
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

struct CommitmentCard: View {
    let event: CalendarEvent?
    let mode: PlanningDataMode
    let fallbackZone: TimeZone
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            CardHeader(title: "Next commitment", systemImage: "calendar", source: mode)

            if let event {
                let zone = event.timeZoneID.flatMap { TimeZone(identifier: $0) } ?? fallbackZone
                Text(event.title)
                    .font(.title3.weight(.semibold))
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .accessibilityLabel(event.title)
                Text(event.isAllDay
                     ? "\(DayTime.day(event.start, now: now, in: zone)) · All day"
                     : "\(DayTime.day(event.start, now: now, in: zone)) at \(DayTime.time(event.start, in: zone))")
                    .foregroundStyle(Theme.secondaryText)
                if !event.isAllDay, let note = DayTime.zoneNote(zone, at: event.start) {
                    Label("\(note) time", systemImage: "globe")
                        .font(.footnote)
                        .foregroundStyle(Theme.warm)
                }
                if let destination = event.destinationTimeZoneID.flatMap(TimeZone.init(identifier:)) {
                    Label("Destination time zone: \(destination.abbreviation(for: event.end) ?? destination.identifier)",
                          systemImage: "airplane")
                        .font(.footnote)
                        .foregroundStyle(Theme.warm)
                }
            } else {
                Text("No upcoming commitments.")
                    .foregroundStyle(Theme.secondaryText)
            }
        }
        .card()
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
