import AppKit
import Foundation
import ServiceManagement

private enum HelperConfig {
	static let appName = "ATEM Edge Helper"
	static let relayURL = "wss://bt.bm.almiro.se/api/relay/socket"
	static let connectorName = "Truck A"
	static let stdoutLog = "atem-edge-helper.log"
	static let stderrLog = "atem-edge-helper.err.log"
}

private enum HelperState {
	case stopped
	case starting
	case running(pid: Int32)
	case error(String)

	var summary: String {
		switch self {
		case .stopped:
			return "Stopped"
		case .starting:
			return "Starting"
		case .running:
			return "Running"
		case .error(let message):
			return "Error: \(message)"
		}
	}
}

private struct HelperSettings: Codable {
	let relayURL: String
	let connectorName: String
}

private final class MenuInfoRowView: NSView {
	init(title: String, value: String) {
		super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 22))

		let titleField = NSTextField(labelWithString: title)
		titleField.font = NSFont.systemFont(ofSize: 12)
		titleField.textColor = .secondaryLabelColor
		titleField.translatesAutoresizingMaskIntoConstraints = false

		let valueField = NSTextField(labelWithString: value)
		valueField.font = NSFont.systemFont(ofSize: 12)
		valueField.textColor = .labelColor
		valueField.lineBreakMode = .byTruncatingMiddle
		valueField.alignment = .right
		valueField.translatesAutoresizingMaskIntoConstraints = false

		addSubview(titleField)
		addSubview(valueField)
		NSLayoutConstraint.activate([
			titleField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
			titleField.centerYAnchor.constraint(equalTo: centerYAnchor),
			valueField.leadingAnchor.constraint(greaterThanOrEqualTo: titleField.trailingAnchor, constant: 10),
			valueField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
			valueField.centerYAnchor.constraint(equalTo: centerYAnchor),
		])
	}

	required init?(coder: NSCoder) {
		nil
	}
}

private final class ColoredSwitchControl: NSControl {
	var isOn = false {
		didSet {
			needsDisplay = true
		}
	}
	var thumbTintColor = NSColor.white
	var onTintColor = NSColor.systemBlue
	var offTintColor = NSColor.quaternaryLabelColor
	var onChange: ((Bool) -> Void)?

	override var intrinsicContentSize: NSSize {
		NSSize(width: 42, height: 24)
	}

	override func draw(_ dirtyRect: NSRect) {
		super.draw(dirtyRect)

		let track = bounds.insetBy(dx: 1, dy: 1)
		let trackPath = NSBezierPath(roundedRect: track, xRadius: track.height / 2, yRadius: track.height / 2)
		(isOn ? onTintColor : offTintColor).setFill()
		trackPath.fill()

		let knobSize = track.height - 4
		let knobX = isOn ? track.maxX - knobSize - 2 : track.minX + 2
		let knobRect = NSRect(x: knobX, y: track.minY + 2, width: knobSize, height: knobSize)
		thumbTintColor.setFill()
		NSBezierPath(ovalIn: knobRect).fill()
	}

	override func mouseDown(with event: NSEvent) {
		guard isEnabled else {
			return
		}
		isOn.toggle()
		onChange?(isOn)
	}
}

private final class MenuSwitchRowView: NSView {
	init(title: String, isOn: Bool, isEnabled: Bool = true, onChange: @escaping (Bool) -> Void) {
		super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 34))

		let label = NSTextField(labelWithString: title)
		label.font = NSFont.systemFont(ofSize: 13, weight: .regular)
		label.textColor = isEnabled ? .labelColor : .disabledControlTextColor
		label.translatesAutoresizingMaskIntoConstraints = false

		let toggle = ColoredSwitchControl()
		toggle.translatesAutoresizingMaskIntoConstraints = false
		toggle.isOn = isOn
		toggle.isEnabled = isEnabled
		toggle.onTintColor = .systemBlue
		toggle.thumbTintColor = .white
		toggle.onChange = onChange

		addSubview(label)
		addSubview(toggle)
		NSLayoutConstraint.activate([
			label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
			label.centerYAnchor.constraint(equalTo: centerYAnchor),
			toggle.widthAnchor.constraint(equalToConstant: 42),
			toggle.heightAnchor.constraint(equalToConstant: 24),
			toggle.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
			toggle.centerYAnchor.constraint(equalTo: centerYAnchor),
		])
	}

	required init?(coder: NSCoder) {
		nil
	}
}

private final class LogWindowController: NSWindowController {
	private let textView: NSTextView
	private let logURLs: [URL]
	private var refreshTimer: Timer?

	init(logURLs: [URL]) {
		self.logURLs = logURLs
		let contentRect = NSRect(x: 0, y: 0, width: 800, height: 420)
		let scrollView = NSScrollView(frame: contentRect)
		scrollView.hasVerticalScroller = true
		scrollView.hasHorizontalScroller = true
		scrollView.autoresizingMask = [.width, .height]

		textView = NSTextView(frame: scrollView.contentView.bounds)
		textView.isEditable = false
		textView.isSelectable = true
		textView.isRichText = false
		textView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
		textView.textColor = .labelColor
		textView.backgroundColor = .textBackgroundColor
		textView.textContainerInset = NSSize(width: 12, height: 10)
		textView.minSize = NSSize(width: 0, height: scrollView.contentView.bounds.height)
		textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
		textView.isVerticallyResizable = true
		textView.isHorizontallyResizable = true
		textView.autoresizingMask = [.width, .height]
		textView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
		textView.textContainer?.widthTracksTextView = false
		scrollView.documentView = textView

		let window = NSWindow(
			contentRect: contentRect,
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false
		)
		window.title = "ATEM Edge Helper Log"
		window.contentView = scrollView
		window.center()

		super.init(window: window)
		refreshLog()
	}

	required init?(coder: NSCoder) {
		fatalError("init(coder:) has not been implemented")
	}

	override func showWindow(_ sender: Any?) {
		super.showWindow(sender)
		window?.makeKeyAndOrderFront(sender)
		NSApp.activate(ignoringOtherApps: true)
		refreshLog()
		startRefreshing()
	}

	override func close() {
		stopRefreshing()
		super.close()
	}

	private func startRefreshing() {
		refreshTimer?.invalidate()
		refreshTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
			self?.refreshLog()
		}
	}

	private func stopRefreshing() {
		refreshTimer?.invalidate()
		refreshTimer = nil
	}

	private func refreshLog() {
		let combined = logURLs.map { url in
			"== \(url.lastPathComponent) ==\n\(tailText(from: url, maxBytes: 64 * 1024))"
		}.joined(separator: "\n\n")
		textView.string = combined.isEmpty ? "No log output yet." : combined
		textView.scrollToEndOfDocument(nil)
	}

	private func tailText(from url: URL, maxBytes: UInt64) -> String {
		guard let handle = try? FileHandle(forReadingFrom: url) else {
			return "No log file yet."
		}
		defer {
			try? handle.close()
		}

		let size = (try? handle.seekToEnd()) ?? 0
		let offset = size > maxBytes ? size - maxBytes : 0
		try? handle.seek(toOffset: offset)
		let data = handle.readDataToEndOfFile()
		let text = String(data: data, encoding: .utf8) ?? ""
		if offset > 0 {
			return "... truncated ...\n" + text
		}
		return text.isEmpty ? "No log output yet." : text
	}
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
	private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
	private var helperProcess: Process?
	private var stdoutHandle: FileHandle?
	private var stderrHandle: FileHandle?
	private var state: HelperState = .stopped
	private var shouldKeepRunning = false
	private var isStopping = false
	private var repoRootURL: URL
	private var relayURL = HelperConfig.relayURL
	private var connectorName = HelperConfig.connectorName
	private lazy var logWindowController = LogWindowController(logURLs: logURLs())

	override init() {
		repoRootURL = AppDelegate.resolveRepoRoot()
		super.init()
		loadSettings()
	}

	func applicationDidFinishLaunching(_ notification: Notification) {
		NSApp.setActivationPolicy(.accessory)
		configureMainMenu()
		configureStatusItem()
		rebuildMenu()
		startHelper()
	}

	func applicationWillTerminate(_ notification: Notification) {
		stopHelper(restart: false)
	}

	private static func resolveRepoRoot() -> URL {
		if let explicit = ProcessInfo.processInfo.environment["ATEM_EDGE_REPO_ROOT"], !explicit.isEmpty {
			return URL(fileURLWithPath: explicit, isDirectory: true)
		}
		let bundleDir = Bundle.main.bundleURL.deletingLastPathComponent()
		return bundleDir.deletingLastPathComponent()
	}

	private func appSupportDirectory() -> URL {
		let url = FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent("Library", isDirectory: true)
			.appendingPathComponent("Application Support", isDirectory: true)
			.appendingPathComponent("atem-edge-helper", isDirectory: true)
		try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
		return url
	}

	private func settingsFileURL() -> URL {
		appSupportDirectory().appendingPathComponent("settings.json")
	}

	private func loadSettings() {
		guard
			let data = try? Data(contentsOf: settingsFileURL()),
			let saved = try? JSONDecoder().decode(HelperSettings.self, from: data)
		else {
			return
		}
		if !saved.relayURL.isEmpty {
			relayURL = saved.relayURL
		}
		if !saved.connectorName.isEmpty {
			connectorName = saved.connectorName
		}
	}

	private func saveSettings() {
		let saved = HelperSettings(relayURL: relayURL, connectorName: connectorName)
		guard let data = try? JSONEncoder().encode(saved) else {
			return
		}
		try? data.write(to: settingsFileURL(), options: .atomic)
	}

	private func configureStatusItem() {
		if let button = statusItem.button {
			button.image = statusIconImage(fillColor: statusIndicatorColor())
			button.title = button.image == nil ? "AE" : ""
			button.toolTip = HelperConfig.appName
		}
		updateStatusItemAppearance()
	}

	private func configureMainMenu() {
		let mainMenu = NSMenu()
		let appItem = NSMenuItem()
		let appMenu = NSMenu()
		appMenu.addItem(NSMenuItem(title: "Quit \(HelperConfig.appName)", action: #selector(quit), keyEquivalent: "q"))
		appItem.submenu = appMenu
		mainMenu.addItem(appItem)
		NSApp.mainMenu = mainMenu
	}

	private func rebuildMenu() {
		let menu = NSMenu()
		menu.addItem(loginSwitchItem())
		menu.addItem(NSMenuItem.separator())
		menu.addItem(helperSwitchItem())
		menu.addItem(NSMenuItem.separator())
		menu.addItem(disabledItem("Status: \(state.summary)"))
		menu.addItem(infoItem("Repo", repoRootURL.path))
		menu.addItem(infoItem("Relay URL", relayURL))
		menu.addItem(infoItem("Connector", connectorName))
		menu.addItem(actionItem("Set Relay URL...", #selector(setRelayURL)))
		menu.addItem(actionItem("Set Connector Name...", #selector(setConnectorName)))
		menu.addItem(actionItem("Show Log", #selector(showLog)))
		menu.addItem(NSMenuItem.separator())
		menu.addItem(actionItem("Quit", #selector(quit)))
		statusItem.menu = menu
		updateStatusItemAppearance()
	}

	private func disabledItem(_ title: String) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
		item.isEnabled = false
		return item
	}

	private func infoItem(_ title: String, _ value: String) -> NSMenuItem {
		let item = NSMenuItem()
		item.view = MenuInfoRowView(title: title, value: value)
		return item
	}

	private func actionItem(_ title: String, _ action: Selector) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
		item.target = self
		return item
	}

	private func helperSwitchItem() -> NSMenuItem {
		let item = NSMenuItem()
		let active = isHelperEnabled
		item.view = MenuSwitchRowView(title: "ATEM Edge", isOn: active) { [weak self] enabled in
			DispatchQueue.main.async {
				if enabled {
					self?.startHelper()
				} else {
					self?.stopHelper(restart: false)
				}
			}
		}
		return item
	}

	private func loginSwitchItem() -> NSMenuItem {
		let item = NSMenuItem()
		let active = isLoginItemEnabled
		let supported: Bool
		if #available(macOS 13.0, *) {
			supported = true
		} else {
			supported = false
		}
		item.view = MenuSwitchRowView(title: "Start on Login", isOn: active, isEnabled: supported) { [weak self] enabled in
			DispatchQueue.main.async {
				self?.setLoginItemEnabled(enabled)
			}
		}
		return item
	}

	private var isHelperEnabled: Bool {
		switch state {
		case .starting, .running:
			return true
		case .stopped, .error:
			return false
		}
	}

	private var isLoginItemEnabled: Bool {
		if #available(macOS 13.0, *) {
			return SMAppService.mainApp.status == .enabled
		}
		return false
	}

	private func updateStatusItemAppearance() {
		guard let button = statusItem.button else {
			return
		}
		button.toolTip = "\(HelperConfig.appName): \(state.summary)"
		button.image = statusIconImage(fillColor: statusIndicatorColor())
		button.contentTintColor = nil
	}

	private func statusIndicatorColor() -> NSColor {
		switch state {
		case .stopped:
			return .systemGray
		case .starting:
			return .systemOrange
		case .running:
			return .systemGreen
		case .error:
			return .systemRed
		}
	}

	private func statusIconImage(fillColor: NSColor) -> NSImage? {
		let symbolName = "dot.radiowaves.left.and.right"
		guard let symbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: HelperConfig.appName) else {
			return nil
		}
		let size = NSSize(width: 28, height: 22)
		let image = NSImage(size: size)
		image.lockFocus()
		fillColor.setFill()
		NSBezierPath(
			roundedRect: NSRect(x: 1, y: 2, width: size.width - 2, height: size.height - 4),
			xRadius: 6,
			yRadius: 6
		).fill()
		if let whiteSymbol = tintedSymbolImage(symbol, color: .white, size: NSSize(width: 15, height: 15)) {
			whiteSymbol.draw(in: NSRect(x: 6.5, y: 3.5, width: 15, height: 15))
		}
		image.unlockFocus()
		image.isTemplate = false
		return image
	}

	private func tintedSymbolImage(_ symbol: NSImage, color: NSColor, size: NSSize) -> NSImage? {
		let image = NSImage(size: size)
		image.lockFocus()
		let rect = NSRect(origin: .zero, size: size)
		symbol.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
		color.set()
		rect.fill(using: .sourceIn)
		image.unlockFocus()
		image.isTemplate = false
		return image
	}

	private func startHelper() {
		if helperProcess != nil {
			return
		}
		guard FileManager.default.fileExists(atPath: repoRootURL.path) else {
			setState(.error("repo root not found: \(repoRootURL.path)"))
			return
		}
		appendLog("starting atem edge helper")
		setState(.starting)
		shouldKeepRunning = true
		isStopping = false

		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
		process.arguments = [
			"npm",
			"run",
			"atem:edge-agent",
			"--",
			"--relay",
			relayURL,
			"--name",
			connectorName,
		]
		process.currentDirectoryURL = repoRootURL
		process.environment = processEnvironment()
		process.standardOutput = logHandle(named: HelperConfig.stdoutLog)
		process.standardError = logHandle(named: HelperConfig.stderrLog)
		process.terminationHandler = { [weak self] finishedProcess in
			DispatchQueue.main.async {
				self?.helperDidTerminate(finishedProcess)
			}
		}

		do {
			try process.run()
			helperProcess = process
			setState(.running(pid: process.processIdentifier))
			appendLog("started pid \(process.processIdentifier) relay=\(relayURL) connector=\(connectorName)")
		} catch {
			closeLogHandles()
			appendLog("failed to start: \(error.localizedDescription)")
			setState(.error(error.localizedDescription))
			scheduleRestartIfNeeded()
		}
	}

	private func stopHelper(restart: Bool) {
		shouldKeepRunning = restart
		isStopping = true
		appendLog(restart ? "restarting helper" : "stopping helper")
		guard let process = helperProcess else {
			setState(.stopped)
			return
		}
		process.terminate()
		DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
			if process.isRunning {
				process.interrupt()
			}
		}
	}

	private func helperDidTerminate(_ process: Process) {
		if helperProcess === process {
			helperProcess = nil
		}
		closeLogHandles()
		let exitDescription = "exited with status \(process.terminationStatus)"
		if isStopping && !shouldKeepRunning {
			isStopping = false
			appendLog("stopped (\(exitDescription))")
			setState(.stopped)
			return
		}
		appendLog("stopped unexpectedly (\(exitDescription))")
		setState(.error(exitDescription))
		scheduleRestartIfNeeded()
	}

	private func scheduleRestartIfNeeded() {
		guard shouldKeepRunning else {
			return
		}
		DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
			self?.startHelper()
		}
	}

	private func setState(_ newState: HelperState) {
		state = newState
		rebuildMenu()
	}

	private func processEnvironment() -> [String: String] {
		var environment = ProcessInfo.processInfo.environment
		environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
		return environment
	}

	private func logsDirectory() -> URL {
		let url = FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent("Library", isDirectory: true)
			.appendingPathComponent("Logs", isDirectory: true)
		try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
		return url
	}

	private func logURLs() -> [URL] {
		let directory = logsDirectory()
		return [
			directory.appendingPathComponent(HelperConfig.stderrLog),
			directory.appendingPathComponent(HelperConfig.stdoutLog),
		]
	}

	private func logHandle(named name: String) -> FileHandle? {
		do {
			let url = logsDirectory().appendingPathComponent(name)
			FileManager.default.createFile(atPath: url.path, contents: nil)
			let handle = try FileHandle(forWritingTo: url)
			try handle.seekToEnd()
			if name == HelperConfig.stdoutLog {
				stdoutHandle = handle
			} else {
				stderrHandle = handle
			}
			return handle
		} catch {
			return nil
		}
	}

	private func closeLogHandles() {
		try? stdoutHandle?.close()
		try? stderrHandle?.close()
		stdoutHandle = nil
		stderrHandle = nil
	}

	private func appendLog(_ message: String) {
		let line = "\(Self.logTimestamp()) \(message)\n"
		let url = logsDirectory().appendingPathComponent(HelperConfig.stderrLog)
		FileManager.default.createFile(atPath: url.path, contents: nil)
		guard let handle = try? FileHandle(forWritingTo: url) else {
			return
		}
		defer {
			try? handle.close()
		}
		do {
			try handle.seekToEnd()
			try handle.write(contentsOf: Data(line.utf8))
		} catch {
			return
		}
	}

	private static func logTimestamp() -> String {
		let formatter = DateFormatter()
		formatter.dateFormat = "yyyy/MM/dd HH:mm:ss"
		return formatter.string(from: Date())
	}

	private func setLoginItemEnabled(_ enabled: Bool) {
		if #available(macOS 13.0, *) {
			do {
				if enabled {
					try SMAppService.mainApp.register()
				} else {
					try SMAppService.mainApp.unregister()
				}
			} catch {
				setState(.error("login item: \(error.localizedDescription)"))
			}
		}
		rebuildMenu()
	}

	private func promptTextInput(
		title: String,
		message: String,
		initialValue: String,
		placeholder: String,
		onSave: @escaping (String) -> Void
	) {
		let alert = NSAlert()
		alert.messageText = title
		alert.informativeText = message
		alert.alertStyle = .informational
		alert.addButton(withTitle: "Save")
		alert.addButton(withTitle: "Cancel")

		let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
		input.stringValue = initialValue
		input.placeholderString = placeholder
		alert.accessoryView = input

		NSApp.activate(ignoringOtherApps: true)
		let response = alert.runModal()
		guard response == .alertFirstButtonReturn else {
			return
		}
		let value = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !value.isEmpty else {
			return
		}
		onSave(value)
	}

	@objc private func setRelayURL() {
		promptTextInput(
			title: "Relay URL",
			message: "WebSocket relay endpoint for ATEM edge connector.",
			initialValue: relayURL,
			placeholder: HelperConfig.relayURL
		) { [weak self] value in
			guard let self else { return }
			relayURL = value
			saveSettings()
			appendLog("relay url updated to \(value)")
			rebuildMenu()
			restartIfRunning()
		}
	}

	@objc private func setConnectorName() {
		promptTextInput(
			title: "Connector Name",
			message: "Displayed name for this ATEM edge connector.",
			initialValue: connectorName,
			placeholder: HelperConfig.connectorName
		) { [weak self] value in
			guard let self else { return }
			connectorName = value
			saveSettings()
			appendLog("connector name updated to \(value)")
			rebuildMenu()
			restartIfRunning()
		}
	}

	private func restartIfRunning() {
		if helperProcess != nil {
			stopHelper(restart: true)
		}
	}

	@objc private func showLog() {
		logWindowController.showWindow(nil)
	}

	@objc private func quit() {
		NSApp.terminate(nil)
	}
}

private let app = NSApplication.shared
private let delegate = AppDelegate()
app.delegate = delegate
app.run()
