import AppKit
import WebKit

struct ItcFailure: Error, CustomStringConvertible { let description:String }
@MainActor final class ItcRunner: NSObject,NSApplicationDelegate,WKNavigationDelegate,WKUIDelegate,WKDownloadDelegate {
    let fixture:[String:String]
    let output:URL
    var web:WKWebView!
    var window:NSWindow!
    var started=false
    var picker:URL?
    var pickerCalls=0
    var downloads:[WKDownload]=[]
    var destinationNames:[ObjectIdentifier:String]=[:]
    var finished:[String]=[]
    var downloadErrors:[String]=[]
    var originalCount=0
    var steps:[String]=[]
    init(_ file:String) throws {fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:file))) as! [String:String];output=URL(fileURLWithPath:fixture["output"]!);super.init()}
    func applicationDidFinishLaunching(_ notification:Notification) {
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        config.userContentController.addUserScript(WKUserScript(source:"window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:NSRect(x:0,y:0,width:1440,height:1050),configuration:config);web.navigationDelegate=self;web.uiDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.contentView=web;window.title="Ledgercraft isolated GSTR-2B and ITC proof";window.orderFront(nil)
        web.load(URLRequest(url:URL(string:fixture["base"]!)!))
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) {
        if started{return};started=true
        Task {do {try await exercise();print("Native saved GSTR-2B and ITC verification passed");exit(0)}catch{let body=(try? await js("document.body.innerText")) as? String ?? "";try? (String(describing:error)+"\n"+body).write(to:output.appendingPathComponent("failure.txt"),atomically:true,encoding:.utf8);try? await screenshot("failure.png");print("Native saved GSTR-2B/ITC verification failed: \(error)");exit(1)}}
    }
    func literal(_ value:String)->String {String(String(data:try! JSONSerialization.data(withJSONObject:[value]),encoding:.utf8)!.dropFirst().dropLast())}
    func js(_ source:String) async throws -> Any? {try await web.evaluateJavaScript(source)}
    func wait(_ condition:String,_ label:String,seconds:Double=30) async throws {let end=Date().addingTimeInterval(seconds);while Date()<end {if (try await js(condition)) as? Bool == true{return};try await Task.sleep(nanoseconds:100_000_000)};throw ItcFailure(description:"Timed out: "+label)}
    func require(_ condition:String,_ label:String) async throws {guard (try await js(condition)) as? Bool == true else{throw ItcFailure(description:label)}}
    func fill(_ selector:String,_ value:String) async throws {try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;const d=e.closest('details');if(d&&!d.open&&e!==d.querySelector('summary'))d.querySelector('summary').click();e.value=\(literal(value));e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()","Missing field "+selector)}
    func check(_ name:String) async throws {try await require("(()=>{const e=document.querySelector('#itc-review').elements[\(literal(name))];if(!e)return false;e.checked=true;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()","Missing confirmation "+name)}
    func click(_ selector:String) async throws {try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;const d=e.closest('details');if(d&&!d.open&&e!==d.querySelector('summary'))d.querySelector('summary').click();e.click();return true;})()","Missing control "+selector)}
    func go(_ company:String,_ section:String) async throws {_ = try await js("location.hash="+literal("#/c/"+company+"/"+section))}
    func returns(_ company:String,_ month:String) async throws {try await go(company,"gst-returns?registration="+fixture["registration"]!+"&month="+month);try await wait("!!document.querySelector('#two-b') && document.querySelector('#return-period [name=month]').value===\(literal(month)) && !!document.querySelector('nav a[href=\"#/c/\(company)/gst-returns\"]')","GST returns "+month)}
    func sourceDownload(_ index:Int) async throws {
        try await click("[data-saved-statements] a[download]")
        let name="statement-original-\(index).json"
        let end=Date().addingTimeInterval(30)
        while Date()<end {if finished.contains(name){return};if !downloadErrors.isEmpty{throw ItcFailure(description:downloadErrors.joined(separator:"\n"))};try await Task.sleep(nanoseconds:100_000_000)}
        throw ItcFailure(description:"Original statement download did not finish")
    }
    func screenshot(_ name:String) async throws {let image=try await web.takeSnapshot(configuration:nil);let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!;try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name))}
    func credit(_ table:String,_ amount:String) async throws {
        try await require("(()=>{const r=[...document.querySelectorAll('tr')].find(r=>r.children[0]?.textContent===\(literal(table)));return !!r&&r.children[2].textContent===\(literal(amount));})()","Wrong visible "+table+" IGST")
    }
    func exercise() async throws {
        let company=fixture["company"]!,invoice=fixture["invoice"]!,sha=fixture["sha256"]!
        try await returns(company,"2026-04")
        try await credit("4A(5)","0.00");try await credit("4(C)","0.00")
        try await require("document.querySelector('#two-b [name=keep]').checked","Statement-original saving is not selected")
        picker=URL(fileURLWithPath:fixture["source"]!)
        try await click("#two-b input[type=file]")
        try await wait("document.querySelector('#two-b input[type=file]').files.length===1","native statement file selection")
        try await click("#two-b button")
        try await wait("!!document.querySelector('[data-match-saved=\"\(sha)\"]')&&document.querySelector('[data-matches] tbody tr td')?.textContent==='Matched'","statement save and invoice match")
        try await credit("4A(5)","0.00");try await credit("4(C)","0.00")
        _ = try await js("document.querySelector('[data-matches]').scrollIntoView({block:'start'})")
        try await screenshot("saved-statement-match.png")
        steps.append("Native file input saved exact original statement and matched synthetic purchase without claiming credit")
        try await sourceDownload(1)
        try await require("window.__errors.length===0","Statement page errors before reopen")
        _ = try await js("window.__preReloadDocument=true")
        web.reload()
        try await wait("window.__preReloadDocument===undefined && !!document.querySelector('[data-match-saved=\"\(sha)\"]')","saved statement survives reopen")
        try await click("[data-match-saved]")
        try await wait("document.querySelector('[data-matches] tbody tr td')?.textContent==='Matched'","saved statement reopened and rematched")
        steps.append("Original download and saved-statement reopen/rematch work through normal controls")
        try await go(company,"gst-itc/"+invoice+"?to=2026-05-31")
        try await wait("!!document.querySelector('#itc-review [name=statementId] option[value=\"0\"]')","saved statement candidate")
        try await fill("#itc-review [name=statementId]","0")
        let checks=["invoiceHeld","received","businessUse","notBlocked","supplierReported","supplierTaxPaid","returnFurnished","paymentReview","noTaxDepreciation"]
        try await require("\(literal(checks.joined(separator:","))).split(',').every(name=>!document.querySelector('#itc-review').elements[name].checked)","Statement selection auto-confirmed claim eligibility")
        try await require("document.querySelector('[data-itc-statement-status]').textContent.includes('Matched')","Saved evidence status not visible")
        try await fill("#itc-review [name=action]","claim")
        try await fill("#itc-review [name=date]","2026-05-02")
        try await fill("#itc-review [name=reference]","Synthetic May claim S1")
        try await fill("#itc-review [name=documentReference]","PUBLIC-ITC-1")
        try await fill("#itc-review [name=basis]","Synthetic invoice, receipt, business use and statutory conditions reviewed")
        try await fill("#itc-review [name=annualReturnStatus]","not-filed")
        for name in checks {try await check(name)}
        try await require("document.querySelector('[data-itc-total]').textContent.includes('18.00')","Wrong exact credit allocation")
        try await click("#itc-review button[type=submit]")
        try await wait("!!document.querySelector('[data-itc-record]')&&document.querySelector('.itc-history').textContent.includes('Synthetic May claim S1')","manual claim recorded")
        try await require("document.querySelector('.itc-history').textContent.includes('4A(5)')","Manual claim has no return working-paper trace")
        try await click("[data-itc-record] summary")
        _ = try await js("document.querySelector('.itc-history').scrollIntoView({block:'start'})")
        try await screenshot("manual-itc-review-history.png")
        steps.append("Saved statement row selected as evidence; nine conditions and annual-return timing manually confirmed; exact claim recorded")
        try await returns(company,"2026-05")
        try await credit("4A(5)","18.00");try await credit("4(C)","18.00")
        _ = try await js("[...document.querySelectorAll('h2')].find(e=>e.textContent==='Purchase credit decisions').scrollIntoView({block:'start'})")
        try await screenshot("may-4a-4c-credit.png")
        steps.append("May return shows IGST 18.00 in 4A(5) and 4(C)")
        try await go(company,"transfer")
        try await wait("!!document.querySelector('a[href$=\"/backup\"]')","company backup link")
        try await click("a[href$='/backup']")
        let end=Date().addingTimeInterval(30)
        while !finished.contains("company-backup.json")&&Date()<end {try await Task.sleep(nanoseconds:100_000_000)}
        guard finished.contains("company-backup.json") else{throw ItcFailure(description:"Company backup download did not finish")}
        picker=output.appendingPathComponent("company-backup.json")
        try await click("#book-files")
        try await wait("document.querySelector('#book-files').files.length===1","native backup selection")
        try await click("#book-import button")
        try await wait("location.hash.startsWith('#/c/import-')&&!!document.querySelector('main h1')","GUI company restore")
        let restored=String(((try await js("location.hash")) as! String).split(separator:"/")[2].split(separator:"?")[0])
        try await returns(restored,"2026-04")
        try await wait("!!document.querySelector('[data-match-saved=\"\(sha)\"]')","restored statement library")
        try await sourceDownload(2)
        try await click("[data-match-saved]")
        try await wait("document.querySelector('[data-matches] tbody tr td')?.textContent==='Matched'","restored source rematch")
        try await returns(restored,"2026-05")
        try await credit("4A(5)","18.00");try await credit("4(C)","18.00")
        try await go(restored,"gst-itc/"+invoice+"?to=2026-05-31")
        try await wait("!!document.querySelector('[data-itc-record]')","restored ITC history")
        try await require("document.querySelector('.itc-history').textContent.includes('Synthetic May claim S1')","Restored claim history missing")
        try await require("window.__errors.length===0","Native ITC page errors")
        steps.append("Normal GUI backup/restore preserves statement download, rematch, ITC history and return credit")
        let result:[String:Any]=["passed":true,"browser":"macOS WKWebView, frozen local synthetic books","steps":steps,"restoredCompany":restored,"nativeOpenFileDelegateCalls":pickerCalls,"downloads":finished,"pageErrors":[],"manualFileSelection":false]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-results.json"))
        window.close()
    }
    func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping([URL]?)->Void) {pickerCalls+=1;completionHandler(picker.map{[$0]})}
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {if navigationAction.shouldPerformDownload{decisionHandler(.download)}else{decisionHandler(navigationAction.request.url?.host=="127.0.0.1" ? .allow : .cancel)}}
    func webView(_ webView:WKWebView,decidePolicyFor navigationResponse:WKNavigationResponse,decisionHandler:@escaping(WKNavigationResponsePolicy)->Void) {decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)}
    func webView(_ webView:WKWebView,navigationAction:WKNavigationAction,didBecome download:WKDownload) {downloads.append(download);download.delegate=self}
    func webView(_ webView:WKWebView,navigationResponse:WKNavigationResponse,didBecome download:WKDownload) {downloads.append(download);download.delegate=self}
    func download(_ download:WKDownload,decideDestinationUsing response:URLResponse,suggestedFilename:String,completionHandler:@escaping(URL?)->Void) {
        let name:String
        if response.url?.path.hasSuffix("/backup")==true {name="company-backup.json"}else{originalCount+=1;name="statement-original-\(originalCount).json"}
        destinationNames[ObjectIdentifier(download)]=name
        let file=output.appendingPathComponent(name);try? FileManager.default.removeItem(at:file);completionHandler(file)
    }
    func downloadDidFinish(_ download:WKDownload) {if let name=destinationNames.removeValue(forKey:ObjectIdentifier(download)){finished.append(name)}}
    func download(_ download:WKDownload,didFailWithError error:Error,resumeData:Data?) {downloadErrors.append(error.localizedDescription)}
}
try MainActor.assumeIsolated {let app=NSApplication.shared;let runner=try ItcRunner(CommandLine.arguments[1]);app.delegate=runner;app.setActivationPolicy(.accessory);app.run()}
