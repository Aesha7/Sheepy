import SwiftUI

// Shows the shared quest list and edits completion through the binding, so the
// list in SleepController stays the only copy.
struct QuestsView: View {
    @Binding var quests: [Quest]

    private var doneCount: Int { quests.filter(\.isCompleted).count }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                CardHeader(title: "Today's quests", systemImage: "star.fill")
                Spacer(minLength: 8)
                if !quests.isEmpty {
                    Text("\(doneCount) of \(quests.count)")
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Theme.accent)
                        .contentTransition(.numericText())
                }
            }

            if quests.isEmpty {
                Text("No quests right now.")
                    .foregroundStyle(Theme.secondaryText)
            } else {
                ProgressView(value: Double(doneCount), total: Double(quests.count))
                    .tint(Theme.accent)
                    .accessibilityLabel("\(doneCount) of \(quests.count) quests done")
            }

            ForEach($quests) { $quest in
                Button {
                    quest.isCompleted.toggle()
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: quest.isCompleted ? "checkmark.circle.fill" : "circle")
                            .font(.title2)
                            .foregroundStyle(quest.isCompleted ? Theme.accent : Theme.secondaryText)
                            .contentTransition(.symbolEffect(.replace))
                        Text(quest.title)
                            .font(.body)
                            .foregroundStyle(quest.isCompleted ? Theme.secondaryText : Theme.text)
                            .strikethrough(quest.isCompleted, color: Theme.secondaryText)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(quest.title)
                .accessibilityValue(quest.isCompleted ? "Done" : "Not done")
                .accessibilityHint("Double-tap to mark as \(quest.isCompleted ? "not done" : "done")")
            }
        }
        .card()
        .animation(.easeInOut(duration: 0.2), value: quests)
        .sensoryFeedback(.selection, trigger: doneCount)
    }
}

#Preview("Quests (tap to check)") {
    QuestsPreviewHost()
}

private struct QuestsPreviewHost: View {
    @State private var quests = [
        Quest(id: "light", title: "Get 10 minutes of morning light", isCompleted: false),
        Quest(id: "caffeine", title: "Finish caffeine before the cutoff", isCompleted: true),
        Quest(id: "screens", title: "Put screens away at wind-down", isCompleted: false),
    ]

    var body: some View {
        QuestsView(quests: $quests)
            .padding(16)
            .frame(maxHeight: .infinity)
            .background(Theme.background)
            .preferredColorScheme(.dark)
    }
}
