import SwiftUI

// Native port of the Mac's theme, which since 2026-09-11 is tmea.space's
// (CLAUDE.md "UI Design Theme"; css/core.css :root is the source of truth for
// every value here — change them together): an off-white ground, white only
// for the sheets you read, near-black ink with three real grey steps, two
// hairlines, ONE accent blue that marks only what is live, the OS serif
// (Charter) at REGULAR weight for headings, the system sans for everything
// else, one panel radius, pills for buttons and single-line fields. All
// colours adapt to light/dark exactly like the CSS variables.
//
// Replaced the "Minimal Book Theme" port (bundled Nunito extrabold display
// font, pure-white page, 12/16px radii) the same day the Mac dropped it.

extension Color {
    init(rgb: UInt) {
        self.init(.sRGB,
                  red: Double((rgb >> 16) & 0xFF) / 255,
                  green: Double((rgb >> 8) & 0xFF) / 255,
                  blue: Double(rgb & 0xFF) / 255)
    }
    /// "#RRGGBB" → Color (for user-chosen accent colors like focus areas).
    init(hexString: String) {
        let hex = hexString.trimmingCharacters(in: CharacterSet(charactersIn: " #"))
        self.init(rgb: UInt(UInt64(hex, radix: 16) ?? 0x78909C))
    }
}

#if canImport(UIKit)
import UIKit
private func dyn(_ light: UInt, _ dark: UInt, alpha: CGFloat = 1) -> Color {
    Color(UIColor { trait in
        let v = trait.userInterfaceStyle == .dark ? dark : light
        return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255,
                       green: CGFloat((v >> 8) & 0xFF) / 255,
                       blue: CGFloat(v & 0xFF) / 255, alpha: alpha)
    })
}
#else
private func dyn(_ light: UInt, _ dark: UInt, alpha: CGFloat = 1) -> Color { Color(rgb: light).opacity(alpha) }
#endif

public enum Theme {
    // Colors — (light, dark), matching css/core.css :root + [data-theme="dark"].
    /// The ground (`--color-bg`). Pages, rails and the function bar sit here.
    public static let bg = dyn(0xF5F5F3, 0x131312)
    /// The sheet (`--color-surface`): cards, editors, bubbles, chips — white
    /// on the off-white ground reads as raised paper without a shadow.
    public static let surface = dyn(0xFFFFFF, 0x1B1B1A)
    public static let surfaceHover = dyn(0xEBEBE8, 0x232321)
    public static let text = dyn(0x171717, 0xECECEA)
    public static let textSecondary = dyn(0x4F4F4C, 0xB4B4B0)
    public static let textTertiary = dyn(0x6F6F6C, 0x9A9A96)
    public static let textQuaternary = dyn(0xA3A3A0, 0x62625F)
    public static let border = dyn(0xE4E4E0, 0x2A2A28)
    public static let borderLight = dyn(0xECECEA, 0x222220)
    public static let borderHover = dyn(0xCFCFCA, 0x3A3A37)

    /// The one blue (`--color-accent`): focus, caret, attention counts, the
    /// "AI" tag, chart chrome — never chrome at rest.
    public static let accent = dyn(0x2F6BFF, 0x5D8BFF)
    public static let accentSoft = dyn(0x2F6BFF, 0x5D8BFF, alpha: 0.14)

    // Semantic (the only other colours the theme allows); they lift in dark.
    public static let success = dyn(0x16A34A, 0x4ADE80)
    public static let warning = dyn(0xD97706, 0xFBBF24)
    public static let danger = dyn(0xD64545, 0xF27070)

    // Spacing (rem→pt at 16pt base) and radius (css px): --radius-md is THE
    // panel radius, -sm for chips / inputs / nav rows, -lg for lifted sheets.
    public static let xs: CGFloat = 4, sm: CGFloat = 8, md: CGFloat = 16, lg: CGFloat = 24, xl: CGFloat = 32
    public static let radiusSm: CGFloat = 6, radiusMd: CGFloat = 8, radiusLg: CGFloat = 10

    /// Heading type — the OS serif at REGULAR weight (`--font-serif`, Charter
    /// first, which iOS ships). Never bold: a serif heading in this theme is
    /// always 400. Pair with `displayTracking` (`letter-spacing: -0.012em`).
    public static func display(_ size: CGFloat) -> Font {
        #if canImport(UIKit)
        if UIFont(name: "Charter", size: size) != nil { return .custom("Charter", size: size) }
        #endif
        return .system(size: size, weight: .regular, design: .serif)
    }

    /// The heading letter-spacing, in points, for a heading of `size`.
    public static func displayTracking(_ size: CGFloat) -> CGFloat { -0.012 * size }

    #if canImport(UIKit)
    /// UIKit nav-bar titles (which SwiftUI's `.navigationTitle` renders) wear
    /// the serif too: a large title is a heading (Charter, regular), an inline
    /// title is a small heading and stays system sans semibold, as on the Mac.
    /// Keeps the default background/blur. Call once at launch.
    public static func applyNavBarAppearance() {
        guard let large = UIFont(name: "Charter", size: 34) else { return }
        let std = UINavigationBarAppearance(); std.configureWithDefaultBackground()
        std.largeTitleTextAttributes[.font] = large
        std.largeTitleTextAttributes[.kern] = displayTracking(34)
        let edge = UINavigationBarAppearance(); edge.configureWithTransparentBackground()
        edge.largeTitleTextAttributes[.font] = large
        edge.largeTitleTextAttributes[.kern] = displayTracking(34)
        let proxy = UINavigationBar.appearance()
        proxy.standardAppearance = std
        proxy.compactAppearance = std
        proxy.scrollEdgeAppearance = edge
    }
    #endif

    public static func tone(_ name: String?) -> Color {
        switch name {
        case "success": return success
        case "warning": return warning
        case "danger": return danger
        default: return textSecondary
        }
    }
}

// MARK: Reusable styles

/// Card/panel: a white sheet on the ground with a hairline, the one panel
/// radius, no shadow at rest (the Mac pattern).
struct ThemedCard: ViewModifier {
    var padding: CGFloat = Theme.md
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.radiusMd).strokeBorder(Theme.border))
    }
}

/// Primary button: a PILL, inverted (ink fill, ground label) like the Mac;
/// a `tone` paints a semantic fill with white text.
struct ThemedButton: ButtonStyle {
    var tone: Color? = nil
    var prominent: Bool = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .padding(.horizontal, Theme.md).padding(.vertical, Theme.sm)
            .frame(maxWidth: prominent ? nil : nil)
            .background(tone ?? Theme.text)
            .foregroundStyle(tone == nil ? Theme.bg : Color.white)
            .clipShape(Capsule())
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

extension View {
    func themedCard(padding: CGFloat = Theme.md) -> some View { modifier(ThemedCard(padding: padding)) }

    /// A serif heading at `size`: Charter, regular, tracked like the Mac.
    func displayStyle(_ size: CGFloat) -> some View {
        self.font(Theme.display(size)).tracking(Theme.displayTracking(size)).foregroundStyle(Theme.text)
    }

    /// Uppercase, small, tracked, secondary — the Mac section eyebrow
    /// (`--text-xs`, 600, 0.06em).
    func sectionHeaderStyle() -> some View {
        self.font(.system(size: 11.5, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.7)
            .foregroundStyle(Theme.textSecondary)
    }

    /// Apply the theme to a screen root: monochrome tint + the ground.
    func themedRoot() -> some View {
        self.tint(Theme.text).background(Theme.bg)
    }
}
