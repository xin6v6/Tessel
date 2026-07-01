import Cocoa
import WebKit

// ────────────────────────────────────────────────────────────────────────────
// TesselChat — macOS 悬浮聊天窗口
//
// 一个极薄的 Swift 壳子：
//   - NSPanel 悬浮窗（floating level），内嵌 WKWebView 加载 Tessel 的 /chat 页面
//   - 菜单栏图标，单击切换显隐
//   - 全局快捷键 Option+Space 呼出 / 隐藏
//   - 点击窗口外部自动隐藏（hidesOnDeactivate，类似 Spotlight）
//   - 跨 Space 跟随（canJoinAllSpaces）
//
// 所有聊天 UI 逻辑在 TypeScript/React 中维护，Swift 只负责原生窗口行为。
// ────────────────────────────────────────────────────────────────────────────

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var panel: NSPanel!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var loadingLabel: NSTextField!
    var titleBar: TitleBarView!

    // ── 应用启动 ──────────────────────────────────────────────────────────

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 从 Dock 隐藏（仅菜单栏图标）
        NSApp.setActivationPolicy(.accessory)

        setupStatusBar()
        setupPanel()
        loadChat()

        // 启动后自动显示窗口
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.showPanel()
        }
    }

    // ── 菜单栏图标 ────────────────────────────────────────────────────────

    func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(
            withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            // 绿色圆点 + 文字 "T"
            let container = NSView(frame: NSRect(x: 0, y: 0, width: 28, height: 22))

            let dot = NSView(frame: NSRect(x: 4, y: 7, width: 8, height: 8))
            dot.wantsLayer = true
            dot.layer?.cornerRadius = 4
            dot.layer?.backgroundColor = NSColor(
                red: 0.3, green: 0.9, blue: 0.5, alpha: 1.0).cgColor
            container.addSubview(dot)

            let label = NSTextField(labelWithString: "T")
            label.frame = NSRect(x: 15, y: 1, width: 12, height: 20)
            label.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
            label.textColor = NSColor(white: 0.9, alpha: 1.0)
            container.addSubview(label)

            // 手势识别器——处理点击
            let click = NSClickGestureRecognizer(
                target: self, action: #selector(togglePanel))
            container.addGestureRecognizer(click)

            button.addSubview(container)
            button.frame = NSRect(x: 0, y: 0, width: 28, height: 22)
        }
    }

    // ── 悬浮面板 ──────────────────────────────────────────────────────────

    func setupPanel() {
        // 初始大小 420×650（多 44px 给原生标题栏）
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 650),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)

        panel.delegate = self

        // ── 关键属性 ──
        panel.level = .floating
        panel.hidesOnDeactivate = true
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
        ]
        // 隐藏系统标题栏，用自定义的
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isOpaque = false
        panel.backgroundColor = NSColor(
            red: 0.043, green: 0.055, blue: 0.086, alpha: 0.97) // #0b0e16

        // 隐藏最小化按钮（避免最小化后无法唤醒）
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        // 关闭按钮保留但改行为：点击关闭 → 隐藏窗口而非退出 app

        // 禁用「最小化」菜单项和快捷键
        panel.styleMask.remove(.miniaturizable)

        guard let contentView = panel.contentView else { return }

        // ── 自定义标题栏（可拖拽） ─────────────────────────────────────────

        titleBar = TitleBarView(frame: NSRect(x: 0, y: contentView.bounds.height - 40, width: contentView.bounds.width, height: 40))
        titleBar.autoresizingMask = [.width, .minYMargin]
        titleBar.wantsLayer = true
        titleBar.layer?.backgroundColor = NSColor(
            red: 0.043, green: 0.055, blue: 0.086, alpha: 0.95).cgColor

        // 标题文字
        let titleLabel = NSTextField(labelWithString: "Tessel Chat")
        titleLabel.frame = NSRect(x: 14, y: 10, width: 120, height: 20)
        titleLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        titleLabel.textColor = NSColor(white: 0.85, alpha: 1.0)
        titleBar.addSubview(titleLabel)

        // 关闭按钮（隐藏窗口）
        let closeBtn = NSButton(
            frame: NSRect(x: titleBar.bounds.width - 36, y: 10, width: 20, height: 20))
        closeBtn.autoresizingMask = [.minXMargin]
        closeBtn.bezelStyle = .inline
        closeBtn.isBordered = false
        closeBtn.title = ""
        closeBtn.image = NSImage(
            systemSymbolName: "xmark.circle.fill",
            accessibilityDescription: "关闭")
        closeBtn.contentTintColor = NSColor(white: 0.5, alpha: 1.0)
        closeBtn.target = self
        closeBtn.action = #selector(hidePanel)
        titleBar.addSubview(closeBtn)

        // 底部分隔线
        let sep = NSView(frame: NSRect(x: 0, y: 0, width: titleBar.bounds.width, height: 0.5))
        sep.autoresizingMask = [.width, .maxYMargin]
        sep.wantsLayer = true
        sep.layer?.backgroundColor = NSColor(white: 1.0, alpha: 0.08).cgColor
        titleBar.addSubview(sep)

        contentView.addSubview(titleBar)

        // ── WKWebView（标题栏下方） ────────────────────────────────────────

        let webFrame = NSRect(
            x: 0, y: 0,
            width: contentView.bounds.width,
            height: contentView.bounds.height - 40)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()

        webView = WKWebView(frame: webFrame, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        contentView.addSubview(webView)

        // ── 加载中提示 ────────────────────────────────────────────────────

        loadingLabel = NSTextField(labelWithString: "加载中…")
        loadingLabel.frame = NSRect(x: 0, y: 0, width: 200, height: 24)
        loadingLabel.alignment = .center
        loadingLabel.textColor = NSColor(white: 0.5, alpha: 1.0)
        loadingLabel.font = NSFont.systemFont(ofSize: 13)
        loadingLabel.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(loadingLabel)
        NSLayoutConstraint.activate([
            loadingLabel.centerXAnchor.constraint(
                equalTo: contentView.centerXAnchor),
            loadingLabel.centerYAnchor.constraint(
                equalTo: contentView.centerYAnchor, constant: -20),
        ])

        panel.center()
    }

    // ── 加载聊天页面 ──────────────────────────────────────────────────────

    func loadChat() {
        let port = ProcessInfo.processInfo.environment["TESSEL_PORT"]
            ?? "3456"
        guard let url = URL(string: "http://127.0.0.1:\(port)/chat") else {
            loadingLabel.stringValue = "无效的 URL"
            return
        }
        webView.load(URLRequest(
            url: url, cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 5))
        webView.navigationDelegate = self
    }

    // ── 显示面板 ──────────────────────────────────────────────────────────

    func showPanel() {
        // 如果最小化了，先恢复
        if panel.isMiniaturized {
            panel.deminiaturize(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript(
            "document.querySelector('textarea')?.focus()",
            completionHandler: nil)
    }

    // ── 隐藏面板 ──────────────────────────────────────────────────────────

    @objc func hidePanel() {
        panel.orderOut(nil)
    }

    // ── 切换显隐 ──────────────────────────────────────────────────────────

    @objc func togglePanel() {
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            showPanel()
        }
    }

    // ── NSWindowDelegate ─────────────────────────────────────────────────

    // 关闭按钮 → 隐藏而非退出
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        panel.orderOut(nil)
        return false  // 不真正关闭
    }

    // 禁止最小化
    func windowShouldMiniaturize(_ sender: NSWindow) -> Bool {
        panel.orderOut(nil)
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication)
        -> Bool
    {
        return false
    }
}

// ── 自定义标题栏 View（支持拖拽窗口） ────────────────────────────────────

class TitleBarView: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }

    override var mouseDownCanMoveWindow: Bool { true }
}

// ── WKWebView 导航回调 ──────────────────────────────────────────────────

extension AppDelegate: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingLabel.isHidden = true
    }

    func webView(
        _ webView: WKWebView, didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain
            && nsError.code == NSURLErrorCannotConnectToHost
        {
            loadingLabel.stringValue =
                "Tessel 服务未启动\n请先运行: tessel ui start"
        } else {
            loadingLabel.stringValue =
                "加载失败: \(error.localizedDescription)"
        }
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        loadingLabel.isHidden = false
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain
            && nsError.code == NSURLErrorCannotConnectToHost
        {
            loadingLabel.stringValue =
                "Tessel 服务未启动\n请先运行: tessel ui start"
        } else {
            loadingLabel.stringValue =
                "连接失败: \(error.localizedDescription)"
        }
    }
}

// ── 入口 ──────────────────────────────────────────────────────────────────

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
