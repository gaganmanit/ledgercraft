import AppKit
import WebKit
import PDFKit

struct Fixture {
    let base: String
    let company: String
    let party: String
    let item: String
    let output: URL
    init(_ file: String) throws {
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: file))) as! [String: String]
        base = json["base"]!
        company = json["company"]!
        party = json["party"]!
        item = json["item"]!
        output = URL(fileURLWithPath: json["output"]!)
    }
}
struct Failure: Error, CustomStringConvertible { let description: String }

@MainActor final class Runner: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let fixture: Fixture
    var window: NSWindow!
    var web: WKWebView!
    var started = false
    init(_ fixture: Fixture) { self.fixture = fixture }
    func applicationDidFinishLaunching(_ notification: Notification) {
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1360, height: 1024))
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Ledgercraft RCM — isolated public fixture"
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        web.load(URLRequest(url: URL(string: fixture.base)!))
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if started { return }
        started = true
        Task { do { try await exercise(); print("Native RCM UI exercise passed"); NSApp.terminate(nil) }
               catch { print("Native RCM UI exercise failed: \(error)"); exit(1) } }
    }
    func literal(_ value: String) -> String {
        let json = String(data: try! JSONSerialization.data(withJSONObject: [value]), encoding: .utf8)!
        return String(json.dropFirst().dropLast())
    }
    func js(_ source: String) async throws -> Any? { try await web.evaluateJavaScript(source) }
    func wait(_ condition: String, _ label: String, seconds: Double = 20) async throws {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if (try await js(condition) as? Bool) == true { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let text = (try? await js("document.body.innerText.slice(-1600)")) as? String ?? ""
        throw Failure(description: "Timed out waiting for \(label). \(text)")
    }
    func fill(_ selector: String, _ value: String) async throws {
        let result = try await js("(() => { const el=document.querySelector(\(literal(selector))); if(!el)return false; el.value=\(literal(value)); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()")
        if result as? Bool != true { throw Failure(description: "Missing field \(selector)") }
    }
    func check(_ selector: String) async throws {
        let result = try await js("(() => { const el=document.querySelector(\(literal(selector))); if(!el)return false; el.checked=true; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()")
        if result as? Bool != true { throw Failure(description: "Missing checkbox \(selector)") }
    }
    func click(_ selector: String) async throws {
        let result = try await js("(() => { const el=document.querySelector(\(literal(selector))); if(!el)return false; el.click(); return true; })()")
        if result as? Bool != true { throw Failure(description: "Missing control \(selector)") }
    }
    func navigate(_ section: String) async throws {
        _ = try await js("location.hash=\(literal("#/c/" + fixture.company + "/" + section))")
    }
    func workspace() async throws {
        try await navigate("gst-rcm?to=2026-04-30")
        try await wait("Boolean(document.querySelector('#rcm-action'))", "RCM workspace")
    }
    func action(_ name: String, date: String, reference: String, checks: [String] = [], fields: [String: String] = [:]) async throws {
        try await workspace()
        try await fill("#rcm-action [name=action]", name)
        try await fill("#rcm-action [name=date]", date)
        try await fill("#rcm-action [name=reference]", reference)
        for (key, value) in fields { try await fill("#rcm-action [name=\(key)]", value) }
        for key in checks { try await check("#rcm-action [name=\(key)]") }
        try await click("#rcm-action button[type=submit]")
        try await wait("location.hash.includes('/gst-rcm-document/') && Boolean(document.querySelector('.rcm-document'))", "\(name) record")
    }
    func capturePayment() async throws {
        _ = try await js("window.scrollTo(0,0); document.querySelectorAll('*').forEach(el=>{ if(el.scrollTop)el.scrollTop=0; });")
        let config = WKSnapshotConfiguration()
        let height = (try await js("document.documentElement.scrollHeight") as? NSNumber)?.doubleValue ?? 1024
        config.rect = CGRect(x: 0, y: 0, width: 1360, height: height)
        let snapshot = try await web.takeSnapshot(configuration: config)
        let bitmap = NSBitmapImageRep(data: snapshot.tiffRepresentation!)!
        try bitmap.representation(using: .png, properties: [:])!.write(to: fixture.output.appendingPathComponent("rcm-payment-voucher-native.png"))
        let document = try await js("JSON.stringify({title:document.querySelector('h1').textContent,body:document.querySelector('.rcm-document').outerHTML,styles:[...document.querySelectorAll('link[rel=stylesheet]')].map(el=>el.outerHTML).join('')})") as! String
        let fields = try JSONSerialization.jsonObject(with: Data(document.utf8)) as! [String:String]
        let printWeb = WKWebView(frame: NSRect(x:0,y:0,width:794,height:1123))
        window.contentView?.addSubview(printWeb)
        printWeb.loadHTMLString("<!doctype html><html><head>\(fields["styles"]!)<style>body{padding:24px;background:white}h1{font-family:var(--serif);font-size:30px}table{min-width:0}</style></head><body><h1>RCM payment voucher</h1>\(fields["body"]!)</body></html>", baseURL: URL(string:fixture.base))
        let readyUntil = Date().addingTimeInterval(15)
        while Date() < readyUntil {
            if (try await printWeb.evaluateJavaScript("Boolean(document.querySelector('.rcm-document')) && document.fonts.status==='loaded'") as? Bool) == true { break }
            try await Task.sleep(nanoseconds:100_000_000)
        }
        let printHeight = (try await printWeb.evaluateJavaScript("document.documentElement.scrollHeight") as? NSNumber)?.doubleValue ?? 1123
        if printHeight > 5000 { throw Failure(description: "Unexpectedly large payment document bounds") }
        let pdfURL = fixture.output.appendingPathComponent("rcm-payment-voucher.pdf")
        let pdfConfig = WKPDFConfiguration()
        pdfConfig.rect = CGRect(x: 0, y: 0, width: 794, height: printHeight)
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            printWeb.createPDF(configuration: pdfConfig) { result in continuation.resume(with: result) }
        }
        if data.count > 5_000_000 { throw Failure(description: "Unexpectedly large bounded WebKit PDF") }
        try data.write(to: pdfURL)
        guard let pdf = PDFDocument(url: pdfURL), let text = pdf.string,
              text.contains("Synthetic RCM Supplier"), text.contains("100.00"), text.contains("PUBLIC-RCM-SUP-1"), text.contains("RCM payment voucher"), text.contains("Authorised signatory") else {
            throw Failure(description: "Native payment-voucher PDF content did not match")
        }
        printWeb.removeFromSuperview()
        print("Bounded native WebKit payment voucher PDF passed, \(pdf.pageCount) page(s)")
    }
    func exercise() async throws {
        try await wait("Boolean(document.querySelector('#root .sheet'))", "app shell")
        try await navigate("gst-invoice?rcm=true")
        try await wait("Boolean(document.querySelector('#gst-compose'))", "invoice form")
        try await fill("#gst-compose [name=type]", "Purchase")
        try await fill("#gst-compose [name=partyId]", fixture.party)
        try await fill("#gst-compose [name=date]", "2026-04-10")
        try await fill("#gst-compose [name=supplierInvoiceNumber]", "PUBLIC-RCM-1")
        try await fill("#gst-compose [name=rcmBasis]", "Public synthetic notified RCM example, section9(3)")
        try await fill("#gst-compose [name=rcmReceiptDate]", "2026-04-01")
        try await fill("#gst-compose [name=rcmSupplierDate]", "2026-04-01")
        try await fill("#gst-compose [name=rcmSelfDate]", "2026-04-10")
        try await check("#gst-compose [name=rcmConfirmed]")
        try await fill("#gst-compose [data-field=itemId]", fixture.item)
        try await wait("Boolean(document.querySelector('[data-post-invoice]') && !document.querySelector('[data-post-invoice]').disabled)", "valid RCM invoice preview")
        try await click("[data-post-invoice]")
        try await wait("location.hash.includes('/gst-document/') && document.querySelector('h1')?.textContent==='Self-invoice'", "posted self-invoice")
        try await action("supplier-payment", date: "2026-04-10", reference: "PUBLIC-RCM-SUP-1", checks: ["proRata"], fields: ["bankDebitDate": "2026-04-10"])
        try await capturePayment()
        try await action("cash-deposit", date: "2026-04-10", reference: "PUBLIC-RCM-CASH-1")
        try await action("tax-payment", date: "2026-04-10", reference: "PUBLIC-RCM-DISCHARGE-1", checks: ["discharged"])
        try await action("itc-claim", date: "2026-04-11", reference: "PUBLIC-RCM-CLAIM-1", checks: ["received", "businessUse", "notBlocked", "documentsHeld"], fields: ["reviewBasis": "Public synthetic section16/17 eligibility review"])
        try await action("itc-reversal", date: "2026-04-12", reference: "PUBLIC-RCM-REVERSAL-1", fields: ["cgst": "4.50", "sgst": "4.50", "reversalReason": "temporary-reversal"])
        try await workspace()
        try await wait("document.body.innerText.includes('PUBLIC-RCM-REVERSAL-1')", "saved RCM activity")
    }
}

let fixture = try Fixture(CommandLine.arguments[1])
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let runner = Runner(fixture)
    app.delegate = runner
    app.setActivationPolicy(.regular)
    withExtendedLifetime(runner) { app.run() }
}
