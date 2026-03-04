import Cocoa
import WebKit

// MARK: - Config

let serverPort = 3200
let serverURL = "http://localhost:\(serverPort)"

// Resolve project root (where package.json lives)
func projectRoot() -> String {
    let execPath = ProcessInfo.processInfo.arguments[0]
    let execURL = URL(fileURLWithPath: execPath)

    if execURL.pathComponents.contains("Contents") {
        var url = execURL
        while url.lastPathComponent != "Contents" { url.deleteLastPathComponent() }
        url.deleteLastPathComponent()

        let resourcesProject = url.appendingPathComponent("Contents/Resources/project")
        if FileManager.default.fileExists(atPath: resourcesProject.appendingPathComponent("package.json").path) {
            return resourcesProject.path
        }

        let appDir = url.deletingLastPathComponent()
        if FileManager.default.fileExists(atPath: appDir.appendingPathComponent("package.json").path) {
            return appDir.path
        }
    }

    var dir = execURL.deletingLastPathComponent()
    for _ in 0..<5 {
        if FileManager.default.fileExists(atPath: dir.appendingPathComponent("package.json").path) {
            return dir.path
        }
        dir.deleteLastPathComponent()
    }

    return FileManager.default.currentDirectoryPath
}

// MARK: - Color Helpers

func parseHexColor(_ hex: String) -> NSColor? {
    var h = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if h.hasPrefix("#") { h = String(h.dropFirst()) }
    guard h.count == 6 else { return nil }
    var rgb: UInt64 = 0
    Scanner(string: h).scanHexInt64(&rgb)
    return NSColor(
        red: CGFloat((rgb >> 16) & 0xFF) / 255,
        green: CGFloat((rgb >> 8) & 0xFF) / 255,
        blue: CGFloat(rgb & 0xFF) / 255,
        alpha: 1
    )
}

// MARK: - Server Process

class ServerManager {
    var process: Process?
    let root: String

    init(root: String) {
        self.root = root
    }

    func start() {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["node", "dist/bin/swarmie.js"]
        proc.currentDirectoryURL = URL(fileURLWithPath: root)
        proc.environment = ProcessInfo.processInfo.environment
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            self.process = proc
        } catch {
            print("Failed to start server: \(error)")
        }
    }

    func stop() {
        guard let proc = process, proc.isRunning else { return }
        proc.terminate()
        proc.waitUntilExit()
        process = nil
    }

    func isPortOpen() -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        defer { close(sock) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(serverPort).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    func waitForReady(timeout: TimeInterval = 15, completion: @escaping (Bool) -> Void) {
        let start = Date()
        func check() {
            if isPortOpen() {
                completion(true)
                return
            }
            if Date().timeIntervalSince(start) > timeout {
                completion(false)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { check() }
        }
        check()
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: ServerManager!
    var ownsServer = false
    var colorSyncTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = projectRoot()
        server = ServerManager(root: root)

        let screenSize = NSScreen.main?.frame.size ?? NSSize(width: 1280, height: 800)
        let width: CGFloat = min(1400, screenSize.width * 0.85)
        let height: CGFloat = min(900, screenSize.height * 0.85)
        let rect = NSRect(x: 0, y: 0, width: width, height: height)

        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Swarmie"
        window.center()
        window.setFrameAutosaveName("SwarmieMainWindow")
        window.minSize = NSSize(width: 600, height: 400)

        // WebView config
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: rect, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView = webView

        webView.loadHTMLString(loadingHTML(), baseURL: nil)
        window.makeKeyAndOrderFront(nil)

        if server.isPortOpen() {
            loadApp()
        } else {
            ownsServer = true
            server.start()
            server.waitForReady { [weak self] success in
                if success {
                    self?.loadApp()
                } else {
                    self?.showError("Failed to start swarmie server.\nMake sure 'npm run build' has been run in:\n\(root)")
                }
            }
        }
    }

    func loadApp() {
        if let url = URL(string: serverURL) {
            webView.load(URLRequest(url: url))
        }
    }

    // Sync title bar color with web theme after page loads
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        startColorSync()
    }

    func startColorSync() {
        // Poll every 1s for theme color changes
        colorSyncTimer?.invalidate()
        syncTitleBarColor()
        colorSyncTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.syncTitleBarColor()
        }
    }

    func syncTitleBarColor() {
        let js = "getComputedStyle(document.documentElement).getPropertyValue('--header-bg').trim()"
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            guard let hex = result as? String, !hex.isEmpty,
                  let color = parseHexColor(hex) else { return }
            DispatchQueue.main.async {
                self?.window.backgroundColor = color
            }
        }
    }

    func showError(_ message: String) {
        let escaped = message.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\n", with: "<br>")
            .replacingOccurrences(of: "'", with: "\\'")
        let html = """
        <html><body style="background:#0d1117;color:#f85149;font-family:-apple-system,monospace;
        display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;
        font-size:14px;padding:40px">\(escaped)</body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func loadingHTML() -> String {
        return """
        <html><body style="background:#fdf6e3;color:#93a1a1;font-family:-apple-system,monospace;
        display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">
        <div><div style="font-size:32px;margin-bottom:16px">&#x1F41D;</div>
        <div style="font-size:14px">Starting swarmie...</div></div></body></html>
        """
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        colorSyncTimer?.invalidate()
        if ownsServer {
            server.stop()
        }
    }
}

// MARK: - Main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
