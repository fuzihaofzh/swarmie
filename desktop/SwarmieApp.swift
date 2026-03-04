import Cocoa
import WebKit

// MARK: - Config

let serverPort = 3200
let serverURL = "http://localhost:\(serverPort)"

// Resolve project root (where package.json lives)
func projectRoot() -> String {
    // 1. Check for bundled project inside app Resources (self-contained mode)
    if let resourcesPath = Bundle.main.resourcePath {
        let bundledProject = resourcesPath + "/project"
        if FileManager.default.fileExists(atPath: bundledProject + "/package.json") {
            NSLog("[swarmie] Using bundled project at: %@", bundledProject)
            return bundledProject
        }
    }

    // 2. Check the directory containing the .app bundle
    if let bundlePath = Bundle.main.bundlePath as NSString? {
        let appDir = bundlePath.deletingLastPathComponent
        if FileManager.default.fileExists(atPath: appDir + "/package.json") {
            NSLog("[swarmie] Using project next to app: %@", appDir)
            return appDir
        }
    }

    // 3. Walk up from executable
    let execPath = ProcessInfo.processInfo.arguments[0]
    var dir = URL(fileURLWithPath: execPath).deletingLastPathComponent()
    for _ in 0..<5 {
        if FileManager.default.fileExists(atPath: dir.appendingPathComponent("package.json").path) {
            NSLog("[swarmie] Using project at: %@", dir.path)
            return dir.path
        }
        dir.deleteLastPathComponent()
    }

    let cwd = FileManager.default.currentDirectoryPath
    NSLog("[swarmie] Fallback to cwd: %@", cwd)
    return cwd
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

    func findNode() -> String? {
        // 1. Check for bundled node inside the app
        let bundledNode = root + "/node/bin/node"
        if FileManager.default.isExecutableFile(atPath: bundledNode) {
            return bundledNode
        }

        // 2. Try nvm: find latest version
        let nvmBase = "\(NSHomeDirectory())/.nvm/versions/node"
        if FileManager.default.fileExists(atPath: nvmBase) {
            if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmBase)
                .sorted(by: >) {
                for v in versions {
                    let nodePath = "\(nvmBase)/\(v)/bin/node"
                    if FileManager.default.isExecutableFile(atPath: nodePath) {
                        return nodePath
                    }
                }
            }
        }

        // Try fixed paths
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }

        // Fallback: try login shell "which node"
        let userShell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        for sh in [userShell, "/bin/zsh"] {
            guard FileManager.default.isExecutableFile(atPath: sh) else { continue }
            let whichProc = Process()
            whichProc.executableURL = URL(fileURLWithPath: sh)
            whichProc.arguments = ["-lic", "which node"]
            let whichPipe = Pipe()
            whichProc.standardOutput = whichPipe
            whichProc.standardError = FileHandle.nullDevice
            do {
                try whichProc.run()
                whichProc.waitUntilExit()
                let data = whichPipe.fileHandleForReading.readDataToEndOfFile()
                if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) {
                    return path
                }
            } catch { continue }
        }

        return nil
    }

    // Get the full PATH from a login shell (Finder launches with minimal PATH)
    func loginShellPath() -> String? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let isFish = shell.hasSuffix("/fish")

        // Try user's shell first, then fallback to /bin/zsh
        let shellsToTry = isFish ? ["/bin/zsh", shell] : [shell, "/bin/zsh"]
        for sh in shellsToTry {
            guard FileManager.default.isExecutableFile(atPath: sh) else { continue }
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: sh)
            if sh.hasSuffix("/fish") {
                // fish uses spaces in PATH and different syntax
                proc.arguments = ["-lic", "string join : $PATH"]
            } else {
                // bash, zsh, etc. — interactive login shell to load .bashrc/.zshrc
                proc.arguments = ["-lic", "echo $PATH"]
            }
            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = FileHandle.nullDevice
            do {
                try proc.run()
                proc.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !path.isEmpty, path.contains("/") {
                    return path
                }
            } catch { continue }
        }
        return nil
    }

    func start() {
        guard let nodePath = findNode() else {
            NSLog("[swarmie-server] Cannot find node binary")
            return
        }
        NSLog("[swarmie-server] Using node at: %@", nodePath)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = ["dist/bin/swarmie.js"]
        proc.currentDirectoryURL = URL(fileURLWithPath: root)

        // Use login shell PATH so spawned tools (claude, codex, etc.) are found
        var env = ProcessInfo.processInfo.environment
        let nodeBinDir = (nodePath as NSString).deletingLastPathComponent
        let shellPath = loginShellPath() ?? env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = "\(nodeBinDir):\(shellPath)"
        proc.environment = env
        NSLog("[swarmie-server] PATH: %@", env["PATH"] ?? "")
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { handle in
            if let str = String(data: handle.availableData, encoding: .utf8), !str.isEmpty {
                NSLog("[swarmie-server] %@", str)
            }
        }

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

    @objc func reloadPage(_ sender: Any?) {
        webView.reload()
    }

    @objc func hardReloadPage(_ sender: Any?) {
        webView.reloadFromOrigin()
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

// MARK: - Menu Bar

func setupMainMenu() {
    let mainMenu = NSMenu()

    // App menu
    let appMenuItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Swarmie", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Hide Swarmie", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Quit Swarmie", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)

    // Edit menu (enables Cmd+C/V/X/A/Z)
    let editMenuItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editMenuItem.submenu = editMenu
    mainMenu.addItem(editMenuItem)

    // View menu
    let viewMenuItem = NSMenuItem()
    let viewMenu = NSMenu(title: "View")
    viewMenu.addItem(withTitle: "Reload", action: #selector(AppDelegate.reloadPage(_:)), keyEquivalent: "r")
    let hardReload = viewMenu.addItem(withTitle: "Hard Reload", action: #selector(AppDelegate.hardReloadPage(_:)), keyEquivalent: "r")
    hardReload.keyEquivalentModifierMask = [.command, .shift]
    viewMenuItem.submenu = viewMenu
    mainMenu.addItem(viewMenuItem)

    // Window menu
    let windowMenuItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowMenuItem.submenu = windowMenu
    mainMenu.addItem(windowMenuItem)

    NSApplication.shared.mainMenu = mainMenu
    NSApplication.shared.windowsMenu = windowMenu
}

// MARK: - Main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
setupMainMenu()
app.activate(ignoringOtherApps: true)
app.run()
