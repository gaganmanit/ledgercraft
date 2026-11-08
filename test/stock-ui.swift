import AppKit
import WebKit

struct StockFailure: Error, CustomStringConvertible { let description: String }
@MainActor final class StockRunner: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let fixture: [String:String]
    let output: URL
    var window: NSWindow!
    var web: WKWebView!
    var started = false
    var printed = false
    var steps: [String] = []
    init(_ file: String) throws { fixture = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:file))) as! [String:String]; output=URL(fileURLWithPath:fixture["output"]!); super.init() }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self,name:"stockPrint")
        config.userContentController.addUserScript(WKUserScript(source:"window.print=()=>window.webkit.messageHandlers.stockPrint.postMessage(null);window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));window.__stockGets=0;const nativeFetch=window.fetch;window.fetch=(u,o)=>{if(String(u).includes('/stock')&&!String(u).includes('/stock/journals')&&(!o||!o.method||o.method==='GET'))window.__stockGets++;return nativeFetch(u,o);};",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:NSRect(x:0,y:0,width:1440,height:1050),configuration:config);web.navigationDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.contentView=web;window.title="Ledgercraft isolated stock verification";window.orderFront(nil)
        web.load(URLRequest(url:URL(string:fixture["base"]!)!))
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if started{return};started=true
        Task { do {try await exercise();print("Native stock UI verification passed");exit(0)} catch {let body=(try? await js("document.body.innerText")) as? String ?? "";try? (String(describing:error)+"\n"+body).write(to:output.appendingPathComponent("failure.txt"),atomically:true,encoding:.utf8);try? await snapshot("failure.png");print("Native stock UI verification failed: \(error)");exit(1)} }
    }
    func literal(_ value:String)->String {let encoded=String(data:try! JSONSerialization.data(withJSONObject:[value]),encoding:.utf8)!;return String(encoded.dropFirst().dropLast())}
    func js(_ code:String) async throws -> Any? {try await web.evaluateJavaScript(code)}
    func wait(_ condition:String,_ label:String,seconds:Double=30) async throws {
        let end=Date().addingTimeInterval(seconds)
        while Date()<end {if (try await js(condition)) as? Bool == true{return};try await Task.sleep(nanoseconds:100_000_000)}
        throw StockFailure(description:"Timed out: "+label)
    }
    func require(_ condition:String,_ label:String) async throws {guard (try await js(condition)) as? Bool == true else {throw StockFailure(description:label)}}
    func fill(_ selector:String,_ value:String) async throws {
        let ok=try await js("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;const d=e.closest('details');if(d&&!d.open)d.querySelector('summary').click();e.value=\(literal(value));e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()")
        guard ok as? Bool == true else{throw StockFailure(description:"Missing input "+selector)}
    }
    func click(_ selector:String) async throws {try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;const d=e.closest('details');if(d&&!d.open)d.querySelector('summary').click();e.click();return true;})()","Missing control "+selector)}
    func go(_ section:String) async throws {_ = try await js("location.hash="+literal("#/c/"+fixture["company"]!+"/"+section))}
    func stock() async throws {try await go("stock?from=2026-04-01&to=2026-04-30");try await wait("!!document.querySelector('.stock-summary-table')","stock summary")}
    func item(_ id:String) async throws {try await go("stock-item/"+id+"?from=2026-04-01&to=2026-04-30");try await wait("!!document.querySelector('#stock-item-settings')","item ledger")}
    func submit(_ form:String) async throws {try await click(form+" button:not([type])")}
    func snapshot(_ name:String) async throws {
        let image=try await web.takeSnapshot(configuration:nil)
        let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!
        try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name))
    }
    func journal(_ type:String,_ number:String,_ date:String,_ godown:String,_ quantity:String,_ value:String?=nil) async throws {
        try await fill("#stock-journal [name=type]",type)
        try await fill("#stock-journal [name=number]",number)
        try await fill("#stock-journal [name=date]",date)
        try await fill("#stock-journal [data-field=itemId]",fixture["fasteners"]!)
        if type=="transfer" {try await fill("#stock-journal [data-field=fromGodownId]","main");try await fill("#stock-journal [data-field=toGodownId]",godown)}
        else {try await fill("#stock-journal [data-field=godownId]",godown);if type=="adjustment" {try await fill("#stock-journal [data-field=direction]","out")}}
        try await fill("#stock-journal [data-field=quantity]",quantity)
        try await fill("#stock-journal [data-field=reason]","Synthetic "+number)
        if let value {try await fill("#stock-journal [data-field=value]",value)}
        _ = try await js("document.querySelector('#stock-journal').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true}))")
        try await wait("document.querySelector('[data-stock-journals]').textContent.includes("+literal(number)+")","journal "+number)
    }
    func exercise() async throws {
        if CommandLine.arguments.contains("--print-only") {
            try await item(fixture["fasteners"]!)
        try await click("[data-stock-print]")
        let deadline=Date().addingTimeInterval(40)
        while !printed && Date()<deadline { try await Task.sleep(nanoseconds:100_000_000) }
        guard printed else {throw StockFailure(description:"Native print completion callback did not succeed")}
        let size=(try FileManager.default.attributesOfItem(atPath:output.appendingPathComponent("stock-item-ledger.pdf").path)[.size] as! NSNumber).intValue
        guard size>1000 else {throw StockFailure(description:"Native PDF is empty")}
        try JSONSerialization.data(withJSONObject:["passed":true,"path":"Normal print button -> native WKWebView.printOperation.runModal","nativeCompletionCallback":true,"pdfBytes":size],options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-print-results.json"))
            window.close(); return
        }
        let fasteners=fixture["fasteners"]!,spares=fixture["spares"]!,service=fixture["service"]!,company=fixture["company"]!
        try await stock()
        try await require("document.querySelectorAll('nav a[href=\"#/c/\(company)/stock\"]').length===1","Duplicate stock navigation")
        try await require("document.querySelector('[data-stock-summary]').textContent.includes('Incomplete')","Missing cost must remain incomplete")
        try await require("!document.querySelector('.stock-summary-table').textContent.includes('Synthetic handling')","Service entered stock summary")
        try await require("document.querySelector('.stock-gaps').textContent.includes('actual opening inventory value')","Missing opening cost has no action")
        try await snapshot("stock-incomplete.png");steps.append("Missing opening values shown as incomplete; service excluded")
        try await item(spares)
        try await fill("#stock-item-settings [name=openingValue]","20.00")
        try await fill("#stock-item-settings [data-field=value]","20.00")
        try await submit("#stock-item-settings")
        try await wait("document.body.innerText.includes('Item costing saved.')","opening cost save")
        try await require("!document.querySelector('[data-stock-summary]').textContent.includes('Incomplete')","Saved actual opening cost remains incomplete")
        steps.append("Actual opening cost saved through item editor")
        try await stock()
        _ = try await js("(()=>{const e=document.querySelector('#stock-integration [name=integrateAccounts]');e.closest('details').open=true;e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));})()")
        try await submit("#stock-integration")
        try await wait("document.body.innerText.includes('Inventory accounting setting saved.')","explicit financial integration")
        steps.append("Financial integration explicitly enabled after matching opening ledgers")
        try await fill("#stock-journal [name=number]","DRAFT-KEEP")
        try await fill("#stock-journal [data-field=quantity]","3")
        try await fill("#stock-godown [name=name]","Annex")
        try await submit("#stock-godown")
        try await wait("document.body.innerText.includes('Godown added.')","godown add")
        try await require("document.querySelector('#stock-journal [name=number]').value==='DRAFT-KEEP' && document.querySelector('#stock-journal [data-field=quantity]').value==='3'","Godown save discarded unrelated journal draft")
        try await require("document.querySelector('#stock-integration [name=integrateAccounts]').checked","Unrelated save reverted integration checkbox")
        let annex=(try await js("[...document.querySelector('#stock-period [name=godown]').options].find(o=>o.text==='Annex').value")) as! String
        steps.append("Godown saved without losing unrelated journal draft")
        try await journal("transfer","TX-001","2026-04-05",annex,"3")
        let before=(try await js("window.__stockGets")) as! Int
        try await fill("#stock-period [name=godown]",annex)
        try await wait("document.querySelector('.stock-summary-table a[href*=\"\(fasteners)\"]').closest('tr').children[2].textContent==='3'","godown quantity")
        try await require("window.__stockGets===\(before)","Godown filter unexpectedly fetched another report")
        try await fill("#stock-period [name=godown]","")
        try await journal("adjustment","ADJ-001","2026-04-06",annex,"1")
        try await journal("physical","PC-001","2026-04-07","main","8","15.00")
        steps.append("Dated transfer, stock loss and explicitly valued physical gain posted with keyboard shortcut")
        try await item(fasteners)
        try await fill("#stock-item-settings [name=costingMethod]","moving-average")
        try await submit("#stock-item-settings")
        try await wait("document.body.innerText.includes('Item costing saved.')","moving average save")
        try await require("document.querySelector('[data-stock-movements]').textContent.includes('TX-001') && document.querySelector('[data-stock-movements]').textContent.includes('PC-001')","Item history missing journal sources")
        steps.append("Moving-average selection replayed item ledger and cost lineage")
        try await go("gst-invoice")
        try await wait("!!document.querySelector('#gst-compose')","GST composer")
        try await fill("#gst-compose [name=partyId]",fixture["party"]!)
        try await fill("#gst-compose [name=date]","2026-04-08")
        try await fill("#gst-compose [data-line='0'] [data-field=itemId]",fasteners)
        try await fill("#gst-compose [data-line='0'] [data-field=godownId]",annex)
        try await fill("#gst-compose [data-line='0'] [data-field=quantity]","1")
        try await click("#gst-compose [data-add-item]")
        try await fill("#gst-compose [data-line='1'] [data-field=itemId]",service)
        try await require("document.querySelector('#gst-compose [data-line=\"1\"] .gst-line-godown').hidden && document.querySelector('#gst-compose [data-line=\"1\"] [data-field=godownId]').disabled","Service exposes a goods godown")
        try await require("window.__errors.length===0","Stock page errors before draft reload")
        web.reload()
        try await wait("document.querySelector('[data-draft-status]')?.textContent==='Saved draft restored'","invoice draft restore")
        try await require("document.querySelector('#gst-compose [data-line=\"0\"] [data-field=godownId]').value===\(literal(annex))","Invoice godown lost on reload")
        try await wait("!document.querySelector('[data-post-invoice]').disabled && document.querySelector('.gst-preview-total').textContent.includes('129.80')","mixed goods/service invoice preview")
        _ = try await js("document.querySelector('#gst-compose').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true}))")
        try await wait("location.hash.includes('/gst-document/') && !!document.querySelector('.gst-document')","GST invoice post")
        steps.append("Per-line invoice godown survives draft reload; service omitted; keyboard post succeeds")
        try await item(fasteners)
        try await require("document.querySelector('[data-stock-summary]').textContent.includes('94.50')","Sale did not update moving-average value")
        _ = try await js("document.querySelector('[data-stock-movements]').scrollIntoView({block:'start'})")
        try await snapshot("stock-item-ledger.png")
        for width in [375,768,1024,1440] {
            window.setContentSize(NSSize(width:width,height:1050))
            try await wait("window.innerWidth===\(width)","viewport \(width)")
            try await require("document.documentElement.scrollWidth<=window.innerWidth+1","Stock page overflows viewport \(width)")
            if width==375 {try await snapshot("stock-item-mobile.png")}
        }
        steps.append("Stock item layout fits 375, 768, 1024 and 1440 pixel viewports")
        try await go("gst-invoice")
        try await wait("!!document.querySelector('#gst-compose')","note composer")
        try await fill("#gst-compose [name=type]","Credit Note")
        try await fill("#gst-compose [data-field=itemId]",fasteners)
        try await require("document.querySelector('#gst-compose .gst-line-godown').hidden && document.querySelector('#gst-compose [data-field=godownId]').disabled","Financial-only note exposes unsupported stock godown")
        try await fill("#gst-compose [name=stockEffect]","quantity")
        try await require("!document.querySelector('#gst-compose .gst-line-godown').hidden && !document.querySelector('#gst-compose [data-field=godownId]').disabled","Goods-return note cannot choose godown")
        steps.append("Financial-only notes omit godown; quantity notes allow it")
        try await require("window.__errors.length===0","Native stock page errors")
        let result:[String:Any] = ["passed":true,"browser":"macOS WKWebView, local frozen synthetic fixture","steps":steps,"pageErrors":[],"manualPickerOrPrintDialog":false]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-results.json"))
        window.close()
    }
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage) {
        guard message.name=="stockPrint" else{return}
        let info=NSPrintInfo.shared.copy() as! NSPrintInfo;info.jobDisposition = .save;info.horizontalPagination = .fit
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL]=output.appendingPathComponent("stock-item-ledger.pdf")
        info.topMargin=28;info.bottomMargin=28;info.leftMargin=24;info.rightMargin=24
        let op=web.printOperation(with:info);op.showsPrintPanel=false;op.showsProgressPanel=false
        op.runModal(for:window,delegate:self,didRun:#selector(printFinished(_:success:context:)),contextInfo:nil)
    }
    @objc func printFinished(_ op:NSPrintOperation,success:Bool,context:UnsafeMutableRawPointer?) {printed=success;try? JSONSerialization.data(withJSONObject:["success":success]).write(to:output.appendingPathComponent("native-print-callback.json"))}
}
try MainActor.assumeIsolated {let app=NSApplication.shared;let runner=try StockRunner(CommandLine.arguments[1]);app.delegate=runner;app.setActivationPolicy(.accessory);app.run()}
