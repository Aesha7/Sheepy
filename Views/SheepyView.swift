import SwiftUI
import UIKit

// Renders the SheepyState it is given; which state applies is decided outside the view.
// nil means there's no sleep data to base a state on, so Sheepy is shown neutrally instead
// of implying the user is rested or tired. Uses D's images when the asset catalog has them
// (sheepy-lively, sheepy-sleepy, sheepy-sleeping, sheepy-drained); otherwise SheepyFigure,
// a drawing of the 3D-printed sheep.
struct SheepyView: View {
    let state: SheepyState?
    /// One short sentence; defaults to copy per state until D's final copy lands.
    var status: String? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    private var title: String { state?.label ?? "Sheepy" }
    private var statusText: String {
        status ?? state?.defaultStatus ?? "No recent sleep to go on yet, so Sheepy isn't guessing how you slept."
    }

    var body: some View {
        // Compact row so the sleep summary and plan stay near the top; stacks at accessibility sizes.
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 14))
        layout {
            ZStack {
                artwork
                    .id(state)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.9).combined(with: .opacity))
            }
            .frame(width: 96, height: 84)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(Theme.text)
                Text(statusText)
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(duration: 0.45, bounce: 0.25), value: state)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(state.map { "Sheepy is \($0.label.lowercased()). \(statusText)" } ?? "Sheepy. \(statusText)")
    }

    @ViewBuilder private var artwork: some View {
        if let state, let image = UIImage(named: state.assetName) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
        } else {
            SheepyFigure(state: state)
                .scaleEffect(0.6)
                .frame(width: 96, height: 84)
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

/// Sheepy drawn to match the 3D-printed sheep: bumpy white wool, a tan face and floppy ears
/// under a wool fringe, glossy eyes, a small "ω" mouth and stubby legs. Expression and pose
/// follow the state; nil is a calm neutral face. D's images, when added, replace this drawing.
private struct SheepyFigure: View {
    let state: SheepyState?

    var body: some View {
        ZStack {
            Ellipse()
                .fill(Color.black.opacity(0.28))
                .frame(width: 112, height: 14)
                .offset(y: 64)
            fleece
            legs
            ears
            face
            fringe
            eyes.offset(y: -1)
            mouth
            if state == .lively { cheeks }
            if state == .sleeping { zzz }
        }
        .frame(width: 160, height: 140)
        .rotationEffect(.degrees(tilt), anchor: .bottom)
        .scaleEffect(x: 1, y: state == .drained ? 0.95 : 1, anchor: .bottom)
        .saturation(state == .drained ? 0.45 : 1)
    }

    private var tilt: Double {
        switch state {
        case nil, .lively: return 0
        case .sleepy: return 3
        case .sleeping: return 5
        case .drained: return -4
        }
    }

    /// How far the ears hang down, in degrees.
    private var earDroop: Double {
        switch state {
        case .lively: return 12
        case nil: return 18
        case .sleepy: return 26
        case .sleeping: return 30
        case .drained: return 40
        }
    }

    private var legs: some View {
        HStack(spacing: 30) {
            ForEach(0..<2, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(SheepColors.face)
                    .frame(width: 20, height: 22)
            }
        }
        .offset(y: 55)
    }

    private var fleece: some View {
        ZStack {
            Ellipse()
                .fill(SheepColors.wool)
                .frame(width: 128, height: 100)
            ForEach(0..<16, id: \.self) { i in
                Circle()
                    .fill(SheepColors.wool)
                    .frame(width: 26, height: 26)
                    .offset(Self.bump(i, of: 16))
            }
            ForEach(0..<Self.curls.count, id: \.self) { i in
                Circle()
                    .stroke(SheepColors.woolShade.opacity(0.7), lineWidth: 1.5)
                    .frame(width: 14, height: 14)
                    .offset(x: Self.curls[i].0, y: Self.curls[i].1)
            }
        }
        .offset(y: 14)
    }

    /// Points around the fleece edge, for its bumpy outline.
    private static func bump(_ i: Int, of count: Int) -> CGSize {
        let angle = Double(i) / Double(count) * 2 * .pi
        return CGSize(width: cos(angle) * 60, height: sin(angle) * 46)
    }

    /// Wool curl texture on the visible parts of the fleece.
    private static let curls: [(Double, Double)] = [
        (-46, -8), (-38, 16), (-20, 32), (0, 38), (20, 32), (38, 16), (46, -8), (-52, 6), (52, 6),
    ]

    private var ears: some View {
        ZStack {
            ear.rotationEffect(.degrees(-earDroop)).offset(x: -46, y: -14 + earDroop / 4)
            ear.scaleEffect(x: -1).rotationEffect(.degrees(earDroop)).offset(x: 46, y: -14 + earDroop / 4)
        }
    }

    private var ear: some View {
        ZStack {
            Ellipse().fill(SheepColors.face).frame(width: 36, height: 20)
            Ellipse().fill(SheepColors.earInner).frame(width: 22, height: 10).offset(x: -3)
        }
    }

    private var face: some View {
        Ellipse()
            .fill(LinearGradient(colors: [SheepColors.faceLight, SheepColors.face], startPoint: .top, endPoint: .bottom))
            .frame(width: 66, height: 72)
            .offset(y: -4)
    }

    private var fringe: some View {
        ZStack {
            Ellipse().fill(SheepColors.wool).frame(width: 60, height: 22).offset(y: -44)
            ForEach(0..<5, id: \.self) { i in
                Circle()
                    .fill(SheepColors.wool)
                    .frame(width: 22, height: 22)
                    .offset(x: Double(i - 2) * 13, y: i == 2 ? -39 : -36)
            }
        }
    }

    private var eyes: some View {
        HStack(spacing: 18) {
            ForEach(0..<2, id: \.self) { side in eye(side) }
        }
    }

    @ViewBuilder private func eye(_ side: Int) -> some View {
        switch state {
        case .sleeping:
            SmileCurve()
                .stroke(SheepColors.eye, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .frame(width: 13, height: 6)
        case .sleepy, .drained:
            // Heavy lids: only the lower part of the eye shows, under a lid line.
            let visible: CGFloat = state == .drained ? 6 : 8
            openEye(width: 12, height: 15)
                .mask(alignment: .bottom) { Rectangle().frame(height: visible) }
                .overlay {
                    Capsule()
                        .fill(SheepColors.eye)
                        .frame(width: 15, height: 2.5)
                        .offset(y: 7.5 - visible)
                }
                .rotationEffect(.degrees(state == .drained ? (side == 0 ? -10 : 10) : 0))
        case .lively:
            openEye(width: 13, height: 16)
        case nil:
            openEye(width: 11, height: 13)
        }
    }

    /// A glossy eye with the two highlights from the print.
    private func openEye(width: CGFloat, height: CGFloat) -> some View {
        Ellipse()
            .fill(SheepColors.eye)
            .frame(width: width, height: height)
            .overlay {
                Circle()
                    .fill(Color.white)
                    .frame(width: width * 0.4, height: width * 0.4)
                    .offset(x: -width * 0.14, y: -height * 0.18)
            }
            .overlay {
                Circle()
                    .fill(Color.white.opacity(0.9))
                    .frame(width: width * 0.17, height: width * 0.17)
                    .offset(x: width * 0.18, y: height * 0.2)
            }
    }

    @ViewBuilder private var mouth: some View {
        switch state {
        case .drained:
            SmileCurve()
                .stroke(SheepColors.eye, style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                .frame(width: 12, height: 4)
                .rotationEffect(.degrees(180))
                .offset(y: 18)
        case .sleeping:
            Ellipse()
                .stroke(SheepColors.eye, lineWidth: 2)
                .frame(width: 5, height: 6)
                .offset(y: 17)
        default:
            MouthShape()
                .stroke(SheepColors.eye, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                .frame(width: 16, height: 9)
                .offset(y: 15)
        }
    }

    private var cheeks: some View {
        HStack(spacing: 30) {
            ForEach(0..<2, id: \.self) { _ in
                Ellipse().fill(SheepColors.blush.opacity(0.4)).frame(width: 10, height: 6)
            }
        }
        .offset(y: 9)
    }

    private var zzz: some View {
        ZStack {
            Text("z").font(.system(size: 14, weight: .bold, design: .rounded)).offset(x: 50, y: -40)
            Text("z").font(.system(size: 18, weight: .bold, design: .rounded)).offset(x: 61, y: -52)
            Text("Z").font(.system(size: 22, weight: .bold, design: .rounded)).offset(x: 73, y: -64)
        }
        .foregroundStyle(Theme.accent)
    }
}

/// The print's mouth: a short line down from the nose that splits into a small "ω".
private struct MouthShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let join = CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.45)
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: join)
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.3))
        path.addQuadCurve(to: join, control: CGPoint(x: rect.minX + rect.width * 0.22, y: rect.maxY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.3),
                          control: CGPoint(x: rect.maxX - rect.width * 0.22, y: rect.maxY))
        return path
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
            ForEach(SheepyState.allCases, id: \.self) { SheepyView(state: $0).card() }
            SheepyView(state: nil).card()
        }
        .padding(16)
    }
    .background(Theme.nightSky)
    .preferredColorScheme(.dark)
}
