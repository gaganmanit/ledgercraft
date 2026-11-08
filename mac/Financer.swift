import AppKit
import WebKit
import UniformTypeIdentifiers

final class FinancerApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var serverLog: FileHandle?
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var downloadFiles: [ObjectIdentifier: (temporary: URL, destination: URL)] = [:]
    private var quitting = false
    private var failureShown = false
    private let instance = UUID().uuidString
    /// Pages may use the local API only with this secret. A test harness may supply it through the environment.
    private let sessionToken = ProcessInfo.processInfo.environment["LEDGERCRAFT_TOKEN"] ?? UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    private var baseURL = URL(string: "http://127.0.0.1:4173")!
    private var home = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Ledgercraft", isDirectory: true)
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 0.7
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        if let flag = args.firstIndex(of: "--test-workstation") {
            // Keep a native launch test independent of the running desk, WebKit session and books.
            guard flag + 2 < args.count, let port = Int(args[flag + 2]), (1024...65535).contains(port), port != 4173 else { exit(2) }
            let directory = URL(fileURLWithPath: args[flag + 1], isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
            let temp = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL
            guard directory.deletingLastPathComponent().path == temp.path,
                  directory.lastPathComponent.hasPrefix("ledgercraft-launch-"),
                  let files = try? FileManager.default.contentsOfDirectory(atPath: directory.path), files.isEmpty else { exit(2) }
            home = directory
            baseURL = URL(string: "http://127.0.0.1:\(port)")!
        }
        NSApp.setActivationPolicy(baseURL.port == 4173 ? .regular : .accessory)
        createMenu()
        createWindow()
        launchServer()
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        if baseURL.port != 4173 { configuration.websiteDataStore = .nonPersistent() }
        configuration.applicationNameForUserAgent = "FinancerDesktop/1.0"
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.userContentController.add(self, name: "financerPrint")
        configuration.userContentController.addUserScript(WKUserScript(source: """
            window.print = () => window.webkit.messageHandlers.financerPrint.postMessage(null);
            document.addEventListener('DOMContentLoaded', () => document.documentElement.dataset.financerNative = 'true');
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 850),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Ledgercraft"
        window.minSize = NSSize(width: 860, height: 620)
        window.backgroundColor = NSColor(calibratedRed: 0.902, green: 0.910, blue: 0.902, alpha: 1)
        window.contentView = webView
        window.setFrameAutosaveName("LedgercraftMainWindow")
        if !window.setFrameUsingName("LedgercraftMainWindow") { window.center() }
        if baseURL.port == 4173 {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        showLoading()
    }

    private func showLoading() {
        let html = """
            <!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
            <body style="margin:0;background:#e6e8e6;color:#1c1f22;display:grid;place-content:center;height:100vh;font-family:-apple-system,system-ui,sans-serif;text-align:center">
            <h1 style="font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0 0 10px">Ledgercraft</h1>
            <p style="font-size:15px;color:#4f565c;margin:0">Opening your books…</p></body></html>
            """
        webView.loadHTMLString(html, baseURL: nil)
        if baseURL.port != 4173 {
            // Only the explicit isolated launch test records native UI state.
            let menu = NSApp.mainMenu?.items.first?.submenu
            let branding: [String: Any] = ["windowTitle": window.title,
                "applicationMenu": menu?.title ?? "", "applicationMenuItems": menu?.items.map(\.title) ?? [],
                "startupHTML": html, "frameAutosaveName": window.frameAutosaveName]
            if let data = try? JSONSerialization.data(withJSONObject: branding, options: [.sortedKeys]) {
                try? data.write(to: home.appendingPathComponent("native-branding.json"), options: .atomic)
            }
        }
    }

    private func launchServer() {
        guard server == nil else { return }
        do {
            try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
            let logURL = home.appendingPathComponent("desktop.log")
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            serverLog = try FileHandle(forWritingTo: logURL)
            try serverLog?.seekToEnd()
            guard let resources = Bundle.main.resourceURL else {
                throw NSError(domain: "Financer", code: 1, userInfo: [NSLocalizedDescriptionKey: "The app resources are missing."])
            }
            let directory = Bundle.main.object(forInfoDictionaryKey: "FinancerBookResources") as? String ?? "app"
            let books = resources.appendingPathComponent(directory, isDirectory: true)
            let child = Process()
            let runtime = Bundle.main.object(forInfoDictionaryKey: "FinancerRuntimeResources") as? String ?? "runtime"
            child.executableURL = resources.appendingPathComponent(runtime, isDirectory: true).appendingPathComponent("node")
            child.currentDirectoryURL = books
            child.arguments = [books.appendingPathComponent("server.js").path]
            var environment = ProcessInfo.processInfo.environment
            environment["PORT"] = String(baseURL.port!)
            environment["FINANCER_HOME"] = home.path
            environment["FINANCER_DESKTOP"] = "1"
            environment["FINANCER_INSTANCE"] = instance
            environment["LEDGERCRAFT_TOKEN"] = sessionToken
            environment["FINANCER_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
            environment["NODE_OPTIONS"] = nil
            environment["NODE_ENV"] = "production"
            environment["DO_NOT_TRACK"] = "1"
            child.environment = environment
            child.standardOutput = serverLog
            child.standardError = serverLog
            child.terminationHandler = { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.server = nil
                    if self.quitting {
                        NSApp.reply(toApplicationShouldTerminate: true)
                    } else {
                        self.showFailure("The local books service stopped. Your saved books are in Application Support/Ledgercraft.")
                    }
                }
            }
            server = child
            try child.run()
            checkReadiness(deadline: Date().addingTimeInterval(20))
        } catch {
            server = nil
            showFailure(error.localizedDescription)
        }
    }

    private func checkReadiness(deadline: Date) {
        guard !quitting, let child = server, child.isRunning else { return }
        let url = baseURL.appendingPathComponent("api/health")
        session.dataTask(with: url) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting, self.server?.isRunning == true else { return }
                if let data = data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   json["app"] as? String == "financer",
                   json["instance"] as? String == self.instance {
                    var start = URLComponents(url: self.baseURL, resolvingAgainstBaseURL: false)!
                    start.path = "/"
                    start.queryItems = [URLQueryItem(name: "token", value: self.sessionToken)]
                    self.webView.load(URLRequest(url: start.url!))
                    return
                }
                if let response = response as? HTTPURLResponse, response.statusCode < 500 {
                    self.showFailure("Port 4173 is already in use by another local service. Close that service, then reopen Ledgercraft.")
                    self.stopServer()
                    return
                }
                if Date() >= deadline {
                    self.showFailure("The local books service could not start. Open the data folder to inspect desktop.log, then reopen Ledgercraft.")
                    self.stopServer()
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.checkReadiness(deadline: deadline) }
            }
        }.resume()
    }

    private func showFailure(_ message: String) {
        guard !quitting, !failureShown else { return }
        failureShown = true
        let alert = NSAlert()
        alert.messageText = "Ledgercraft could not open the books"
        alert.informativeText = message
        alert.addButton(withTitle: "Open Data Folder")
        alert.addButton(withTitle: "Close")
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn { self?.showDataFolder(nil) }
        }
    }

    private func stopServer() {
        if let child = server, child.isRunning { child.terminate() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let child = server, child.isRunning else { return .terminateNow }
        quitting = true
        child.terminate()
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        session.invalidateAndCancel()
        try? serverLog?.close()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    private func createMenu() {
        let main = NSMenu()
        let applicationMenu = NSMenu(title: "Ledgercraft")
        applicationMenu.addItem(withTitle: "About Ledgercraft", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "Hide Ledgercraft", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        applicationMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        applicationMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "Quit Ledgercraft", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        addMenu(applicationMenu, to: main)

        let file = NSMenu(title: "File")
        let entries: [(String, Selector, String)] = [
            ("New Voucher", #selector(newVoucher(_:)), "n"),
            ("Company Books", #selector(companyBooks(_:)), "o"),
            ("Print…", #selector(printBook(_:)), "p"),
            ("Open Data Folder", #selector(showDataFolder(_:)), "")
        ]
        for (title, action, key) in entries { file.addItem(withTitle: title, action: action, keyEquivalent: key).target = self }
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        addMenu(file, to: main)

        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        edit.addItem(.separator())
        edit.addItem(withTitle: "Find in Book", action: #selector(findInBook(_:)), keyEquivalent: "f").target = self
        addMenu(edit, to: main)

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload Book", action: #selector(reloadBook(_:)), keyEquivalent: "r").target = self
        view.addItem(withTitle: "Back", action: #selector(goBack(_:)), keyEquivalent: "[").target = self
        view.addItem(withTitle: "Forward", action: #selector(goForward(_:)), keyEquivalent: "]").target = self
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        addMenu(view, to: main)
        NSApp.mainMenu = main
    }

    private func addMenu(_ menu: NSMenu, to main: NSMenu) {
        let item = NSMenuItem()
        item.submenu = menu
        main.addItem(item)
    }

    @objc private func newVoucher(_ sender: Any?) {
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('financer-new-voucher'))", completionHandler: nil)
    }
    @objc private func companyBooks(_ sender: Any?) {
        webView.evaluateJavaScript("window.location.hash = '#/'", completionHandler: nil)
    }
    @objc private func findInBook(_ sender: Any?) {
        webView.evaluateJavaScript("document.querySelector('[data-find]')?.click()", completionHandler: nil)
    }
    @objc private func reloadBook(_ sender: Any?) { webView.reload() }
    @objc private func goBack(_ sender: Any?) { if webView.canGoBack { webView.goBack() } }
    @objc private func goForward(_ sender: Any?) { if webView.canGoForward { webView.goForward() } }
    @objc private func showDataFolder(_ sender: Any?) { NSWorkspace.shared.open(home) }
    @objc private func printBook(_ sender: Any?) {
        guard webView.url?.host == "127.0.0.1" else { return }
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.isHorizontallyCentered = true
        info.horizontalPagination = .fit
        info.topMargin = 28
        info.bottomMargin = 28
        info.leftMargin = 24
        info.rightMargin = 24
        let operation = webView.printOperation(with: info)
        operation.jobTitle = "Ledgercraft"
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        operation.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "financerPrint", message.frameInfo.isMainFrame { printBook(nil) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if url.host == "127.0.0.1", url.port == baseURL.port { decisionHandler(.allow); return }
        if url.scheme == "about" { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated, ["https", "http", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.title = "Save Ledgercraft document"
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
            .replacingOccurrences(of: "-financer.json", with: "-ledgercraft.json", options: [.caseInsensitive, .anchored, .backwards])
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in
            let key = ObjectIdentifier(download)
            guard result == .OK, let destination = panel.url else {
                self.downloads.removeValue(forKey: key)
                completionHandler(nil)
                return
            }
            let temporary = destination.deletingLastPathComponent()
                .appendingPathComponent(".financer-download-\(UUID().uuidString).tmp")
            self.downloadFiles[key] = (temporary, destination)
            completionHandler(temporary)
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download)
        downloads.removeValue(forKey: key)
        guard let files = downloadFiles.removeValue(forKey: key) else { return }
        do {
            if FileManager.default.fileExists(atPath: files.destination.path) {
                _ = try FileManager.default.replaceItemAt(files.destination, withItemAt: files.temporary)
            } else {
                try FileManager.default.moveItem(at: files.temporary, to: files.destination)
            }
        } catch {
            try? FileManager.default.removeItem(at: files.temporary)
            showDownloadFailure(error)
        }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download)
        downloads.removeValue(forKey: key)
        if let files = downloadFiles.removeValue(forKey: key) {
            try? FileManager.default.removeItem(at: files.temporary)
        }
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        showDownloadFailure(error)
    }
    private func showDownloadFailure(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Ledgercraft could not save the file"
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Ledgercraft"
        alert.informativeText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Ledgercraft"
        alert.informativeText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { result in completionHandler(result == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Ledgercraft"
        alert.informativeText = prompt
        let input = NSTextField(string: defaultText ?? "")
        input.frame = NSRect(x: 0, y: 0, width: 340, height: 24)
        alert.accessoryView = input
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = input
        alert.beginSheetModal(for: window) { result in completionHandler(result == .alertFirstButtonReturn ? input.stringValue : nil) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

let application = NSApplication.shared
let delegate = FinancerApp()
application.delegate = delegate
application.run()
