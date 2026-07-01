import Cocoa
import Foundation

// ────────────────────────────────────────────────────────────────────────────
// TesselPet — 桌面宠物（卡通小男孩 + 气泡对话）
//
// 架构：
//   - 全透明 NSWindow，常驻桌面，可拖拽
//   - BoyView：Canvas 绘制卡通男孩，帧动画（待机眨眼/思考/说话）
//   - 点击宠物 → BubblePanel 出现在宠物上方（再次点击或点气泡外关闭）
//   - HTTP POST /api/chat 与 Tessel agent 通信
// ────────────────────────────────────────────────────────────────────────────

// MARK: - Pet State
enum PetState { case idle, thinking, speaking }

// MARK: - Chat Message
struct ChatMessage {
    enum Role { case user, assistant }
    let role: Role
    var text: String
}

// MARK: - BoyView (原图高清宠物)
class BoyView: NSView {
    var petState: PetState = .idle { didSet { updateState() } }
    private var thinkDot = 0
    private var animTimer: Timer?
    private let imageView = NSImageView()
    private let thinkView = NSView()  // 思考圆点容器

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setupImageView()
        setupThinkDots()
        startAnimation()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func setupImageView() {
        // 从 bundle Resources 加载
        let img: NSImage?
        if let bundleURL = Bundle.main.url(forResource: "tessel_boy", withExtension: "png") {
            img = NSImage(contentsOf: bundleURL)
        } else {
            // 开发期备选：可执行文件旁边
            let devURL = URL(fileURLWithPath: CommandLine.arguments[0])
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Resources/tessel_boy.png")
            img = NSImage(contentsOf: devURL)
        }

        imageView.image = img
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.autoresizingMask = [.width, .height]
        imageView.frame = bounds
        // 关掉加载失败时的占位图标
        if #available(macOS 14.0, *) {
            imageView.symbolConfiguration = nil
        }
        addSubview(imageView)
    }

    override func layout() {
        super.layout()
        imageView.frame = bounds
    }

    private func setupThinkDots() {
        thinkView.translatesAutoresizingMaskIntoConstraints = false
        thinkView.isHidden = true
        addSubview(thinkView)
        NSLayoutConstraint.activate([
            thinkView.centerXAnchor.constraint(equalTo: centerXAnchor),
            thinkView.topAnchor.constraint(equalTo: topAnchor, constant: -24),
            thinkView.widthAnchor.constraint(equalToConstant: 48),
            thinkView.heightAnchor.constraint(equalToConstant: 16),
        ])
        for i in 0..<3 {
            let dot = NSView(frame: NSRect(x: CGFloat(i)*16+4, y: 4, width: 8, height: 8))
            dot.wantsLayer = true
            dot.layer?.cornerRadius = 4
            dot.layer?.backgroundColor = NSColor(white: 0.7, alpha: 0.6).cgColor
            thinkView.addSubview(dot)
        }
    }

    private func updateState() {
        thinkView.isHidden = petState != .thinking
    }

    private func startAnimation() {
        // 上下浮动
        let bob = CABasicAnimation(keyPath: "position.y")
        bob.fromValue = 0
        bob.toValue = 6
        bob.duration = 1.8
        bob.autoreverses = true
        bob.repeatCount = .infinity
        bob.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        bob.isAdditive = true
        wantsLayer = true
        layer?.add(bob, forKey: "bob")

        // 定时眨眼 + 思考圆点
        animTimer = Timer.scheduledTimer(withTimeInterval: 0.18, repeats: true) { [weak self] _ in
            guard let self else { return }

            // 思考圆点
            if self.petState == .thinking {
                self.thinkDot = (self.thinkDot + 1) % 3
                for (i, dot) in self.thinkView.subviews.enumerated() {
                    let active = i == self.thinkDot
                    dot.layer?.backgroundColor = active
                        ? NSColor(red: 0.35, green: 0.55, blue: 1.0, alpha: 1.0).cgColor
                        : NSColor(white: 0.65, alpha: 0.45).cgColor
                    dot.layer?.transform = active
                        ? CATransform3DMakeTranslation(0, -4, 0)
                        : CATransform3DIdentity
                }
            }

            // 眨眼：随机触发（idle/speaking 状态，约每4秒一次）
            if self.petState != .thinking {
                self.blinkCounter += 1
                if self.blinkCounter >= self.blinkInterval {
                    self.blinkCounter = 0
                    // 随机下次间隔 3~6 秒 (÷0.18 ≈ 17~33 帧)
                    self.blinkInterval = Int.random(in: 17...33)
                    self.performBlink()
                }
            }
        }
    }

    private var blinkCounter = 0
    private var blinkInterval = 22  // 首次约4秒后眨眼

    private func performBlink() {
        // 眨眼：在眼睛区域叠加一个与皮肤色相近的半透明层快速显隐
        // 眼睛在原图约 y=42%~56%（从顶部）, x=25%~75%
        // 在 view 坐标系中（y轴从底部），对应 y = (1-0.56)*h ~ (1-0.42)*h
        let vw = bounds.width
        let vh = bounds.height
        let eyeRect = CGRect(
            x: vw * 0.22,
            y: vh * 0.44,
            width: vw * 0.56,
            height: vh * 0.13
        )
        let eyeLid = CALayer()
        eyeLid.frame = eyeRect
        // 用深色（眉毛+眼睛区域整体闭合的颜色，接近皮肤粉色）
        eyeLid.backgroundColor = NSColor(red: 0.96, green: 0.78, blue: 0.68, alpha: 1.0).cgColor
        eyeLid.cornerRadius = 4
        eyeLid.opacity = 0
        wantsLayer = true
        layer?.addSublayer(eyeLid)

        // 快速出现再消失
        let anim = CAKeyframeAnimation(keyPath: "opacity")
        anim.values = [0.0, 1.0, 1.0, 0.0]
        anim.keyTimes = [0, 0.2, 0.6, 1.0]
        anim.duration = 0.12
        anim.isRemovedOnCompletion = true
        CATransaction.begin()
        CATransaction.setCompletionBlock { eyeLid.removeFromSuperlayer() }
        eyeLid.add(anim, forKey: "blink")
        CATransaction.commit()
    }

    override var acceptsFirstResponder: Bool { true }
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

// MARK: - BubblePanel (对话气泡弹窗)
class BubblePanel: NSWindow {
    let tableView   = NSTableView()
    let scrollView  = NSScrollView()
    let inputField  = NSTextField()
    let sendButton  = NSButton()
    var messages: [ChatMessage] = []
    weak var petDelegate: AppDelegate?

    // 标记是否正在收到回复（防止重复发送）
    var isStreaming = false

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 300, height: 360),
                   styleMask: [.borderless],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.maximumWindow)))
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isMovableByWindowBackground = false
        setupUI()
    }

    // NSWindow borderless 默认不接受 key，需要 override
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    private func setupUI() {
        guard let cv = contentView else { return }

        // 白色圆角背景
        let bg = NSView(frame: cv.bounds)
        bg.autoresizingMask = [.width, .height]
        bg.wantsLayer = true
        bg.layer?.backgroundColor = NSColor(red: 0.96, green: 0.98, blue: 1.0, alpha: 1.0).cgColor
        bg.layer?.cornerRadius = 20
        bg.layer?.masksToBounds = true
        // 蓝色边框
        bg.layer?.borderWidth = 2
        bg.layer?.borderColor = NSColor(red: 0.42, green: 0.68, blue: 1.0, alpha: 1.0).cgColor
        cv.addSubview(bg)

        // 顶部蓝色标题栏
        let titleBar = NSView(frame: NSRect(x: 0, y: cv.bounds.height - 44, width: cv.bounds.width, height: 44))
        titleBar.autoresizingMask = [.width, .minYMargin]
        titleBar.wantsLayer = true
        titleBar.layer?.backgroundColor = NSColor(red: 0.35, green: 0.62, blue: 1.0, alpha: 1.0).cgColor
        cv.addSubview(titleBar)

        // 标题文字
        let titleLabel = NSTextField(labelWithString: "✦ Tessel")
        titleLabel.font = NSFont.systemFont(ofSize: 13, weight: .bold)
        titleLabel.textColor = .white
        titleLabel.frame = NSRect(x: 0, y: cv.bounds.height - 38, width: cv.bounds.width, height: 28)
        titleLabel.autoresizingMask = [.width, .minYMargin]
        titleLabel.alignment = .center
        cv.addSubview(titleLabel)

        // 关闭按钮
        let closeBtn = NSButton(frame: NSRect(x: cv.bounds.width - 32, y: cv.bounds.height - 36, width: 24, height: 24))
        closeBtn.autoresizingMask = [.minXMargin, .minYMargin]
        closeBtn.bezelStyle = .inline
        closeBtn.isBordered = false
        closeBtn.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "关闭")
        closeBtn.contentTintColor = NSColor(white: 1.0, alpha: 0.85)
        closeBtn.target = self
        closeBtn.action = #selector(closeSelf)
        cv.addSubview(closeBtn)

        // 聊天历史
        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("msg"))
        col.width = 280
        tableView.addTableColumn(col)
        tableView.headerView = nil
        tableView.backgroundColor = .clear
        tableView.intercellSpacing = NSSize(width: 0, height: 8)
        tableView.dataSource = self
        tableView.delegate = self
        tableView.selectionHighlightStyle = .none
        tableView.usesAutomaticRowHeights = true

        scrollView.documentView = tableView
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.frame = NSRect(x: 0, y: 56, width: cv.bounds.width, height: cv.bounds.height - 100)
        scrollView.autoresizingMask = [.width, .height]
        cv.addSubview(scrollView)

        // 输入区背景
        let inputBg = NSView(frame: NSRect(x: 8, y: 8, width: cv.bounds.width - 16, height: 44))
        inputBg.autoresizingMask = [.width]
        inputBg.wantsLayer = true
        inputBg.layer?.backgroundColor = NSColor.white.cgColor
        inputBg.layer?.cornerRadius = 22
        inputBg.layer?.borderWidth = 1.5
        inputBg.layer?.borderColor = NSColor(red: 0.42, green: 0.68, blue: 1.0, alpha: 0.6).cgColor
        cv.addSubview(inputBg)

        // 输入框（无边框，嵌入圆角背景内）
        inputField.frame = NSRect(x: 16, y: 11, width: cv.bounds.width - 70, height: 28)
        inputField.autoresizingMask = [.width]
        inputField.placeholderString = "说点什么…"
        inputField.isBezeled = false
        inputField.drawsBackground = false
        inputField.font = NSFont.systemFont(ofSize: 13)
        inputField.textColor = NSColor(red: 0.1, green: 0.15, blue: 0.3, alpha: 1.0)
        inputField.target = self
        inputField.action = #selector(sendMessage)
        inputField.focusRingType = .none
        cv.addSubview(inputField)

        // 发送按钮（圆形蓝色）
        sendButton.frame = NSRect(x: cv.bounds.width - 48, y: 12, width: 36, height: 36)
        sendButton.autoresizingMask = [.minXMargin]
        sendButton.bezelStyle = .circular
        sendButton.title = "↑"
        sendButton.font = NSFont.systemFont(ofSize: 16, weight: .bold)
        sendButton.wantsLayer = true
        sendButton.layer?.backgroundColor = NSColor(red: 0.35, green: 0.62, blue: 1.0, alpha: 1.0).cgColor
        sendButton.layer?.cornerRadius = 18
        sendButton.contentTintColor = .white
        sendButton.isBordered = false
        sendButton.target = self
        sendButton.action = #selector(sendMessage)
        cv.addSubview(sendButton)
    }

    @objc func closeSelf() {
        petDelegate?.hideBubble()
    }

    @objc func sendMessage() {
        guard !isStreaming else { return }
        let text = inputField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputField.stringValue = ""
        inputField.isEnabled = false
        sendButton.isEnabled = false
        isStreaming = true

        messages.append(ChatMessage(role: .user, text: text))
        let assistantIdx = messages.count
        messages.append(ChatMessage(role: .assistant, text: ""))
        tableView.reloadData()
        scrollToBottom()

        petDelegate?.petView.petState = .thinking

        Task { await fetchReply(text: text, assistantIdx: assistantIdx) }
    }

    private func fetchReply(text: String, assistantIdx: Int) async {
        let port = ProcessInfo.processInfo.environment["TESSEL_PORT"] ?? "3456"
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/chat") else {
            await finish(assistantIdx: assistantIdx, text: "无效的服务地址")
            return
        }

        var req = URLRequest(url: url, timeoutInterval: 60)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let threadId = "pet-\(ProcessInfo.processInfo.processIdentifier)"
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["threadId": threadId, "message": text])

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let statusCode = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard statusCode == 200 else {
                await finish(assistantIdx: assistantIdx, text: "服务错误 \(statusCode)")
                return
            }

            // 服务端返回 {"reply": "...", "route": "..."}
            var replyText = ""
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let reply = json["reply"] as? String {
                replyText = reply
            } else {
                replyText = String(data: data, encoding: .utf8) ?? "无法解析响应"
            }
            await finish(assistantIdx: assistantIdx, text: replyText)
        } catch {
            await finish(assistantIdx: assistantIdx, text: "连接失败：\(error.localizedDescription)")
        }
    }

    private func finish(assistantIdx: Int, text: String) async {
        await MainActor.run {
            if assistantIdx < self.messages.count {
                self.messages[assistantIdx].text = text.isEmpty ? "（无回复）" : text
            }
            self.tableView.reloadData()
            self.scrollToBottom()
            self.inputField.isEnabled = true
            self.sendButton.isEnabled = true
            self.isStreaming = false
            self.petDelegate?.petView.petState = .speaking
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                self.petDelegate?.petView.petState = .idle
            }
            // 让输入框重新获得焦点
            self.makeFirstResponder(self.inputField)
        }
    }

    private func scrollToBottom() {
        guard messages.count > 0 else { return }
        tableView.scrollRowToVisible(messages.count - 1)
    }
}

// MARK: - TableView
extension BubblePanel: NSTableViewDataSource, NSTableViewDelegate {
    func numberOfRows(in tableView: NSTableView) -> Int { messages.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let msg = messages[row]
        let isUser = msg.role == .user
        let displayText = msg.text.isEmpty ? "…" : msg.text

        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false

        // 气泡背景
        let bubble = NSView()
        bubble.wantsLayer = true
        bubble.layer?.cornerRadius = 16
        bubble.layer?.masksToBounds = true
        bubble.layer?.backgroundColor = isUser
            ? NSColor(red: 0.35, green: 0.62, blue: 1.0, alpha: 1.0).cgColor
            : NSColor.white.cgColor
        if !isUser {
            bubble.layer?.borderWidth = 1.5
            bubble.layer?.borderColor = NSColor(red: 0.42, green: 0.68, blue: 1.0, alpha: 0.35).cgColor
        }
        bubble.translatesAutoresizingMaskIntoConstraints = false

        // 文字
        let label = NSTextField(wrappingLabelWithString: displayText)
        label.font = NSFont.systemFont(ofSize: 13.5)
        label.textColor = isUser ? .white : NSColor(red: 0.1, green: 0.18, blue: 0.38, alpha: 1.0)
        label.isBezeled = false
        label.drawsBackground = false
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        bubble.addSubview(label)
        container.addSubview(bubble)

        // 文字在气泡内留 padding
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 9),
            label.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -9),
            label.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -12),
        ])

        if isUser {
            NSLayoutConstraint.activate([
                bubble.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -10),
                bubble.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 55),
                bubble.topAnchor.constraint(equalTo: container.topAnchor, constant: 2),
                bubble.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -2),
            ])
        } else {
            NSLayoutConstraint.activate([
                bubble.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 10),
                bubble.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -55),
                bubble.topAnchor.constraint(equalTo: container.topAnchor, constant: 2),
                bubble.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -2),
            ])
        }
        return container
    }
}

// MARK: - AppDelegate
class AppDelegate: NSObject, NSApplicationDelegate {
    var petWindow: NSWindow!
    var petView: BoyView!
    var bubblePanel: BubblePanel!

    // 拖拽状态
    private var mouseDownScreenPt = NSPoint.zero
    private var windowOriginOnDown = NSPoint.zero
    private var didDrag = false
    // 防抖：记录上次 toggle 时间
    private var lastToggleTime: TimeInterval = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupPetWindow()
        setupBubblePanel()
        setupNotifications()
    }

    // ── 宠物窗口 ──────────────────────────────────────────────────────────

    private func setupPetWindow() {
        // 原图宽高比 1650:1954
        let petH: CGFloat = 140
        let petW: CGFloat = petH * 1650.0 / 1954.0  // ≈ 118
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1512, height: 982)
        let origin = NSPoint(x: screen.maxX - petW - 20, y: screen.minY + 20)

        petWindow = NSWindow(
            contentRect: NSRect(origin: origin, size: CGSize(width: petW, height: petH)),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false)
        petWindow.isOpaque = false
        petWindow.backgroundColor = .clear
        petWindow.hasShadow = false
        petWindow.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.maximumWindow)) - 1)
        petWindow.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        petWindow.ignoresMouseEvents = false
        petWindow.isMovable = false  // 我们手动处理移动

        petView = BoyView(frame: NSRect(x: 0, y: 0, width: petW, height: petH))
        petWindow.contentView = petView
        petWindow.orderFrontRegardless()

        // 用 global monitor 捕获鼠标事件（支持点击透明区域外）
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]) {
            [weak self] event in
            self?.handleMouse(event)
            return event
        }
        // global monitor 捕获点击其他地方（用于关闭气泡）
        NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            guard let self, self.bubblePanel.isVisible else { return }
            // 点击在气泡面板外且不在宠物上 → 关闭气泡
            let screenPt = NSEvent.mouseLocation
            if !self.bubblePanel.frame.contains(screenPt) && !self.petWindow.frame.contains(screenPt) {
                self.hideBubble()
            }
        }
    }

    private func handleMouse(_ event: NSEvent) {
        // 只处理宠物窗口上的事件
        let screenPt = NSEvent.mouseLocation

        switch event.type {
        case .leftMouseDown:
            if petWindow.frame.contains(screenPt) {
                mouseDownScreenPt = screenPt
                windowOriginOnDown = petWindow.frame.origin
                didDrag = false
            }
        case .leftMouseDragged:
            guard petWindow.frame.contains(mouseDownScreenPt) ||
                  (didDrag && hypot(screenPt.x - mouseDownScreenPt.x, screenPt.y - mouseDownScreenPt.y) > 0)
            else { return }
            let dx = screenPt.x - mouseDownScreenPt.x
            let dy = screenPt.y - mouseDownScreenPt.y
            if !didDrag && hypot(dx, dy) < 5 { return }
            didDrag = true
            petWindow.setFrameOrigin(NSPoint(x: windowOriginOnDown.x + dx, y: windowOriginOnDown.y + dy))
            // 拖拽时同步移动气泡
            if bubblePanel.isVisible { repositionBubble() }

        case .leftMouseUp:
            guard petWindow.frame.contains(mouseDownScreenPt) else { return }
            if !didDrag {
                // 防止 500ms 内重复触发（防止气泡关闭瞬间重新弹开）
                let now = Date().timeIntervalSince1970
                if now - lastToggleTime > 0.5 {
                    lastToggleTime = now
                    toggleBubble()
                }
            }
            didDrag = false
        default: break
        }
    }

    // ── 气泡面板 ──────────────────────────────────────────────────────────

    private func setupBubblePanel() {
        bubblePanel = BubblePanel()
        bubblePanel.petDelegate = self
    }

    func toggleBubble() {
        if bubblePanel.isVisible { hideBubble() } else { showBubble() }
    }

    private func showBubble() {
        repositionBubble()
        NSApp.activate(ignoringOtherApps: true)
        bubblePanel.makeKeyAndOrderFront(nil)
        bubblePanel.makeFirstResponder(bubblePanel.inputField)
    }

    func hideBubble() {
        lastToggleTime = Date().timeIntervalSince1970  // 防止关闭后立即重新打开
        bubblePanel.orderOut(nil)
    }

    private func repositionBubble() {
        let pf = petWindow.frame
        let bw: CGFloat = 300
        let bh: CGFloat = 360
        var bx = pf.midX - bw / 2
        var by = pf.maxY + 10

        if let screen = NSScreen.main?.visibleFrame {
            bx = max(screen.minX + 4, min(bx, screen.maxX - bw - 4))
            if by + bh > screen.maxY {
                by = pf.minY - bh - 10
            }
        }
        bubblePanel.setFrame(NSRect(x: bx, y: by, width: bw, height: bh), display: true)
    }

    // ── CLI 通知 ──────────────────────────────────────────────────────────

    private func setupNotifications() {
        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(handleShow),
            name: NSNotification.Name("com.tessel.chat.show"), object: nil)
        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(handleHide),
            name: NSNotification.Name("com.tessel.chat.hide"), object: nil)
    }

    @objc private func handleShow() { showBubble() }
    @objc private func handleHide() { hideBubble() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

// MARK: - Entry Point
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
