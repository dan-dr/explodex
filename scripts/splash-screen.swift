import AppKit

// Explodex launch splash — polls a status file, shows loader, dismisses on done.
// Status file: plain lines; "__DONE__" finishes; "__ERROR__<msg>" shows failure.

private final class KeyableWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

private enum Palette {
    static let bgTop = NSColor(red: 0.09, green: 0.09, blue: 0.11, alpha: 1)
    static let bgBottom = NSColor(red: 0.14, green: 0.09, blue: 0.07, alpha: 1)
    static let accent = NSColor(red: 1, green: 0.52, blue: 0.18, alpha: 1)
    static let accentSoft = NSColor(red: 1, green: 0.72, blue: 0.35, alpha: 1)
    static let text = NSColor(white: 0.9, alpha: 1)
    static let muted = NSColor(white: 0.58, alpha: 1)
    static let error = NSColor(red: 1, green: 0.42, blue: 0.38, alpha: 1)
}

final class SplashController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let statusPath: String
    private var window: NSWindow!
    private var cardView: NSView!
    private var statusLabel: NSTextField!
    private var hintLabel: NSTextField!
    private var iconView: NSImageView!
    private var progressFill: NSView!
    private var progressTrack: NSView!
    private var progressFillWidth: NSLayoutConstraint!
    private var spinner: NSProgressIndicator!
    private var lastStatus = ""
    private var pollTimer: Timer?
    private var finishing = false
    private var quitMonitor: Any?

    init(statusPath: String) {
        self.statusPath = statusPath
        super.init()
    }

    func run() {
        let app = NSApplication.shared
        app.delegate = self
        app.setActivationPolicy(.accessory)
        buildWindow()
        installQuitHandler()
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        app.activate(ignoringOtherApps: true)
        startPolling()
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {}

    private func installQuitHandler() {
        quitMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            if event.modifierFlags.contains(.command),
               event.charactersIgnoringModifiers?.lowercased() == "q" {
                self.quitNow()
                return nil
            }
            return event
        }
    }

    private func quitNow() {
        pollTimer?.invalidate()
        if let quitMonitor {
            NSEvent.removeMonitor(quitMonitor)
        }
        NSApp.terminate(nil)
    }

    private func buildWindow() {
        let size = NSSize(width: 460, height: 320)

        window = KeyableWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.center()
        window.delegate = self
        window.acceptsMouseMovedEvents = true

        let rootView = NSView(frame: NSRect(origin: .zero, size: size))
        rootView.wantsLayer = true

        cardView = NSView(frame: rootView.bounds)
        cardView.wantsLayer = true
        cardView.layer?.cornerRadius = 22
        cardView.layer?.masksToBounds = true
        cardView.layer?.borderWidth = 1
        cardView.layer?.borderColor = NSColor(white: 1, alpha: 0.08).cgColor

        let bg = CAGradientLayer()
        bg.frame = cardView.bounds
        bg.colors = [Palette.bgTop.cgColor, Palette.bgBottom.cgColor]
        bg.startPoint = CGPoint(x: 0.1, y: 1)
        bg.endPoint = CGPoint(x: 0.9, y: 0)
        cardView.layer?.insertSublayer(bg, at: 0)

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false

        iconView = NSImageView()
        iconView.image = appIcon()
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.widthAnchor.constraint(equalToConstant: 72).isActive = true
        iconView.heightAnchor.constraint(equalToConstant: 72).isActive = true

        let titleLabel = makeLabel(
            "Explodex",
            font: .systemFont(ofSize: 28, weight: .bold),
            color: Palette.accent,
            height: 34
        )

        let subtitle = makeLabel(
            "Codex + plugin runtime",
            font: .systemFont(ofSize: 13, weight: .medium),
            color: Palette.muted,
            height: 18
        )

        let progressWrap = NSView()
        progressWrap.translatesAutoresizingMaskIntoConstraints = false
        progressWrap.widthAnchor.constraint(equalToConstant: 280).isActive = true
        progressWrap.heightAnchor.constraint(equalToConstant: 6).isActive = true

        progressTrack = NSView(frame: .zero)
        progressTrack.wantsLayer = true
        progressTrack.layer?.backgroundColor = NSColor(white: 1, alpha: 0.08).cgColor
        progressTrack.layer?.cornerRadius = 3
        progressTrack.translatesAutoresizingMaskIntoConstraints = false
        progressWrap.addSubview(progressTrack)

        progressFill = NSView(frame: .zero)
        progressFill.wantsLayer = true
        progressFill.layer?.backgroundColor = Palette.accent.cgColor
        progressFill.layer?.cornerRadius = 3
        progressFill.translatesAutoresizingMaskIntoConstraints = false
        progressTrack.addSubview(progressFill)

        progressFillWidth = progressFill.widthAnchor.constraint(equalToConstant: 28)
        NSLayoutConstraint.activate([
            progressTrack.leadingAnchor.constraint(equalTo: progressWrap.leadingAnchor),
            progressTrack.trailingAnchor.constraint(equalTo: progressWrap.trailingAnchor),
            progressTrack.topAnchor.constraint(equalTo: progressWrap.topAnchor),
            progressTrack.bottomAnchor.constraint(equalTo: progressWrap.bottomAnchor),
            progressFill.leadingAnchor.constraint(equalTo: progressTrack.leadingAnchor),
            progressFill.topAnchor.constraint(equalTo: progressTrack.topAnchor),
            progressFill.bottomAnchor.constraint(equalTo: progressTrack.bottomAnchor),
            progressFillWidth,
        ])

        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.widthAnchor.constraint(equalToConstant: 24).isActive = true
        spinner.heightAnchor.constraint(equalToConstant: 24).isActive = true

        statusLabel = makeLabel(
            "Starting…",
            font: .systemFont(ofSize: 14, weight: .regular),
            color: Palette.text,
            height: 40
        )
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 2
        statusLabel.widthAnchor.constraint(equalToConstant: 360).isActive = true

        hintLabel = makeLabel(
            "Press ⌘Q to cancel",
            font: .systemFont(ofSize: 11, weight: .regular),
            color: Palette.muted,
            height: 16
        )

        stack.addArrangedSubview(iconView)
        stack.addArrangedSubview(titleLabel)
        stack.addArrangedSubview(subtitle)
        stack.setCustomSpacing(22, after: subtitle)
        stack.addArrangedSubview(progressWrap)
        stack.setCustomSpacing(16, after: progressWrap)
        stack.addArrangedSubview(spinner)
        stack.setCustomSpacing(10, after: spinner)
        stack.addArrangedSubview(statusLabel)
        stack.setCustomSpacing(6, after: statusLabel)
        stack.addArrangedSubview(hintLabel)

        cardView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 36),
            stack.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -36),
            stack.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 40),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: cardView.bottomAnchor, constant: -28),
        ])

        rootView.addSubview(cardView)
        window.contentView = rootView

        DispatchQueue.main.async { [weak self] in
            self?.cardView.layoutSubtreeIfNeeded()
            self?.spinner.startAnimation(nil)
            self?.updateProgress(for: "Starting…", animated: false)
        }
    }

    private func makeLabel(_ text: String, font: NSFont, color: NSColor, height: CGFloat) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = font
        field.textColor = color
        field.alignment = .center
        field.isBezeled = false
        field.drawsBackground = false
        field.isEditable = false
        field.translatesAutoresizingMaskIntoConstraints = false
        field.heightAnchor.constraint(equalToConstant: height).isActive = true
        return field
    }

    private func appIcon() -> NSImage? {
        if let bundleIcon = NSApp.applicationIconImage, bundleIcon.size.width > 0 {
            return bundleIcon
        }
        if let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let img = NSImage(contentsOf: url) {
            return img
        }
        return NSImage(size: NSSize(width: 72, height: 72), flipped: false) { rect in
            let path = NSBezierPath(ovalIn: rect.insetBy(dx: 4, dy: 4))
            Palette.accent.setFill()
            path.fill()
            return true
        }
    }

    private func progressFraction(for status: String) -> CGFloat {
        let s = status.lowercased()
        if s.contains("prepar") { return 0.12 }
        if s.contains("launch") { return 0.3 }
        if s.contains("waiting") || s.contains("debug port") { return 0.5 }
        if s.contains("inject") { return 0.72 }
        if s.contains("plugin") || s.contains("loading") { return 0.88 }
        if s.contains("ready") || s.contains("opening") { return 0.96 }
        return 0.18
    }

    private func updateProgress(for status: String, animated: Bool) {
        cardView.layoutSubtreeIfNeeded()
        let trackWidth = progressTrack.bounds.width
        guard trackWidth > 0 else { return }
        let target = max(20, trackWidth * progressFraction(for: status))
        progressFillWidth.constant = target
        guard animated else {
            progressTrack.layoutSubtreeIfNeeded()
            return
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.28
            ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            self.progressTrack.layoutSubtreeIfNeeded()
        }
    }

    private func startPolling() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.pollStatus()
        }
        RunLoop.current.add(pollTimer!, forMode: .common)
        pollStatus()
    }

    private func pollStatus() {
        guard !finishing else { return }
        guard let data = try? String(contentsOfFile: statusPath, encoding: .utf8) else { return }
        let status = data.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !status.isEmpty else { return }

        if status == "__DONE__" {
            finish()
            return
        }
        if status.hasPrefix("__ERROR__") {
            let msg = String(status.dropFirst("__ERROR__".count))
            showError(msg.isEmpty ? "Launch failed" : msg)
            return
        }
        guard status != lastStatus else { return }
        lastStatus = status
        statusLabel.stringValue = status
        updateProgress(for: status, animated: true)
    }

    private func showError(_ message: String) {
        finishing = true
        pollTimer?.invalidate()
        statusLabel.stringValue = message
        statusLabel.textColor = Palette.error
        hintLabel.stringValue = "Press ⌘Q to close"
        progressFill.layer?.backgroundColor = Palette.error.withAlphaComponent(0.7).cgColor
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        updateProgress(for: "error", animated: true)
        progressFillWidth.constant = progressTrack.bounds.width
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.closeApp()
        }
    }

    private func finish() {
        guard !finishing else { return }
        finishing = true
        pollTimer?.invalidate()

        statusLabel.stringValue = "Ready"
        hintLabel.isHidden = true
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        progressFill.layer?.backgroundColor = Palette.accentSoft.cgColor

        cardView.layoutSubtreeIfNeeded()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.2
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.progressFillWidth.constant = self.progressTrack.bounds.width
            self.progressTrack.layoutSubtreeIfNeeded()
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            self?.fadeOutAndClose()
        }
    }

    private func fadeOutAndClose() {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            self.window.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            self?.closeApp()
        }
    }

    private func closeApp() {
        pollTimer?.invalidate()
        if let quitMonitor {
            NSEvent.removeMonitor(quitMonitor)
        }
        NSApp.terminate(nil)
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("usage: splash-screen <status-file>\n", stderr)
    exit(2)
}

_ = NSApplication.shared
SplashController(statusPath: args[1]).run()