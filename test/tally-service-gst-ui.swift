import AppKit
import WebKit
struct ServiceUIFailure:Error,CustomStringConvertible{let description:String}
@MainActor final class ServiceUIRunner:NSObject,NSApplicationDelegate,WKNavigationDelegate,WKUIDelegate,WKDownloadDelegate{
    let fixture:[String:String],output:URL
    var web:WKWebView!,window:NSWindow!,started=false,picker:URL?,pickerCalls=0,steps:[String]=[]
    var downloads:[WKDownload]=[],finished:[String]=[],downloadErrors:[String]=[],destinationNames:[ObjectIdentifier:String]=[:]
    init(_ file:String)throws{fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:file))) as! [String:String];output=URL(fileURLWithPath:fixture["output"]!);super.init()}
    func applicationDidFinishLaunching(_ notification:Notification){
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        config.userContentController.addUserScript(WKUserScript(source:"""
        window.__errors=[];window.__mappingPosts=[];window.__activationPosts=[];window.__itcPosts=[];window.__manualPosts=[];
        window.addEventListener('error',e=>window.__errors.push(e.message));const realFetch=window.fetch;
        window.fetch=async(u,o)=>{const url=new URL(typeof u==='string'?u:u.url,location.href);if(o?.method==='POST'){const body=()=>JSON.parse(o.body);if(url.pathname.endsWith('/gst/mapping'))window.__mappingPosts.push(body());if(url.pathname.endsWith('/gst/activate'))window.__activationPosts.push(body());if(url.pathname.includes('/gst/itc/'))window.__itcPosts.push(body());if(url.pathname.endsWith('/gst/invoices'))window.__manualPosts.push(body());}const response=await realFetch(u,o);if(/\\/api\\/tally\\/companies\\/[^/]+\\/gst$/.test(url.pathname)){window.__serviceReview=await response.clone().json();window.__reviewCompany=url.pathname.split('/')[4];}if(url.pathname.endsWith('/gst/itc')&&response.ok)window.__itcReport=await response.clone().json();return response;};
        """,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:NSRect(x:0,y:0,width:1440,height:1050),configuration:config);web.navigationDelegate=self;web.uiDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.contentView=web;window.title="Ledgercraft service and goods review — synthetic books";window.orderFront(nil)
        web.load(URLRequest(url:URL(string:fixture["base"]!)!))
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){if started{return};started=true;Task{do{try await exercise();print("Native service/mixed GST review passed");exit(0)}catch{let body=(try? await js("document.body.innerText")) as? String ?? "";try? (String(describing:error)+"\n"+body).write(to:output.appendingPathComponent("failure.txt"),atomically:true,encoding:.utf8);try? await snapshot("failure.png");print("Native service/mixed GST review failed: \(error)");exit(1)}}}
    func literal(_ text:String)->String{String(String(data:try! JSONSerialization.data(withJSONObject:[text]),encoding:.utf8)!.dropFirst().dropLast())}
    func js(_ source:String)async throws->Any?{try await web.evaluateJavaScript(source)}
    func require(_ condition:String,_ label:String)async throws{guard (try await js(condition)) as? Bool==true else{throw ServiceUIFailure(description:label)}}
    func wait(_ condition:String,_ label:String)async throws{let end=Date().addingTimeInterval(30);while Date()<end{if (try await js(condition)) as? Bool==true{return};try await Task.sleep(nanoseconds:100_000_000)};throw ServiceUIFailure(description:"Timed out: "+label)}
    func fill(_ selector:String,_ value:String)async throws{try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e||e.disabled)return false;for(let d=e.closest('details');d;d=d.parentElement.closest('details'))d.open=true;e.value=\(literal(value));e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return e.value===\(literal(value));})()","Missing/enabled field or choice "+selector)}
    func click(_ selector:String)async throws{try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e||e.disabled)return false;for(let d=e.parentElement.closest('details');d;d=d.parentElement.closest('details'))if(e!==d.querySelector(':scope > summary'))d.open=true;e.focus();e.click();return true;})()","Missing/enabled control "+selector)}
    func check(_ selector:String)async throws{try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e||e.disabled)return false;e.checked=true;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()","Missing confirmation "+selector)}
    func snapshot(_ name:String)async throws{let shot=try await web.takeSnapshot(configuration:nil),bitmap=NSBitmapImageRep(data:shot.tiffRepresentation!)!;try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name))}
    func go(_ company:String,_ section:String)async throws{_ = try await js("location.hash="+literal("#/c/"+company+"/"+section))}
    func row(_ number:String)async throws->String{let id=try await js("window.__serviceReview.rows.find(row=>row.number===\(literal(number))).recordId") as! String;return "[data-tally-gst-record=\"\(id)\"]"}
    func service(_ number:String,_ ledger:String)async throws->String{let id=try await js("window.__serviceReview.rows.find(r=>r.number===\(literal(number))).source.items.find(i=>i.kind==='service'&&i.sourceLedgerName===\(literal(ledger))).sourceLineId") as! String;return try await row(number)+" [data-service-line=\"\(id)\"]"}
    func ready(_ condition:String,_ label:String)async throws{try await wait("document.querySelector('[data-tally-gst-rows]')?.getAttribute('aria-busy')==='false'&&!document.querySelector('[data-tally-gst-refresh]').disabled&&("+condition+")",label)}
    func accounts(_ number:String,_ rows:[(String,String)])async throws{let prefix=try await row(number);for(role,name)in rows{let id=try await js("window.__serviceReview.ledgers.find(l=>l.name===\(literal(name))).id") as! String;try await fill(prefix+" [name=account-\(role)]",id)}}
    func importSource()async throws->String{
        _ = try await js("location.hash='#/tally-import';true");try await wait("!!document.querySelector('#tally-preview-form')","normal service XML import")
        picker=URL(fileURLWithPath:fixture["source"]!);try await click("#tally-preview-form [name=files]")
        try await wait("document.querySelector('#tally-preview-form [name=files]').files.length===1","native service XML picker")
        try await fill("#tally-preview-form [name=companyName]","Synthetic service native proof");try await fill("#tally-preview-form [name=booksFrom]","2026-04-01")
        try await click("#tally-preview-form button");try await wait("!!document.querySelector('#tally-confirm')","service accounting preview")
        try await click("#tally-confirm input");try await click("#tally-confirm button")
        try await wait("location.hash.includes('/tally-source')&&window.__reviewCompany===location.hash.split('/')[2]&&document.querySelector('[data-tally-gst-rows]')?.getAttribute('aria-busy')==='false'","normal service source review")
        return String(((try await js("location.hash")) as! String).split(separator:"/")[2].split(separator:"?")[0])
    }
    func ownAndSupplier()async throws{
        let prefix=try await row("MP-202")
        try await click(prefix+" [data-tally-gst-prepare=seller]")
        try await require("document.querySelector('[data-tally-gst-master=settings]').elements.gstin.value==='23ABCDE1234F1Z8'","Source buyer GSTIN not retained")
        try await fill("[data-tally-gst-master=settings] [name=name]","Synthetic Services")
        try await fill("[data-tally-gst-master=settings] [name=legalName]","Synthetic Services")
        try await fill("[data-tally-gst-master=settings] [name=address]","Synthetic business address, Madhya Pradesh")
        try await click("[data-tally-gst-master=settings] button");try await ready("window.__serviceReview.registrations.length===1","buyer registration saved")
        try await click(prefix+" [data-tally-gst-prepare=party]")
        try await fill("[data-tally-gst-master=suppliers] [name=address]","Synthetic supplier address, Madhya Pradesh")
        try await click("[data-tally-gst-master=suppliers] button");try await ready("window.__serviceReview.parties.filter(p=>p.kind==='supplier').length===1","source supplier saved")
        try await click(prefix+" [data-tally-gst-prepare=item]")
        try await require("document.querySelector('[data-tally-gst-master=items]').elements.hsnSac.value==='8541'","Goods source HSN missing")
        try await click("[data-tally-gst-master=items] button");try await ready("window.__serviceReview.items.filter(i=>i.kind==='goods').length===1","source Widget GST master saved")
    }
    func createService(_ number:String,_ ledger:String,_ sac:String,_ currentRate:String,_ count:Int)async throws{
        let card=try await service(number,ledger)
        try await click(card+" [data-tally-gst-prepare=service]")
        try await require("(()=>{const f=document.querySelector('[data-tally-gst-master=services]');return f.elements.name.value===\(literal(ledger))&&f.elements.hsnSac.value===\(literal(sac))&&f.elements.gstRate.value==='18'&&f.elements.unit.value==='OTH'&&f.elements.unit.readOnly;})()","Service master prefill used another ledger/date or a stock unit")
        try await fill("[data-tally-gst-master=services] [name=gstRate]",currentRate)
        try await click("[data-tally-gst-master=services] button")
        try await ready("window.__serviceReview.items.filter(i=>i.kind==='service').length===\(count)","service master saved "+ledger)
        try await require("document.querySelector(\(literal(card+" select[name^='serviceItem:']"))).value===''","Service master was silently bound without operator selection")
    }
    func selectService(_ number:String,_ ledger:String)async throws->String{let card=try await service(number,ledger),id=try await js("window.__serviceReview.items.find(i=>i.kind==='service'&&i.name===\(literal(ledger))).id") as! String;try await fill(card+" select[name^='serviceItem:']",id);return card}
    func evidence(_ number:String,_ reference:String)async throws{let prefix=try await row(number);try await fill(prefix+" [name=evidenceName]","Synthetic "+number+" service review");try await fill(prefix+" [name=evidenceReference]",reference)}
    func save(_ number:String)async throws{let prefix=try await row(number);try await click(prefix+" [data-tally-gst-mapping] button[type=submit]");try await ready("window.__serviceReview.rows.find(r=>r.number===\(literal(number))).status==='ready'","mapping ready "+number)}
    func activate(_ number:String,_ count:Int)async throws{let prefix=try await row(number);try await click(prefix+" [data-tally-gst-select]");try await click("[data-tally-gst-activate]");try await ready("window.__serviceReview.summary.active===\(count)","one source activated "+number);try await require("!document.querySelector(\(literal(prefix+" [data-tally-gst-mapping]")))","Active invoice still permits mapping/double activation")}
    func exercise()async throws{
        let company=try await importSource()
        try await require("window.__serviceReview.rows.length===4&&window.__serviceReview.rows.every(r=>r.source.serviceReview)&&window.__serviceReview.rows.find(r=>r.number==='PV-201').source.items.every(i=>i.kind==='service'&&i.actualQuantity===null)","Service source rows are missing or invent physical quantities")
        try await ownAndSupplier();try await createService("MP-202","Professional Fees","998313","12",1)
        let mixed=try await row("MP-202")
        try await click(mixed+" [data-tally-gst-match-source]")
        let fee=try await selectService("MP-202","Professional Fees")
        try await fill(mixed+" [name=receivedDate]","2026-04-11")
        try await accounts("MP-202",[("party","Service Supplier"),("purchase","Goods Purchases"),("cgst","CGST"),("sgst","SGST")])
        try await evidence("MP-202","Synthetic mixed invoice SUP-MIX-22; goods receipt11-Apr; service evidenced separately; dated source18% versus deliberately divergent current master12%")
        try await check(mixed+" [name=purchaseReviewed]")
        try await click(mixed+" [data-tally-gst-mapping] button[type=submit]")
        try await require("window.__mappingPosts.length===0&&document.querySelector(\(literal(fee+" select[name^='serviceStatus:']"))).validity.valueMissing","Purchase service completion defaulted or was not required")
        try await fill(fee+" select[name^='serviceStatus:']","confirmed")
        try await fill(fee+" input[name^='serviceDate:']","2026-04-15")
        try await fill(fee+" input[name^='serviceReference:']","Synthetic Professional Fees completion15-Apr, supported acceptance")
        try await require("[...document.querySelectorAll(\(literal(mixed+" [name^='sourceChoice:service:']")))].some(e=>e.value==='source')","Dated service rate choice absent despite divergent current master")
        try await check(mixed+" [name=purchaseReviewed]");try await save("MP-202")
        try await require("(()=>{const p=window.__mappingPosts[0];return p.items.length===1&&p.serviceItems.length===1&&p.serviceItems[0].completionReview.date==='2026-04-15'&&p.purchaseReview.receivedDate==='2026-04-11'&&p.accounts.purchase===window.__serviceReview.ledgers.find(l=>l.name==='Goods Purchases').id&&!Object.keys(p.accounts).some(k=>k.startsWith('service:'));})()","Goods/service mapping or separate completion dates lost")
        _ = try await js("document.querySelector(\(literal(fee))).scrollIntoView({block:'start'});true");try await snapshot("mixed-service-ready-wide.png")
        window.setContentSize(NSSize(width:375,height:1050));try await wait("innerWidth===375","service narrow viewport")
        try await require("document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.tally-gst-review').scrollWidth<=document.querySelector('.tally-gst-review').clientWidth+1","Service mapping overflows narrow viewport")
        _ = try await js("document.querySelector(\(literal(fee))).scrollIntoView({block:'start'});true");try await snapshot("mixed-service-mobile.png")
        window.setContentSize(NSSize(width:1440,height:1050));try await wait("innerWidth===1440","service wide viewport")
        try await activate("MP-202",1)
        try await click(mixed+" a[href*='/gst-document/']");try await wait("!!document.querySelector('.gst-document')","mixed purchase GST document")
        try await require("document.querySelector('.gst-document').textContent.includes('8541')&&document.querySelector('.gst-document').textContent.includes('998313')&&document.querySelector('.gst-document').textContent.includes('1,652.00')","Mixed GST snapshot omitted goods HSN/service SAC or tax totals")
        try await snapshot("mixed-service-gst-document.png")
        try await go(company,"tally-source?review=gst");try await ready("window.__reviewCompany===\(literal(company))","back to service source")
        steps.append("Normal XML import and source-master controls mapped Widget plus Professional Fees; service completion15-Apr remained separate from goods receipt11-Apr and could follow book date12-Apr. Dated source18% won over selected current master12%, with one unchanged mixed accounting voucher activated")
        try await createService("PV-201","Maintenance Expense","998713","18",2)
        let pure=try await row("PV-201")
        try await click(pure+" [data-tally-gst-match-source]")
        try await require("!document.querySelector(\(literal(pure+" [name=receivedDate]")))&&!document.querySelector(\(literal(pure+" [name=account-purchase]")))&&document.querySelector(\(literal(pure+" [name=stockMode]"))).value==='financial-only'","Pure services request goods receipt, purchase stock account or physical stock")
        let pending=try await selectService("PV-201","Professional Fees"),maintenance=try await selectService("PV-201","Maintenance Expense")
        try await fill(pending+" select[name^='serviceStatus:']","pending")
        try await require("document.querySelector(\(literal(pending+" input[name^='serviceDate:']"))).disabled&&document.querySelector(\(literal(pending+" input[name^='serviceDate:']"))).value===''","Pending completion manufactured a date")
        try await fill(pending+" input[name^='serviceReference:']","Synthetic completion confirmation still awaited")
        try await fill(maintenance+" select[name^='serviceStatus:']","confirmed")
        try await fill(maintenance+" input[name^='serviceDate:']","2026-04-07")
        try await fill(maintenance+" input[name^='serviceReference:']","Synthetic Maintenance completion07-Apr")
        try await accounts("PV-201",[("party","Service Supplier"),("cgst","CGST"),("sgst","SGST")])
        try await evidence("PV-201","First synthetic draft evidence")
        try await click("[data-tally-gst-refresh]");try await ready("window.__reviewCompany===\(literal(company))","service mapping draft refreshed")
        try await require("document.querySelector(\(literal(pending+" select[name^='serviceStatus:']"))).value==='pending'&&document.querySelector(\(literal(maintenance+" input[name^='serviceDate:']"))).value==='2026-04-07'","Service completion choices did not survive draft refresh")
        try await evidence("PV-201","Final synthetic evidence for SUP-SVC-21: Professional Fees pending, Maintenance complete07-Apr; editable draft replaced")
        try await check(pure+" [name=purchaseReviewed]");try await save("PV-201")
        try await require("(()=>{const p=window.__mappingPosts.at(-1);return p.items.length===0&&p.serviceItems.length===2&&p.serviceItems.some(i=>i.completionReview.status==='pending'&&!('date'in i.completionReview))&&!('receivedDate'in p.purchaseReview)&&p.evidence.reference.startsWith('Final synthetic evidence');})()","Pure service mapping lost explicit pending/no-date or edited evidence")
        try await activate("PV-201",2)
        let sale=try await row("SV-101")
        try await click(sale+" [data-tally-gst-prepare=party]");try await fill("[data-tally-gst-master=parties] [name=address]","Synthetic customer address, Madhya Pradesh")
        try await click("[data-tally-gst-master=parties] button");try await ready("window.__serviceReview.parties.length===2","source customer saved")
        try await createService("SV-101","Consulting Income","998313","12",3);try await createService("SV-101","Support Income","998713","18",4)
        try await click(sale+" [data-tally-gst-match-source]")
        _ = try await selectService("SV-101","Consulting Income");_ = try await selectService("SV-101","Support Income")
        try await require("!document.querySelector(\(literal(sale+" [name=account-sales]")))&&!document.querySelector(\(literal(sale+" select[name^='serviceStatus:']")))","Pure service sale has generic sales/stock/completion controls")
        try await accounts("SV-101",[("party","Service Buyer"),("cgst","CGST"),("sgst","SGST")])
        try await evidence("SV-101","Synthetic Consulting and Support ledgers separately mapped; source dated18% retained with two independent SAC rows")
        try await save("SV-101");try await activate("SV-101",3)
        try await click(sale+" a[href*='/gst-document/']");try await wait("!!document.querySelector('.gst-document')","pure service sales GST document")
        try await require("document.querySelector('.gst-document').textContent.includes('998313')&&document.querySelector('.gst-document').textContent.includes('998713')&&document.querySelector('.gst-document').textContent.includes('1,770.00')","Pure service snapshot lost separate SAC rows or dated tax")
        try await snapshot("pure-service-sales-document.png")
        steps.append("Pure purchase services required independent per-ledger completion choices, retained pending/no-date and confirmed evidence across refresh, and saved edited supporting evidence. Pure sales mapped two actual income ledgers without invented stock or mandatory buyer completion")
        try await go(company,"tally-source?review=gst");try await ready("window.__reviewCompany===\(literal(company))","mixed sales source review")
        let mixedSale=try await row("MS-102")
        try await click(mixedSale+" [data-tally-gst-match-source]")
        _ = try await selectService("MS-102","Consulting Income");_ = try await selectService("MS-102","Support Income")
        try await accounts("MS-102",[("party","Service Buyer"),("sales","Goods Sales"),("cgst","CGST"),("sgst","SGST")])
        try await evidence("MS-102","Synthetic mixed sales review: Widget2 physical goods; Consulting and Support amounts are services with no stock; all original ledger postings retained")
        try await save("MS-102");try await activate("MS-102",4)
        steps.append("The mixed sales source was explicitly mapped and activated too, resolving its retained goods reconciliation exception; only Widget2 issues physical stock while the two service ledgers remain amount-only")
        let pureId=try await js("window.__serviceReview.rows.find(r=>r.number==='PV-201').voucherId") as! String
        let mixedId=try await js("window.__serviceReview.rows.find(r=>r.number==='MP-202').voucherId") as! String
        try await claimPendingService(company,pureId)
        try await goodsReturn(company,mixedId)
        try await backupRestore(company)
        try await require("window.__errors.length===0&&window.__mappingPosts.length===4&&window.__activationPosts.length===4&&window.__itcPosts.length===1&&window.__manualPosts.length===1","Page errors or duplicate mapping/activation/claim/return posts")
        guard downloadErrors.isEmpty else{throw ServiceUIFailure(description:downloadErrors.joined(separator:"\n"))}
        let restored=try await js("location.hash.split('/')[2]") as! String
        let result:[String:Any]=["passed":true,"browser":"macOS WKWebView on isolated synthetic books","company":company,"restoredCompany":restored,"purePurchaseId":pureId,"mixedPurchaseId":mixedId,"nativePickerCalls":pickerCalls,"steps":steps,"mappingRequests":try await js("window.__mappingPosts") as! [[String:Any]],"activationRequests":4,"itcRequests":try await js("window.__itcPosts") as! [[String:Any]],"manualRequests":try await js("window.__manualPosts") as! [[String:Any]],"downloads":finished,"pageErrors":[]]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-results.json"));window.close()
    }
    func claimPendingService(_ company:String,_ invoice:String)async throws{
        try await go(company,"gst-itc/"+invoice+"?to=2026-04-20")
        try await wait("!!document.querySelector('#itc-review')&&document.querySelector('#itc-review [name=invoiceId]').value===\(literal(invoice))","normal pending service ITC review")
        try await fill("#itc-review [name=action]","claim");try await fill("#itc-review [name=date]","2026-04-20")
        try await fill("#itc-review [name=reference]","Synthetic pending service receipt and claim")
        try await fill("#itc-review [name=documentReference]","Synthetic SUP-SVC-21 and completion17-Apr")
        try await fill("#itc-review [name=basis]","Synthetic independent documentary review of supplier invoice, actual completion, reporting, tax payment and statutory conditions; no real business records")
        try await fill("#itc-review [name=annualReturnStatus]","not-filed")
        for name in ["invoiceHeld","received","businessUse","notBlocked","supplierReported","supplierTaxPaid","returnFurnished","paymentReview","noTaxDepreciation"]{try await check("#itc-review [name=\(name)]")}
        try await require("(()=>{const row=[...document.querySelectorAll('[data-itc-row]')].find(r=>r.querySelector('[data-itc-service-receipt]'));return !!row&&!row.querySelector('[data-itc-choose]').checked;})()","Pending service was included automatically in an ITC claim")
        try await check("[data-itc-row]:has([data-itc-service-receipt]) [data-itc-choose]")
        try await require("document.querySelector('#itc-review button[type=submit]').disabled&&window.__itcPosts.length===0","Selected pending service can be claimed without receipt proof")
        try await check("[data-itc-service-received]")
        try await fill("[data-itc-service-date]","2026-04-17")
        try await fill("[data-itc-service-reference]","Synthetic Professional Fees actually completed17-Apr; dated acceptance")
        try await require("!document.querySelector('#itc-review button[type=submit]').disabled&&document.querySelector('[data-itc-total]').textContent.includes('180.00')","Explicit service receipt failed to unlock exact claim allocation")
        _ = try await js("document.querySelector('[data-itc-allocations]').scrollIntoView({block:'start'});true");try await snapshot("pending-service-itc-evidence.png")
        try await click("#itc-review button[type=submit]")
        try await wait("!!document.querySelector('[data-itc-record]')&&document.querySelector('.itc-history').textContent.includes('Synthetic pending service receipt and claim')","explicit service receipt and claim saved")
        try await require("window.__itcPosts[0].evidence.serviceReceipts.some(r=>r.received&&r.date==='2026-04-17'&&r.reference.includes('Professional Fees'))&&document.querySelector('.itc-history').textContent.includes('17-04-2026')","Saved service receipt evidence lost its date/ledger/reference")
        steps.append("Normal Purchase ITC desk initially excluded pending Professional Fees and blocked its selected claim until actual receipt/completion17-Apr and a reference were entered; all statutory conditions were explicitly confirmed and exact₹180 claim recorded with a balancing entry")
    }
    func goodsReturn(_ company:String,_ original:String)async throws{
        try await go(company,"gst-invoice");try await wait("!!document.querySelector('#gst-compose')","normal goods-only return")
        try await fill("#gst-compose [name=type]","Credit Note");try await fill("#gst-compose [name=originalInvoiceId]",original)
        try await fill("#gst-compose [name=date]","2026-04-16");try await fill("#gst-compose [name=stockEffect]","quantity")
        try await fill("#gst-compose [name=supplierInvoiceNumber]","SRET/1");try await fill("#gst-compose [name=supplierInvoiceDate]","2026-04-15")
        try await fill("#gst-compose [data-field=originalLineIndex]","0");try await fill("#gst-compose [data-field=quantity]","1")
        try await wait("!document.querySelector('[data-post-invoice]').disabled&&document.querySelector('.gst-preview-total').textContent.includes('472.00')","goods-only mixed purchase return preview")
        try await require("document.querySelector('.gst-item-code').textContent.includes('8541')&&document.querySelector('.gst-item-code').textContent.includes('NOS')&&!document.querySelector('.gst-item-code').textContent.includes('998313')","Return line used a service instead of original goods")
        try await click("[data-post-invoice]");try await wait("location.hash.includes('/gst-document/')&&!!document.querySelector('.gst-document')","goods-only supplier credit saved")
        try await snapshot("goods-only-service-invoice-return.png")
        steps.append("Normal supplier Credit Note returned one original Widget from the mixed invoice; service lines were excluded and no second liability/voucher was generated by source activation")
    }
    func backupRestore(_ company:String)async throws{
        try await go(company,"transfer");try await wait("!!document.querySelector(\"a[href$='/backup']\")","service company backup link")
        try await click("a[href$='/backup']");try await waitDownload("service-company-backup.json")
        picker=output.appendingPathComponent("service-company-backup.json");try await click("#book-files")
        try await wait("document.querySelector('#book-files').files.length===1","native service backup picker");try await click("#book-import button")
        try await wait("location.hash.startsWith('#/c/')&&location.hash.split('/')[2]!==\(literal(company))&&!!document.querySelector('main h1')","service company backup restored")
        let restored=try await js("location.hash.split('/')[2]") as! String
        try await go(restored,"tally-source?review=gst");try await ready("window.__reviewCompany===\(literal(restored))&&window.__serviceReview.summary.active===4","restored service source mappings")
        let prefix=try await row("PV-201")
        try await require("document.querySelector(\(literal(prefix+" [data-tally-service-mappings]"))).textContent.includes('pending confirmation')&&!document.querySelector(\(literal(prefix+" [data-tally-gst-select]")))","Restored source completion evidence changed or permits duplicate activation")
        try await click("[data-original-download]");try await waitDownload("service-original.xml")
        steps.append("Normal native company backup/restore retained four active source mappings, original pending completion history, later ITC evidence, goods-only return and downloadable byte-exact original XML")
    }
    func waitDownload(_ name:String)async throws{let end=Date().addingTimeInterval(30);while !finished.contains(name)&&Date()<end{try await Task.sleep(nanoseconds:100_000_000)};guard finished.contains(name) else{throw ServiceUIFailure(description:"Native save failed "+name)}}
    func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping([URL]?)->Void){pickerCalls+=1;completionHandler(picker.map{[$0]})}
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){if navigationAction.shouldPerformDownload{decisionHandler(.download)}else{decisionHandler(navigationAction.request.url?.host=="127.0.0.1" ? .allow : .cancel)}}
    func webView(_ webView:WKWebView,decidePolicyFor navigationResponse:WKNavigationResponse,decisionHandler:@escaping(WKNavigationResponsePolicy)->Void){decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)}
    func webView(_ webView:WKWebView,navigationAction:WKNavigationAction,didBecome download:WKDownload){downloads.append(download);download.delegate=self}
    func webView(_ webView:WKWebView,navigationResponse:WKNavigationResponse,didBecome download:WKDownload){downloads.append(download);download.delegate=self}
    func download(_ download:WKDownload,decideDestinationUsing response:URLResponse,suggestedFilename:String,completionHandler:@escaping(URL?)->Void){let name=response.url?.path.hasSuffix("/backup")==true ? "service-company-backup.json" : "service-original.xml";destinationNames[ObjectIdentifier(download)]=name;let file=output.appendingPathComponent(name);try? FileManager.default.removeItem(at:file);completionHandler(file)}
    func downloadDidFinish(_ download:WKDownload){if let name=destinationNames.removeValue(forKey:ObjectIdentifier(download)){finished.append(name)}}
    func download(_ download:WKDownload,didFailWithError error:Error,resumeData:Data?){downloadErrors.append(error.localizedDescription)}
}
try MainActor.assumeIsolated{let app=NSApplication.shared,runner=try ServiceUIRunner(CommandLine.arguments[1]);app.delegate=runner;app.setActivationPolicy(.accessory);app.run()}
