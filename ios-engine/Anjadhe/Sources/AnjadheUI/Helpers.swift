import SwiftUI
import AnjadheCore
#if canImport(UIKit)
import UIKit
#endif

/// Open a URL in the system browser (adds https:// if missing).
func openURL(_ s: String) {
    var u = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !u.isEmpty else { return }
    if !u.contains("://") { u = "https://" + u }
    #if canImport(UIKit)
    if let url = URL(string: u) { UIApplication.shared.open(url) }
    #endif
}

extension View {
    @ViewBuilder func inlineNavTitle() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
    /// Hide the navigation bar for this view (the Today root uses its greeting as
    /// the title, so an empty bar would just add chrome). Pushed editors show
    /// their own bar normally.
    @ViewBuilder func hiddenNavBar() -> some View {
        #if os(iOS)
        self.toolbar(.hidden, for: .navigationBar)
        #else
        self
        #endif
    }
}
