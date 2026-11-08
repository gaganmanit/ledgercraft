import AppKit
import WebKit
struct PurchaseUIFailure:Error,CustomStringConvertible {let description:String}
@MainActor final class PurchaseUIRunner:NSObject,NSApplicationDelegate,WKNavigationDelegate,WKUIDelegate,WKDownloadDelegate {
    let fixture:[String:String],output:URL
    var web:WKWebView!,window:NSWindow!,started=false,picker:URL?,pickerCalls=0
    var steps:[String]=[]
    var downloads:[WKDownload]=[],finished:[String]=[],downloadErrors:[String]=[]
    var destinationNames:[ObjectIdentifier:String]=[:]
    init(_ path:String)throws{fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:path))) as! [String:String];output=URL(fileURLWithPath:fixture["output"]!);super.init()}
    func applicationDidFinishLaunching(_ notification:Notification){
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        config.userContentController.addUserScript(WKUserScript(source:"""
        window.__errors=[];window.__mappingPosts=[];window.__activationPosts=[];window.__creditPosts=[];window.__manualPreviews=[];window.addEventListener('error',e=>window.__errors.push(e.message));
        const realFetch=window.fetch;
        window.fetch=async(u,o)=>{const url=new URL(typeof u==='string'?u:u.url,location.href);if(url.pathname.endsWith('/gst/mapping')&&o?.method==='POST')window.__mappingPosts.push(JSON.parse(o.body));if(url.pathname.endsWith('/gst/activate')&&o?.method==='POST')window.__activationPosts.push(JSON.parse(o.body));if(url.pathname.includes('/itc/')&&o?.method==='POST')window.__creditPosts.push(url.pathname);const r=await realFetch(u,o);if(url.pathname.endsWith('/gst/preview')&&r.ok)window.__manualPreviews.push({request:JSON.parse(o.body),response:await r.clone().json()});if(/\\/api\\/tally\\/companies\\/[^/]+\\/gst$/.test(url.pathname)){window.__purchaseReview=await r.clone().json();window.__reviewCompany=url.pathname.split('/')[4];}return r;};
        """,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:NSRect(x:0,y:0,width:1440,height:1050),configuration:config);web.navigationDelegate=self;web.uiDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.contentView=web;window.title="Ledgercraft purchase source review — isolated synthetic books";window.orderFront(nil)
        web.load(URLRequest(url:URL(string:fixture["base"]!)!))
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){if started{return};started=true;Task{do{try await exercise();print("Native purchase source review passed");exit(0)}catch{let body=(try? await js("document.body.innerText")) as? String ?? "";try? (String(describing:error)+"\n"+body).write(to:output.appendingPathComponent("failure.txt"),atomically:true,encoding:.utf8);try? await snapshot("failure.png");print("Native purchase source review failed: \(error)");exit(1)}}}
    func literal(_ text:String)->String{String(String(data:try! JSONSerialization.data(withJSONObject:[text]),encoding:.utf8)!.dropFirst().dropLast())}
    func js(_ source:String)async throws->Any?{try await web.evaluateJavaScript(source)}
    func require(_ condition:String,_ label:String)async throws{guard (try await js(condition)) as? Bool==true else{throw PurchaseUIFailure(description:label)}}
    func wait(_ condition:String,_ label:String)async throws{let end=Date().addingTimeInterval(30);while Date()<end{if (try await js(condition)) as? Bool==true{return};try await Task.sleep(nanoseconds:100_000_000)};throw PurchaseUIFailure(description:"Timed out: "+label)}
    func fill(_ selector:String,_ value:String)async throws{try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;for(let d=e.closest('details');d;d=d.parentElement.closest('details'))d.open=true;e.value=\(literal(value));e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()","Missing field "+selector)}
    func click(_ selector:String)async throws{try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e||e.disabled)return false;for(let d=e.parentElement.closest('details');d;d=d.parentElement.closest('details'))if(e!==d.querySelector(':scope > summary'))d.open=true;e.focus();e.click();return true;})()","Missing/enabled control "+selector)}
    func snapshot(_ name:String)async throws{let shot=try await web.takeSnapshot(configuration:nil),bitmap=NSBitmapImageRep(data:shot.tiffRepresentation!)!;try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name))}
    func go(_ company:String,_ section:String)async throws{_ = try await js("location.hash="+literal("#/c/"+company+"/"+section))}
    func importCompany(_ file:String,_ name:String)async throws->String{
        _ = try await js("location.hash='#/tally-import';true")
        try await wait("!!document.querySelector('#tally-preview-form')","normal Tally import picker")
        picker=URL(fileURLWithPath:file);try await click("#tally-preview-form [name=files]")
        try await wait("document.querySelector('#tally-preview-form [name=files]').files.length===1","native purchase XML selection")
        try await fill("#tally-preview-form [name=companyName]",name);try await fill("#tally-preview-form [name=booksFrom]","2026-04-01")
        try await click("#tally-preview-form button");try await wait("!!document.querySelector('#tally-confirm')","purchase accounting preview")
        try await click("#tally-confirm input");try await click("#tally-confirm button")
        try await wait("location.hash.includes('/tally-source')&&window.__reviewCompany===location.hash.split('/')[2]&&document.querySelector('[data-tally-gst-rows]')?.getAttribute('aria-busy')==='false'","purchase source review")
        return String(((try await js("location.hash")) as! String).split(separator:"/")[2].split(separator:"?")[0])
    }
    func createMasters()async throws{
        try await click("[data-tally-gst-prepare=seller]")
        try await require("document.querySelector('[data-tally-gst-master=settings]').elements.gstin.value==='23ABCDE1234F1Z8'","Business registration used supplier GSTIN")
        try await fill("[data-tally-gst-master=settings] [name=name]","Synthetic purchase buyer")
        try await fill("[data-tally-gst-master=settings] [name=legalName]","Synthetic purchase buyer")
        try await fill("[data-tally-gst-master=settings] [name=address]","Synthetic buyer address, Madhya Pradesh")
        try await click("[data-tally-gst-master=settings] button")
        try await wait("window.__purchaseReview.registrations.length===1&&!document.querySelector('[data-tally-gst-refresh]').disabled","saved buyer registration")
        try await click("[data-tally-gst-prepare=party]")
        try await require("document.querySelector('[data-tally-gst-master=suppliers]').elements.gstin.value==='27PQRST5678L1Z0'&&document.querySelector('[data-tally-gst-master=suppliers]').elements.supplierLedgerId.value===window.__purchaseReview.rows[0].source.partyLedgerId","Supplier preparation used buyer/customer role")
        try await fill("[data-tally-gst-master=suppliers] [name=address]","Synthetic supplier address, Maharashtra")
        try await click("[data-tally-gst-master=suppliers] button")
        try await wait("window.__purchaseReview.parties.length===1&&!document.querySelector('[data-tally-gst-refresh]').disabled","saved original supplier ledger link")
        try await require("window.__purchaseReview.parties[0].kind==='supplier'&&window.__purchaseReview.parties[0].supplierLedgerId===window.__purchaseReview.rows[0].source.partyLedgerId","Supplier master posting link not retained")
        try await click("[data-tally-gst-prepare=item]")
        try await require("document.querySelector('[data-tally-gst-master=items]').elements.hsnSac.value==='8541'&&document.querySelector('[data-tally-gst-master=items]').elements.gstRate.value==='18'","Supplied purchase HSN/rate preparation")
        try await click("[data-tally-gst-master=items] button")
        try await wait("window.__purchaseReview.items.length===1&&!document.querySelector('[data-tally-gst-refresh]').disabled","saved source goods master")
        steps.append("Explicit source-fact preparation saved own MP business, Maharashtra supplier linked to original creditor, and source HSN/rate item without swapping buyer/seller roles")
    }
    func mapPurchase()async throws{
        try await click("[data-tally-gst-match-source]")
        try await require("(()=>{const f=document.querySelector('[data-tally-gst-mapping]');return f.elements.registrationId.value===window.__purchaseReview.registrations[0].id&&f.elements.partyId.value===window.__purchaseReview.parties[0].id&&f.elements['account-purchase']&&!f.elements['account-sales']&&!f.querySelector('select[name=itcEligibility]');})()","Purchase mapping still uses sales/customer roles")
        try await require("(()=>{const f=document.querySelector('[data-tally-gst-mapping]');return f.elements.supplierInvoiceNumber.value==='INV/3103'&&f.elements.supplierInvoiceDate.value==='2026-03-31'&&f.elements.receivedDate.value===''&&f.elements.placeOfSupply.value==='23'&&f.textContent.includes('Pending review');})()","Supplier dates/references, receipt or pending credit defaults incorrect")
        try await require("document.querySelector('[data-tally-purchase-identities]').textContent.includes('P-48')&&document.querySelector('[data-tally-purchase-identities]').textContent.includes('02-04-2026')&&document.querySelector('[data-tally-purchase-identities]').textContent.includes('INV/3103')&&document.querySelector('[data-tally-purchase-identities]').textContent.includes('31-03-2026')&&document.querySelector('.tally-gst-item p').textContent.includes('actual 3 nos')&&document.querySelector('.tally-gst-item p').textContent.includes('billed 2 nos')","Internal/supplier identity or physical/billed quantity display lost")
        _ = try await js("window.__beforePostings=window.__purchaseReview.rows[0].source.postings.map(({ledgerId,dc,paise})=>({ledgerId,dc,paise}));true")
        try await fill("[name=account-party]",(try await js("window.__purchaseReview.rows[0].source.partyLedgerId")) as! String)
        try await fill("[name=account-purchase]",(try await js("window.__purchaseReview.ledgers.find(l=>l.name==='Purchase').id")) as! String)
        try await fill("[name=account-igst]",(try await js("window.__purchaseReview.ledgers.find(l=>l.name==='Input IGST').id")) as! String)
        try await fill("[name=supplierInvoiceNumber]","INV/3103-C")
        try await require("document.querySelector('[name=\\\"sourceCorrection:supplierInvoiceNumber\\\"]').required","Changed supplied supplier number lacks correction reason")
        try await fill("[name=supplierInvoiceNumber]","INV/3103")
        try await fill("[name=placeOfSupply]","27")
        try await require("document.querySelector('[name=\\\"sourceCorrection:placeOfSupply\\\"]').required","Changed supplied POS lacks correction reason")
        try await fill("[name=placeOfSupply]","23")
        try await fill("[name=receivedDate]","2026-04-01")
        try await click("[name=purchaseReviewed]")
        try await click("[data-tally-gst-mapping] button[type=submit]")
        try await require("window.__mappingPosts.length===0&&document.querySelector('[name=evidenceName]').validity.valueMissing","Mapping submitted without supporting evidence")
        try await fill("[name=evidenceName]","Synthetic purchase acceptance fixture")
        try await fill("[name=evidenceReference]","Synthetic supplier INV/3103 dated 31-03-2026; receipt reviewed on 01-04-2026; no real business data")
        try await click("[name=purchaseReviewed]")
        try await click("[data-tally-gst-mapping] button[type=submit]")
        try await wait("window.__purchaseReview.summary.ready===1&&document.querySelector('[data-tally-gst-select]')&&!document.querySelector('[data-tally-gst-refresh]').disabled","reviewed purchase ready")
        try await require("window.__mappingPosts.length===1&&window.__mappingPosts[0].purchaseReview.itcEligibility==='pending'&&window.__mappingPosts[0].purchaseReview.placeOfSupply==='23'&&window.__mappingPosts[0].purchaseReview.receivedDate==='2026-04-01'","Purchase API payload lost reviewed details or auto-eligible credit")
        steps.append("Native purchase form separated supplier INV/3103/31-03 from internal P-48/02-04, actual3/billed2, required receipt/evidence/review, input-tax accounts and explicit POS correction reasons; payload fixed ITC pending")
    }
    func exercise()async throws{
        let company=try await importCompany(fixture["source"]!,"Synthetic native purchase review")
        try await require("document.querySelector('[data-tally-gst-type=Purchase]')!==null","Purchase absent from normal source desk")
        try await createMasters();try await mapPurchase()
        _ = try await js("document.querySelector('[data-tally-gst-mapping]').scrollIntoView({block:'start'});true")
        try await snapshot("purchase-ready.png")
        for width in [375,768,1024,1440]{window.setContentSize(NSSize(width:width,height:1050));try await wait("innerWidth===\(width)","viewport");try await require("document.querySelector('.tally-gst-review').scrollWidth<=document.querySelector('.tally-gst-review').clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1","Purchase review overflow");if width==375{_ = try await js("document.querySelector('[data-tally-purchase-identities]').scrollIntoView({block:'start'});true");try await snapshot("purchase-mobile.png")}}
        try await click("[data-tally-gst-select]");try await click("[data-tally-gst-activate]")
        try await wait("window.__purchaseReview.summary.active===1&&document.querySelector('[data-tally-gst-summary]').textContent.includes('1 active')","purchase activation")
        try await require("!document.querySelector('[data-tally-gst-select]')&&document.querySelector('[data-tally-gst-activate]').disabled&&document.querySelector('[data-tally-gst-message]').textContent.includes('1 GST invoice activated')&&window.__activationPosts.length===1","Activation save receipt or duplicate prevention missing")
        try await click("[data-tally-gst-refresh]")
        try await wait("document.querySelector('[data-tally-gst-rows]').getAttribute('aria-busy')==='false'&&window.__purchaseReview.summary.active===1","saved activation reload")
        try await require("!document.querySelector('[data-tally-gst-select]')&&document.querySelector('[data-tally-gst-activate]').disabled&&window.__activationPosts.length===1","Reload made active purchase selectable a second time")
        try await click("a[href*='/gst-document/']")
        try await wait("!!document.querySelector('.gst-document')","activated GST purchase")
        try await require("document.querySelector('.gst-document').textContent.includes('INV/3103')&&document.querySelector('.gst-document').textContent.includes('31-03-2026')","GST purchase omits original supplier identity")
        try await snapshot("purchase-document.png")
        try await go(company,"tally-source?review=gst")
        try await wait("window.__reviewCompany===\(literal(company))&&!!document.querySelector(\"a[href*='/gst-itc/']\")","purchase credit review link")
        try await click("a[href*='/gst-itc/']");try await wait("!!document.querySelector('#itc-review')","dated purchase ITC desk")
        steps.append("Ready purchase activated once and opened its GST document with supplier date/reference, then the existing dated Purchase ITC review desk; no credit decision was posted")
        let manualParty=(try await js("window.__purchaseReview.parties[0].id")) as! String
        let manualItem=(try await js("window.__purchaseReview.items[0].id")) as! String
        try await go(company,"gst-invoice")
        try await wait("!!document.querySelector('#gst-compose')","normal new invoice")
        try await fill("#gst-compose [name=type]","Purchase")
        try await require("!document.querySelector('[data-forward-purchase-date]').hidden&&!document.querySelector('[name=supplierInvoiceDate]').disabled","Manual forward Purchase supplier date is unavailable")
        try await fill("#gst-compose [name=partyId]",manualParty)
        try await fill("#gst-compose [name=date]","2026-04-02")
        try await fill("#gst-compose [name=supplierInvoiceNumber]","MANUAL/3103")
        try await fill("#gst-compose [name=supplierInvoiceDate]","2026-03-31")
        try await fill("#gst-compose [data-field=itemId]",manualItem)
        try await fill("#gst-compose [data-field=quantity]","2")
        try await fill("#gst-compose [data-field=unitPrice]","100")
        try await wait("!document.querySelector('[data-post-invoice]').disabled&&window.__manualPreviews.at(-1)?.response.invoice.supplierInvoiceDate==='2026-03-31'","manual Purchase date retained through preview")
        try await require("window.__manualPreviews.at(-1).request.supplierInvoiceDate==='2026-03-31'&&window.__manualPreviews.at(-1).response.invoice.supplierInvoiceNumber==='MANUAL/3103'&&window.__manualPreviews.at(-1).response.invoice.date==='2026-04-02'","Manual supplier identity/date replaced with posting identity")
        try await snapshot("manual-purchase-date-preview.png")
        steps.append("Normal New invoice Purchase exposes supplier document date and retains 31-03-2026 with MANUAL/3103 through preview while posting date stays 02-04-2026; draft was not posted")
        try await go(company,"tally-source?review=gst")
        try await wait("window.__reviewCompany===\(literal(company))&&document.querySelector('[data-tally-gst-rows]')?.getAttribute('aria-busy')==='false'","purchase archive link")
        try await click("a[href$='/archive']")
        try await waitDownload("tally-full-archive.json")
        try await go(company,"transfer")
        try await wait("!!document.querySelector(\"a[href$='/backup']\")","purchase company backup link")
        try await click("a[href$='/backup']")
        try await waitDownload("company-backup.json")
        picker=output.appendingPathComponent("company-backup.json")
        try await click("#book-files")
        try await wait("document.querySelector('#book-files').files.length===1","native purchase backup selection")
        try await click("#book-import button")
        try await wait("location.hash.startsWith('#/c/')&&location.hash.split('/')[2]!==\(literal(company))&&!!document.querySelector('main h1')","native purchase backup restore")
        let restored=String(((try await js("location.hash")) as! String).split(separator:"/")[2])
        try await go(restored,"tally-source?review=gst")
        try await wait("window.__reviewCompany===\(literal(restored))&&window.__purchaseReview.summary.active===1&&document.querySelector('[data-tally-gst-rows]')?.getAttribute('aria-busy')==='false'","restored purchase activation")
        try await require("!document.querySelector('[data-tally-gst-select]')&&document.querySelector('[data-tally-gst-activate]').disabled","Restored purchase permits duplicate activation")
        try await click("[data-original-download]")
        try await waitDownload("source-original.xml")
        steps.append("Visible full Tally archive and company backup links saved native files; normal native backup import restored one active purchase with no activation selection and byte-exact source download")
        let missing=try await importCompany(fixture["missingSource"]!,"Synthetic missing supplier evidence")
        try await require("(()=>{const f=document.querySelector('[data-tally-gst-mapping]');return f.elements.supplierInvoiceNumber.value===''&&f.elements.supplierInvoiceDate.value===''&&f.elements.receivedDate.value===''&&f.elements.placeOfSupply.value===''&&f.elements.supplierInvoiceNumber.required&&f.elements.supplierInvoiceDate.required&&f.elements.placeOfSupply.required&&!document.querySelector('[data-tally-gst-select]');})()","Missing supplier/POS facts silently borrowed voucher or supplier-state values")
        _ = try await js("document.querySelector('[data-tally-gst-mapping]').closest('details').open=true;document.querySelector('[data-tally-gst-details]').open=true;document.querySelector('[data-tally-gst-mapping]').scrollIntoView({block:'start'});true")
        try await snapshot("purchase-missing-source.png")
        steps.append("A separate import with missing supplier number/date/POS left every review field empty and required, with no GST activation selection")
        try await go(fixture["tamperedCompany"]!,"tally-source?review=gst")
        try await wait("window.__reviewCompany===\(literal(fixture["tamperedCompany"]!))&&document.querySelector('[data-tally-gst-rows]')?.getAttribute('aria-busy')==='false'","edited source review")
        try await require("window.__purchaseReview.rows[0].type==='Purchase'&&window.__purchaseReview.rows[0].status==='blocked'&&document.querySelector('[data-tally-gst-type=Purchase]')&&!document.querySelector('[data-tally-gst-mapping]')&&!document.querySelector('[data-tally-gst-select]')","Edited accounting source remains activatable")
        steps.append("A separately imported Purchase with an edited narration remained labelled Purchase, blocked, and had no mapping or activation controls")
        try await require("window.__errors.length===0&&window.__creditPosts.length===0&&window.__activationPosts.length===1","Native purchase page errors or unexpected credit/duplicate activation")
        guard downloadErrors.isEmpty else{throw PurchaseUIFailure(description:"Native download errors: \(downloadErrors)")}
        let before=try await js("window.__beforePostings") as! [[String:Any]]
        let result:[String:Any]=["passed":true,"browser":"macOS WKWebView on disposable synthetic books","company":company,"missingCompany":missing,"tamperedCompany":fixture["tamperedCompany"]!,"nativePickerCalls":pickerCalls,"restoredCompany":restored,"downloads":finished,"activationRequests":1,"steps":steps,"beforePostings":before,"pageErrors":[],"creditActionsPosted":0]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-results.json"));window.close()
    }
    func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping([URL]?)->Void){pickerCalls+=1;completionHandler(picker.map{[$0]})}
    func waitDownload(_ name:String)async throws{let end=Date().addingTimeInterval(30);while !finished.contains(name)&&Date()<end{try await Task.sleep(nanoseconds:100_000_000)};guard finished.contains(name) else{throw PurchaseUIFailure(description:"Native file save failed: "+name)}}
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){if navigationAction.shouldPerformDownload{decisionHandler(.download)}else{decisionHandler(navigationAction.request.url?.host=="127.0.0.1" ? .allow : .cancel)}}
    func webView(_ webView:WKWebView,decidePolicyFor navigationResponse:WKNavigationResponse,decisionHandler:@escaping(WKNavigationResponsePolicy)->Void){decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)}
    func webView(_ webView:WKWebView,navigationAction:WKNavigationAction,didBecome download:WKDownload){downloads.append(download);download.delegate=self}
    func webView(_ webView:WKWebView,navigationResponse:WKNavigationResponse,didBecome download:WKDownload){downloads.append(download);download.delegate=self}
    func download(_ download:WKDownload,decideDestinationUsing response:URLResponse,suggestedFilename:String,completionHandler:@escaping(URL?)->Void){let name=response.url?.path.hasSuffix("/backup")==true ? "company-backup.json" : response.url?.path.hasSuffix("/archive")==true ? "tally-full-archive.json" : "source-original.xml";destinationNames[ObjectIdentifier(download)]=name;let file=output.appendingPathComponent(name);try? FileManager.default.removeItem(at:file);completionHandler(file)}
    func downloadDidFinish(_ download:WKDownload){if let name=destinationNames.removeValue(forKey:ObjectIdentifier(download)){finished.append(name)}}
    func download(_ download:WKDownload,didFailWithError error:Error,resumeData:Data?){downloadErrors.append(error.localizedDescription)}
}
try MainActor.assumeIsolated{let app=NSApplication.shared,runner=try PurchaseUIRunner(CommandLine.arguments[1]);app.delegate=runner;app.setActivationPolicy(.accessory);app.run()}
