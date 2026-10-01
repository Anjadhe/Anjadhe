// Mac control helper — the native side of the assistant's mac_look / mac_act
// tools (docs/COWORK_AGENT.md C14; main half js/main/mac-control.js, renderer
// half js/agent/mac-tools.js).
//
// Long-running: main spawns it once and speaks JSON lines — one request
// object per stdin line ({id, cmd, ...}), one reply per stdout line with the
// same id. It keeps the latest snapshot's AXUIElements so a step can name an
// element by NUMBER without re-walking the tree.
//
// Why native: another app's buttons, fields and links are only reachable
// through the Accessibility API (AXUIElement), a window can only be captured
// unoccluded through ScreenCaptureKit, and real input needs CGEvent. None of
// it is reachable from JS, and AppleScript's System Events is minutes slower
// on a web page's tree.
//
// Commands:
//   status                      {accessibility, screenRecording}
//   request {what}              prompt for "accessibility" or "screen"
//   snapshot {app?, capture?, maxElements?, maxEdge?}
//                               the target app's front window: numbered
//                               elements (frames relative to the image frame,
//                               in points), menus, open apps, browser URL, and
//                               (capture) a JPEG of the window
//   act {kind, ...}             press {n, double?} · click {x, y, double?}
//                               (points, relative to the image frame) ·
//                               type {text, n?, clear?} · key {key, modifiers}
//                               · scroll {direction, n?} · menu {path[]} ·
//                               open {app?, url?}
//   elementAt {x, y}            the role + label under a point (image frame)
//   forget                      drop the remembered target
//
// Laws kept HERE (main re-validates the rest):
//   - Never nenva itself (the parent process's windows are skipped).
//   - Keys and text go only to the target app: it must be frontmost, and
//     the focused element must belong to it and must not be a secure field.
//   - A coordinate click lands only when the target's window is the topmost
//     window under that point.

import Cocoa
import ApplicationServices
import ScreenCaptureKit

let ownerPid = getppid()
_ = NSApplication.shared   // a window-server connection for capture + events

// MARK: - Output

func reply(_ obj: [String: Any]) {
    var data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"error\":\"json encode failed\"}".utf8)
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

func clip(_ s: String, _ n: Int) -> String {
    let t = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return t.count > n ? String(t.prefix(n - 1)) + "…" : t
}

// MARK: - AX primitives

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func strAttr(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }
func boolAttr(_ el: AXUIElement, _ name: String) -> Bool? { (attr(el, name) as? NSNumber)?.boolValue }
func elAttr(_ el: AXUIElement, _ name: String) -> AXUIElement? {
    guard let v = attr(el, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}
func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
func frameOf(_ el: AXUIElement) -> CGRect? {
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &pt)
    AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return CGRect(origin: pt, size: sz)
}
func actions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success, let arr = names as? [String] else { return [] }
    return arr
}
func pidOf(_ el: AXUIElement) -> pid_t {
    var p: pid_t = 0
    AXUIElementGetPid(el, &p)
    return p
}
func focusedApplicationPid() -> pid_t? {
    let sys = AXUIElementCreateSystemWide()
    guard let app = elAttr(sys, kAXFocusedApplicationAttribute) else { return nil }
    return pidOf(app)
}
func focusedElement() -> AXUIElement? {
    elAttr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute)
}

// MARK: - Target app

func regularApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && $0.processIdentifier != ownerPid && !$0.isTerminated
    }
}

func resolveApp(_ name: String?) -> NSRunningApplication? {
    if let n = name?.trimmingCharacters(in: .whitespaces).lowercased(), !n.isEmpty {
        let apps = regularApps()
        return apps.first { ($0.localizedName ?? "").lowercased() == n || ($0.bundleIdentifier ?? "").lowercased() == n }
            ?? apps.first { ($0.localizedName ?? "").lowercased().hasPrefix(n) }
            ?? apps.first { ($0.localizedName ?? "").lowercased().contains(n) }
    }
    // No name: the app whose window is frontmost on screen, skipping nenva.
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list {
        guard (w[kCGWindowLayer as String] as? Int) == 0,
              let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != ownerPid,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat],
              (b["Width"] ?? 0) > 80, (b["Height"] ?? 0) > 80,
              let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular
        else { continue }
        return app
    }
    return nil
}

let CHROMIUM = ["com.google.Chrome", "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser",
                "com.vivaldi.Vivaldi", "com.operasoftware.Opera"]
var accessibilityEnabled = Set<pid_t>()

// Chromium and Electron apps build their accessibility tree only when asked.
func enableTree(_ app: NSRunningApplication, _ appEl: AXUIElement) -> Bool {
    let pid = app.processIdentifier
    if accessibilityEnabled.contains(pid) { return false }
    accessibilityEnabled.insert(pid)
    AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    if let b = app.bundleIdentifier, CHROMIUM.contains(where: { b.hasPrefix($0) }) {
        AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }
    return true
}

func frontWindow(_ appEl: AXUIElement) -> AXUIElement? {
    if let w = elAttr(appEl, kAXFocusedWindowAttribute) { return w }
    if let w = elAttr(appEl, kAXMainWindowAttribute) { return w }
    return ((attr(appEl, kAXWindowsAttribute) as? [AXUIElement]) ?? []).first
}

// Frontmost via the focused application (live), falling back to
// LaunchServices when the AX request is refused.
func activate(_ app: NSRunningApplication) -> Bool {
    let pid = app.processIdentifier
    if focusedApplicationPid() == pid { return true }
    let appEl = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(appEl, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if let w = frontWindow(appEl) { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
    for _ in 0..<12 { if focusedApplicationPid() == pid { return true }; usleep(50_000) }
    if let b = app.bundleIdentifier {
        _ = runOpen(["-b", b])
        for _ in 0..<30 { if focusedApplicationPid() == pid { return true }; usleep(50_000) }
    }
    return focusedApplicationPid() == pid
}

func runOpen(_ args: [String]) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = args
    let err = Pipe()
    p.standardError = err
    p.standardOutput = Pipe()
    do { try p.run() } catch { return (1, error.localizedDescription) }
    p.waitUntilExit()
    let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return (p.terminationStatus, msg)
}

// MARK: - Snapshot

struct Found {
    let el: AXUIElement
    let role: String
    let subrole: String
    let frame: CGRect
}

let TAKE_ROLES: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXComboBox", "AXCheckBox",
    "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor", "AXDisclosureTriangle",
    "AXRow", "AXColorWell", "AXDateField", "AXSearchField"]
let LEAF_ROLES: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXComboBox", "AXCheckBox",
    "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor", "AXRow", "AXDateField", "AXSearchField"]

func plainRole(_ role: String, _ subrole: String) -> String {
    switch role {
    case "AXButton": return "button"
    case "AXLink": return "link"
    case "AXTextField", "AXSearchField":
        if subrole == "AXSecureTextField" { return "password field" }
        return subrole == "AXSearchField" || role == "AXSearchField" ? "search field" : "text field"
    case "AXTextArea": return "text area"
    case "AXComboBox": return "combo box"
    case "AXCheckBox": return subrole == "AXSwitch" ? "switch" : "checkbox"
    case "AXRadioButton": return subrole == "AXTabButton" ? "tab" : "radio button"
    case "AXPopUpButton": return "pop-up menu"
    case "AXMenuButton": return "menu button"
    case "AXSlider": return "slider"
    case "AXIncrementor": return "stepper"
    case "AXDisclosureTriangle": return "disclosure"
    case "AXRow": return "row"
    case "AXDateField": return "date field"
    case "AXImage": return "image button"
    default: return "clickable"
    }
}

func textInside(_ el: AXUIElement, _ budget: inout Int, _ depth: Int) -> String {
    var parts: [String] = []
    for c in children(el) {
        if budget <= 0 || depth > 4 { break }
        budget -= 1
        let r = strAttr(c, kAXRoleAttribute) ?? ""
        if r == "AXStaticText", let v = strAttr(c, kAXValueAttribute), !v.isEmpty { parts.append(v) }
        else if let t = strAttr(c, kAXTitleAttribute), !t.isEmpty { parts.append(t) }
        else if let d = strAttr(c, kAXDescriptionAttribute), !d.isEmpty, r == "AXImage" { parts.append(d) }
        else {
            let s = textInside(c, &budget, depth + 1)
            if !s.isEmpty { parts.append(s) }
        }
        if parts.joined(separator: " ").count > 80 { break }
    }
    return parts.joined(separator: " ")
}

func labelOf(_ el: AXUIElement, _ role: String) -> String {
    for a in [kAXTitleAttribute, kAXDescriptionAttribute] {
        if let s = strAttr(el, a), !s.trimmingCharacters(in: .whitespaces).isEmpty { return clip(s, 60) }
    }
    if let t = elAttr(el, kAXTitleUIElementAttribute),
       let v = strAttr(t, kAXValueAttribute) ?? strAttr(t, kAXTitleAttribute), !v.isEmpty { return clip(v, 60) }
    let editable = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role)
    if !editable, let v = strAttr(el, kAXValueAttribute), !v.isEmpty { return clip(v, 60) }
    if let p = strAttr(el, "AXPlaceholderValue"), !p.isEmpty { return clip(p, 60) }
    if let h = strAttr(el, kAXHelpAttribute), !h.isEmpty { return clip(h, 60) }
    var budget = 30
    return clip(textInside(el, &budget, 0), 60)
}

func stateOf(_ el: AXUIElement, _ role: String, _ subrole: String) -> String {
    var s: [String] = []
    if boolAttr(el, kAXEnabledAttribute) == false { s.append("disabled") }
    if boolAttr(el, kAXFocusedAttribute) == true { s.append("focused") }
    if boolAttr(el, kAXSelectedAttribute) == true { s.append("selected") }
    if role == "AXCheckBox" || role == "AXRadioButton",
       let n = attr(el, kAXValueAttribute) as? NSNumber, n.intValue == 1 { s.append("checked") }
    if subrole == "AXSecureTextField" {
        s.append("password — never typed into")
    } else if ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) {
        if let v = strAttr(el, kAXValueAttribute), !v.isEmpty { s.append("value: \"\(clip(v, 40))\"") } else { s.append("empty") }
    }
    if boolAttr(el, kAXExpandedAttribute) == true { s.append("expanded") }
    return s.joined(separator: ", ")
}

// Snapshot state — the elements a later step names by number.
var snapApp: NSRunningApplication?
var snapElements: [Found] = []
var snapImageFrame = CGRect.zero
var snapWindowFrame = CGRect.zero

func walk(_ window: AXUIElement, _ wf: CGRect, _ limit: Int) -> (found: [Found], url: String?, truncated: Bool) {
    var out: [Found] = []
    var url: String?
    var visited = 0
    let deadline = Date().addingTimeInterval(3.0)
    var stack: [(AXUIElement, Int)] = [(window, 0)]
    var truncated = false
    while let (el, depth) = stack.popLast() {
        if visited >= 6000 || out.count >= limit || Date() > deadline { truncated = true; break }
        visited += 1
        let role = strAttr(el, kAXRoleAttribute) ?? ""
        if role == "AXMenuBar" || role == "AXMenu" { continue }
        let f = frameOf(el)
        if let f = f, f.width > 0, f.height > 0, !f.intersects(wf) { continue }
        if role == "AXWebArea", url == nil, let u = attr(el, "AXURL") {
            if let s = u as? String { url = s } else if let nu = u as? URL { url = nu.absoluteString }
        }
        let subrole = strAttr(el, kAXSubroleAttribute) ?? ""
        var take = TAKE_ROLES.contains(role)
        if !take, role == "AXGroup" || role == "AXImage",
           (strAttr(el, kAXTitleAttribute)?.isEmpty == false || strAttr(el, kAXDescriptionAttribute)?.isEmpty == false),
           actions(el).contains(kAXPressAction) {
            take = true
        }
        if take, let f = f {
            let vis = f.intersection(wf)
            if vis.width >= 3, vis.height >= 3 { out.append(Found(el: el, role: role, subrole: subrole, frame: vis)) }
        }
        if take && LEAF_ROLES.contains(role) { continue }
        if depth < 60 {
            for c in children(el).reversed() { stack.append((c, depth + 1)) }
        }
    }
    out.sort { a, b in
        let ra = Int(a.frame.minY / 10), rb = Int(b.frame.minY / 10)
        return ra != rb ? ra < rb : a.frame.minX < b.frame.minX
    }
    return (out, url, truncated)
}

extension CGRect { var area: CGFloat { isNull ? 0 : width * height } }

// The capture's result crosses from the async Task back to this thread in a
// class box: older compilers reject mutating a captured local `var` inside
// concurrently-executing code even in Swift 5 mode (release CI, alpha.78).
final class CaptureResult: @unchecked Sendable {
    var data: Data?
    var frame: CGRect = .zero
    var error: String? = "The capture did not finish."
}

func captureWindow(pid: pid_t, near wf: CGRect, maxEdge: CGFloat) -> (data: Data?, frame: CGRect, error: String?) {
    guard #available(macOS 14.0, *) else { return (nil, .zero, "Window capture needs macOS 14 or later.") }
    if !CGPreflightScreenCaptureAccess() { return (nil, .zero, "no-screen-recording") }
    let sem = DispatchSemaphore(value: 0)
    let box = CaptureResult()
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let mine = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 }
            guard let win = mine.max(by: { $0.frame.intersection(wf).area < $1.frame.intersection(wf).area }),
                  win.frame.intersects(wf) else {
                box.error = "The window could not be found for capture."
                sem.signal()
                return
            }
            let filter = SCContentFilter(desktopIndependentWindow: win)
            let cfg = SCStreamConfiguration()
            let px = CGFloat(filter.pointPixelScale)
            let fw = win.frame.width * px, fh = win.frame.height * px
            let k = min(1, maxEdge / max(fw, fh))
            cfg.width = max(1, Int(fw * k))
            cfg.height = max(1, Int(fh * k))
            cfg.showsCursor = false
            let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            let rep = NSBitmapImageRep(cgImage: img)
            box.data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
            box.frame = win.frame
            box.error = nil
        } catch {
            box.error = error.localizedDescription
        }
        sem.signal()
    }
    if sem.wait(timeout: .now() + 8) == .timedOut { return (nil, .zero, "The capture timed out.") }
    return (box.data, box.frame, box.data == nil ? (box.error ?? "The capture failed.") : nil)
}

func topMenus(_ appEl: AXUIElement) -> [String] {
    guard let bar = elAttr(appEl, kAXMenuBarAttribute) else { return [] }
    return children(bar).dropFirst().compactMap { strAttr($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
}

func snapshot(_ cmd: [String: Any]) -> [String: Any] {
    if !AXIsProcessTrusted() { return ["error": "no-accessibility"] }
    guard let app = resolveApp(cmd["app"] as? String) else {
        let named = (cmd["app"] as? String) ?? ""
        return ["error": named.isEmpty
            ? "No other app has a window open. Open one with action \"open\"."
            : "\"\(named)\" is not running. Open it with action \"open\" first.",
                "apps": regularApps().compactMap { $0.localizedName }]
    }
    let pid = app.processIdentifier
    let appEl = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(appEl, 1.0)
    if enableTree(app, appEl) { usleep(400_000) }
    guard let window = frontWindow(appEl), let wf = frameOf(window) else {
        return ["error": "\(app.localizedName ?? "That app") has no open window.", "app": app.localizedName ?? "",
                "bundleId": app.bundleIdentifier ?? "", "menus": topMenus(appEl)]
    }
    let limit = min(max((cmd["maxElements"] as? Int) ?? 150, 10), 300)
    let (found, url, truncated) = walk(window, wf, limit)

    var imageFrame = wf
    var out: [String: Any] = [
        "app": app.localizedName ?? "",
        "bundleId": app.bundleIdentifier ?? "",
        "pid": Int(pid),
        "windowTitle": clip(strAttr(window, kAXTitleAttribute) ?? "", 120),
        "menus": topMenus(appEl),
        "apps": regularApps().compactMap { $0.localizedName },
        "truncated": truncated
    ]
    if let url = url { out["url"] = url }
    if (cmd["capture"] as? Bool) == true {
        let maxEdge = CGFloat((cmd["maxEdge"] as? Double) ?? 1568)
        let cap = captureWindow(pid: pid, near: wf, maxEdge: maxEdge)
        if let data = cap.data {
            imageFrame = cap.frame
            out["image"] = [
                "dataUrl": "data:image/jpeg;base64," + data.base64EncodedString(),
                "pointWidth": Double(cap.frame.width),
                "pointHeight": Double(cap.frame.height)
            ]
        } else if let e = cap.error {
            out["imageError"] = e
        }
    }

    snapApp = app
    snapElements = found
    snapImageFrame = imageFrame
    snapWindowFrame = wf
    out["elements"] = found.enumerated().map { (i, f) -> [String: Any] in
        [
            "n": i + 1,
            "role": plainRole(f.role, f.subrole),
            "label": labelOf(f.el, f.role),
            "state": stateOf(f.el, f.role, f.subrole),
            "x": Double(f.frame.minX - imageFrame.minX), "y": Double(f.frame.minY - imageFrame.minY),
            "w": Double(f.frame.width), "h": Double(f.frame.height)
        ]
    }
    return out
}

// MARK: - Input

let KEYCODES: [String: CGKeyCode] = [
    "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
    "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
    "Left": 123, "Right": 124, "Down": 125, "Up": 126,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
    "n": 45, "m": 46
]

let eventSource = CGEventSource(stateID: .hidSystemState)

func postKey(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
    let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
    usleep(20_000)
}

func postClick(_ p: CGPoint, double: Bool) {
    CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    usleep(40_000)
    for i in 1...(double ? 2 : 1) {
        let d = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)
        d?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        d?.post(tap: .cghidEventTap)
        let u = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)
        u?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        u?.post(tap: .cghidEventTap)
        usleep(60_000)
    }
}

func typeString(_ text: String) {
    let lines = text.components(separatedBy: "\n")
    for (li, line) in lines.enumerated() {
        let units = Array(line.utf16)
        var i = 0
        while i < units.count {
            let chunk = Array(units[i..<min(i + 16, units.count)])
            chunk.withUnsafeBufferPointer { buf in
                let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true)
                down?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
                down?.post(tap: .cghidEventTap)
                let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false)
                up?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
                up?.post(tap: .cghidEventTap)
            }
            usleep(12_000)
            i += 16
        }
        if li < lines.count - 1 { postKey(36) }
    }
}

// Topmost on-screen window under a point (global coordinates).
func windowOwnerAt(_ p: CGPoint) -> pid_t? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list {
        guard let b = w[kCGWindowBounds as String] as? [String: CGFloat],
              let pid = w[kCGWindowOwnerPID as String] as? pid_t,
              (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.01 else { continue }
        let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        if r.contains(p) { return pid }
    }
    return nil
}

func element(_ n: Int?) -> (Found?, String?) {
    guard let n = n else { return (nil, nil) }
    guard n >= 1, n <= snapElements.count else {
        return (nil, "There is no element [\(n)] in the latest look — use a number from the most recent result.")
    }
    let f = snapElements[n - 1]
    guard strAttr(f.el, kAXRoleAttribute) != nil else {
        return (nil, "Element [\(n)] is gone — the window changed.")
    }
    return (f, nil)
}

func ensureTarget() -> (NSRunningApplication?, String?) {
    guard let app = snapApp, !app.isTerminated else { return (nil, "Look at the app with mac_look first.") }
    if !activate(app) { return (nil, "\(app.localizedName ?? "The app") could not be brought to the front.") }
    return (app, nil)
}

func focusOK(_ app: NSRunningApplication) -> String? {
    if focusedApplicationPid() != app.processIdentifier {
        return "\(app.localizedName ?? "The app") is not in front, so keys would go to another app."
    }
    if let el = focusedElement() {
        if pidOf(el) != app.processIdentifier { return "The focused field belongs to another app." }
        if strAttr(el, kAXSubroleAttribute) == "AXSecureTextField" {
            return "The focused field is a password field — never typed into. Ask the user to enter it."
        }
    }
    return nil
}

func center(_ r: CGRect) -> CGPoint { CGPoint(x: r.midX, y: r.midY) }

func act(_ cmd: [String: Any]) -> [String: Any] {
    if !AXIsProcessTrusted() { return ["error": "no-accessibility"] }
    let kind = cmd["kind"] as? String ?? ""

    if kind == "open" {
        let app = cmd["app"] as? String
        let url = cmd["url"] as? String
        var args: [String] = []
        if let app = app, !app.isEmpty { args += ["-a", app] }
        if let url = url, !url.isEmpty { args.append(url) }
        if args.isEmpty { return ["error": "open needs app or url."] }
        let (status, err) = runOpen(args)
        if status != 0 {
            return ["error": "Could not open \(app ?? url ?? ""): \(clip(err, 200))",
                    "apps": regularApps().compactMap { $0.localizedName }]
        }
        snapApp = nil
        snapElements = []
        return ["ok": true, "did": url != nil ? "Opened \(url!)\(app != nil ? " in \(app!)" : "")" : "Opened \(app!)"]
    }

    let (appOpt, terr) = ensureTarget()
    guard let app = appOpt else { return ["error": terr ?? "No target."] }
    let name = app.localizedName ?? "the app"
    let (found, eerr) = element(cmd["n"] as? Int)
    if let e = eerr { return ["error": e, "stale": true] }

    switch kind {
    case "press":
        guard let f = found else { return ["error": "press needs an element number."] }
        let double = (cmd["double"] as? Bool) == true
        let label = labelOf(f.el, f.role)
        let pressable = !double && f.role != "AXRow" && !["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(f.role)
            && actions(f.el).contains(kAXPressAction)
        if pressable, AXUIElementPerformAction(f.el, kAXPressAction as CFString) == .success {
            return ["ok": true, "did": "Pressed [\(cmd["n"]!)] \(plainRole(f.role, f.subrole)): \(label)"]
        }
        let live = frameOf(f.el).map { $0.intersection(snapWindowFrame) } ?? f.frame
        guard !live.isNull, live.width >= 2, live.height >= 2 else {
            return ["error": "Element [\(cmd["n"]!)] scrolled out of view.", "stale": true]
        }
        let p = center(live)
        if windowOwnerAt(p) != app.processIdentifier {
            return ["error": "Another window covers element [\(cmd["n"]!)] in \(name)."]
        }
        postClick(p, double: double)
        return ["ok": true, "did": "\(double ? "Double-clicked" : "Clicked") [\(cmd["n"]!)] \(plainRole(f.role, f.subrole)): \(label)"]

    case "click":
        guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { return ["error": "click needs x and y."] }
        let p = CGPoint(x: snapImageFrame.minX + CGFloat(x), y: snapImageFrame.minY + CGFloat(y))
        guard snapWindowFrame.contains(p) else { return ["error": "That point is outside \(name)'s window."] }
        if windowOwnerAt(p) != app.processIdentifier { return ["error": "Another window covers that point in \(name)."] }
        let double = (cmd["double"] as? Bool) == true
        postClick(p, double: double)
        return ["ok": true, "did": "\(double ? "Double-clicked" : "Clicked") at (\(Int(x)), \(Int(y))) in \(name)"]

    case "type":
        guard let text = cmd["text"] as? String, !text.isEmpty else { return ["error": "type needs text."] }
        if let f = found {
            if f.subrole == "AXSecureTextField" {
                return ["error": "That is a password field — never typed into. Ask the user to enter it."]
            }
            AXUIElementSetAttributeValue(f.el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            usleep(80_000)
            if boolAttr(f.el, kAXFocusedAttribute) != true, let fr = frameOf(f.el)?.intersection(snapWindowFrame), !fr.isNull {
                let p = center(fr)
                if windowOwnerAt(p) == app.processIdentifier { postClick(p, double: false); usleep(120_000) }
            }
        }
        if let e = focusOK(app) { return ["error": e] }
        if (cmd["clear"] as? Bool) == true { postKey(0, .maskCommand); usleep(60_000) }
        typeString(text)
        return ["ok": true, "did": "Typed \"\(clip(text, 60))\" in \(name)"]

    case "key":
        guard let key = cmd["key"] as? String, let code = KEYCODES[key] else { return ["error": "Unsupported key."] }
        if let e = focusOK(app) { return ["error": e] }
        var flags: CGEventFlags = []
        for m in (cmd["modifiers"] as? [String]) ?? [] {
            switch m {
            case "meta": flags.insert(.maskCommand)
            case "control": flags.insert(.maskControl)
            case "alt": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default: break
            }
        }
        postKey(code, flags)
        return ["ok": true, "did": "Pressed \(cmd["label"] as? String ?? key) in \(name)"]

    case "scroll":
        let down = (cmd["direction"] as? String) != "up"
        let area = found.flatMap { frameOf($0.el)?.intersection(snapWindowFrame) } ?? snapWindowFrame
        let p = center(area.isNull ? snapWindowFrame : area)
        if windowOwnerAt(p) != app.processIdentifier { return ["error": "Another window covers \(name) there."] }
        CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        usleep(40_000)
        let amount = Int32(max(120, min(area.height, snapWindowFrame.height) * 0.7))
        CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 1,
                wheel1: down ? -amount : amount, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
        return ["ok": true, "did": "Scrolled \(down ? "down" : "up") in \(name)"]

    case "menu":
        guard let path = cmd["path"] as? [String], !path.isEmpty else { return ["error": "menu needs a path like File > Export…"] }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        guard let bar = elAttr(appEl, kAXMenuBarAttribute) else { return ["error": "\(name) has no menu bar."] }
        let norm = { (s: String) -> String in
            s.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "")
                .trimmingCharacters(in: .whitespaces)
        }
        var current = bar
        for (i, seg) in path.enumerated() {
            var items = children(current)
            if let first = items.first, strAttr(first, kAXRoleAttribute) == "AXMenu" { items = children(first) }
            let want = norm(seg)
            guard let hit = items.first(where: { norm(strAttr($0, kAXTitleAttribute) ?? "") == want })
                    ?? items.first(where: { norm(strAttr($0, kAXTitleAttribute) ?? "").hasPrefix(want) }) else {
                let names = items.compactMap { strAttr($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
                return ["error": "\(name) has no menu item \"\(seg)\" there. Available: \(names.prefix(40).joined(separator: ", "))"]
            }
            if boolAttr(hit, kAXEnabledAttribute) == false { return ["error": "\"\(seg)\" is disabled right now."] }
            if i == path.count - 1 {
                if AXUIElementPerformAction(hit, kAXPressAction as CFString) != .success {
                    return ["error": "\(name) did not accept \"\(seg)\"."]
                }
            }
            current = hit
        }
        return ["ok": true, "did": "Chose \(path.joined(separator: " > ")) in \(name)"]

    default:
        return ["error": "Unknown step."]
    }
}

// MARK: - Loop

func handle(_ cmd: [String: Any]) -> [String: Any] {
    switch cmd["cmd"] as? String ?? "" {
    case "status":
        return ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
    case "request":
        if (cmd["what"] as? String) == "screen" {
            _ = CGRequestScreenCaptureAccess()
        } else {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        }
        return ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
    case "snapshot":
        return snapshot(cmd)
    case "act":
        return act(cmd)
    case "elementAt":
        // The label under a point (relative to the latest image frame), read
        // BEFORE a position click so its sensitivity can be checked.
        if !AXIsProcessTrusted() { return ["error": "no-accessibility"] }
        guard let x = cmd["x"] as? Double, let y = cmd["y"] as? Double else { return ["error": "bad point"] }
        let p = CGPoint(x: snapImageFrame.minX + CGFloat(x), y: snapImageFrame.minY + CGFloat(y))
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success,
              var cur = hit else { return ["label": ""] }
        for _ in 0..<6 {
            let role = strAttr(cur, kAXRoleAttribute) ?? ""
            let label = labelOf(cur, role)
            if TAKE_ROLES.contains(role) || !label.isEmpty {
                return ["role": plainRole(role, strAttr(cur, kAXSubroleAttribute) ?? ""), "label": label]
            }
            guard let parent = elAttr(cur, kAXParentAttribute) else { break }
            cur = parent
        }
        return ["label": ""]
    case "forget":
        snapApp = nil
        snapElements = []
        return ["ok": true]
    default:
        return ["error": "unknown command"]
    }
}

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            reply(["error": "bad request"])
            continue
        }
        var out = handle(cmd)
        out["id"] = cmd["id"] ?? NSNull()
        reply(out)
    }
    exit(0)
}
dispatchMain()
