import SwiftUI
import UIKit

// Renders the SheepyState it is given. Which state applies is decided outside the view.
// Uses D's images when the asset catalog has them (sheepy-lively, sheepy-sleepy,
// sheepy-sleeping, sheepy-drained); otherwise a simple drawn placeholder, labeled as such.
struct SheepyView: View {
    let state: SheepyState
    /// One short sentence; defaults to placeholder copy per state until D's final copy lands.
    var status: String? = nil

    private var statusText: String { status ?? state.defaultStatus }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                artwork
                    .id(state)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.9).combined(with: .opacity))
            }
            .frame(width: 180, height: 150)
            .accessibilityHidden(true)

            Text(state.label)
                .font(.title2.weight(.bold))
                .foregroundStyle(Theme.text)

            if !statusText.isEmpty {
                Text(statusText)
                    .font(.body)
                    .foregroundStyle(Theme.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.45, bounce: 0.25), value: state)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Sheepy is \(state.label.lowercased()). \(statusText)")
    }

    @ViewBuilder private var artwork: some View {
        if let image = UIImage(named: state.assetName) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
        } else {
            VStack(spacing: 2) {
                PlaceholderSheep(state: state)
                Text("Placeholder art")
                    .font(.caption2)
                    .foregroundStyle(Theme.secondaryText.opacity(0.7))
            }
        }
    }
}

extension SheepyState {
    var label: String {
        switch self {
        case .lively: return "Lively"
        case .sleepy: return "Sleepy"
        case .sleeping: return "Sleeping"
        case .drained: return "Drained"
        }
    }

    var defaultStatus: String {
        switch self {
        case .lively: return "Ready for the day."
        case .sleepy: return "Getting cozy. Wind-down is close."
        case .sleeping: return "Sound asleep."
        case .drained: return "Running low after a rough night."
        }
    }

    var assetName: String {
        switch self {
        case .lively: return "sheepy-lively"
        case .sleepy: return "sheepy-sleepy"
        case .sleeping: return "sheepy-sleeping"
        case .drained: return "sheepy-drained"
        }
    }
}

/// Temporary drawn sheep until D's images land: wool, face, and eyes/pose per state.
private struct PlaceholderSheep: View {
    let state: SheepyState

    private let face = Color(red: 0.23, green: 0.20, blue: 0.27)

    var body: some View {
        ZStack {
            wool
            Ellipse()
                .fill(face)
                .frame(width: 58, height: 66)
                .offset(y: 10)
            eyes.offset(y: 2)
            mouth.offset(y: 24)
            if state == .sleeping { zzz }
        }
        .frame(width: 170, height: 125)
        .rotationEffect(.degrees(tilt))
        .scaleEffect(x: 1, y: state == .drained ? 0.93 : 1, anchor: .bottom)
        .offset(y: state == .lively ? -4 : 0)
        .saturation(state == .drained ? 0.35 : 1)
    }

    private var tilt: Double {
        switch state {
        case .lively: return 0
        case .sleepy: return 5
        case .sleeping: return 8
        case .drained: return -7
        }
    }

    private var wool: some View {
        ZStack {
            Circle().frame(width: 58).offset(x: -34, y: -14)
            Circle().frame(width: 62).offset(x: 0, y: -26)
            Circle().frame(width: 58).offset(x: 34, y: -14)
            Circle().frame(width: 54).offset(x: -46, y: 22)
            Circle().frame(width: 54).offset(x: 46, y: 22)
            Circle().frame(width: 76).offset(y: 30)
        }
        .foregroundStyle(Theme.text)
    }

    @ViewBuilder private var eyes: some View {
        HStack(spacing: 16) {
            ForEach(0..<2, id: \.self) { side in
                switch state {
                case .lively:
                    Circle().fill(Theme.text).frame(width: 10, height: 10)
                case .sleepy:
                    Capsule().fill(Theme.text).frame(width: 12, height: 4)
                case .sleeping:
                    SmileCurve().stroke(Theme.text, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .frame(width: 12, height: 6)
                case .drained:
                    Capsule().fill(Theme.text).frame(width: 11, height: 3)
                        .rotationEffect(.degrees(side == 0 ? -14 : 14))
                        .offset(y: 3)
                }
            }
        }
    }

    @ViewBuilder private var mouth: some View {
        switch state {
        case .lively:
            SmileCurve().stroke(Theme.text, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .frame(width: 18, height: 8)
        case .sleepy, .sleeping:
            Capsule().fill(Theme.text.opacity(0.8)).frame(width: 8, height: 3)
        case .drained:
            SmileCurve().stroke(Theme.text, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .frame(width: 16, height: 6)
                .rotationEffect(.degrees(180))
        }
    }

    private var zzz: some View {
        ZStack {
            Text("z").font(.system(size: 14, weight: .bold, design: .rounded)).offset(x: 52, y: -40)
            Text("z").font(.system(size: 18, weight: .bold, design: .rounded)).offset(x: 64, y: -56)
            Text("Z").font(.system(size: 22, weight: .bold, design: .rounded)).offset(x: 78, y: -74)
        }
        .foregroundStyle(Theme.accent)
    }
}

/// A U-shaped curve: closed eyes, and a smile (or a frown when rotated).
private struct SmileCurve: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY),
                          control: CGPoint(x: rect.midX, y: rect.maxY * 2))
        return path
    }
}

#Preview("All four states") {
    ScrollView {
        VStack(spacing: 24) {
            ForEach(SheepyState.allCases, id: \.self) { SheepyView(state: $0) }
        }
        .padding(16)
    }
    .background(Theme.background)
    .preferredColorScheme(.dark)
}
