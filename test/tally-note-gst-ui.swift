import AppKit
import WebKit
struct NoteUIFailure:Error,CustomStringConvertible{let description:String}
@MainActor final class NoteUIRunner:NSObject,NSApplicationDelegate,WKNavigationDelegate,WKUIDelegate{
    let fixture:[String:String],output:URL
    var web:WKWebView!,window:NSWindow!,started=false,picker:URL?,pickerCalls=0,steps:[String]=[]
    init(_ file:String)throws{fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:file))) as! [String:String];output=URL(fileURLWithPath:fixture["output"]!);super.init()}
    func applicationDidFinishLaunching(_ notification:Notification){
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        config.userContentController.addUserScript(WKUserScript(source:"""
        window.__errors=[];window.__mappingPosts=[];window.__activationPosts=[];window.__creditPosts=[];window.__manualPreviews=[];window.__manualInvoices=[];window.__originalLookups=[];window.__returnReports=[];window.__section34Posts=[];
        window.addEventListener('error',e=>window.__errors.push(e.message));const realFetch=window.fetch;
        window.fetch=async(u,o)=>{const url=new URL(typeof u==='string'?u:u.url,location.href);if(url.pathname.endsWith('/gst/mapping')&&o?.method==='POST')window.__mappingPosts.push(JSON.parse(o.body));if(url.pathname.endsWith('/gst/activate')&&o?.method==='POST')window.__activationPosts.push(JSON.parse(o.body));if(url.pathname.includes('/itc/')&&o?.method==='POST')window.__creditPosts.push(url.pathname);if(url.pathname.endsWith('/gst-returns/credit-review')&&o?.method==='POST')window.__section34Posts.push(JSON.parse(o.body));if(url.pathname.endsWith('/gst/invoices')&&o?.method==='POST')window.__manualInvoices.push(JSON.parse(o.body));const response=await realFetch(u,o);if(url.pathname.endsWith('/gst-returns')&&response.ok)window.__returnReports.push(await response.clone().json());if(url.pathname.endsWith('/gst/preview')&&response.ok)window.__manualPreviews.push({request:JSON.parse(o.body),response:await response.clone().json()});if(url.pathname.endsWith('/gst/originals')&&response.ok)window.__originalLookups.push({query:Object.fromEntries(url.searchParams),response:await response.clone().json()});if(/\\/api\\/tally\\/companies\\/[^/]+\\/gst$/.test(url.pathname)){window.__noteReview=await response.clone().json();window.__reviewCompany=url.pathname.split('/')[4];}return response;};
        """,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:NSRect(x:0,y:0,width:1440,height:1050),configuration:config);web.navigationDelegate=self;web.uiDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.contentView=web;window.title="Ledgercraft imported GST note review — synthetic books";window.orderFront(nil)
        web.load(URLRequest(url:URL(string:fixture["base"]!)!))
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){if started{return};started=true;Task{do{try await exercise();print("Native imported GST note review passed");exit(0)}catch{let body=(try? await js("document.body.innerText")) as? String ?? "";try? (String(describing:error)+"\n"+body).write(to:output.appendingPathComponent("failure.txt"),atomically:true,encoding:.utf8);try? await snapshot("failure.png");print("Native imported GST note review failed: \(error)");exit(1)}}}
    func literal(_ text:String)->String{String(String(data:try! JSONSerialization.data(withJSONObject:[text]),encoding:.utf8)!.dropFirst().dropLast())}
    func js(_ source:String)async throws->Any?{try await web.evaluateJavaScript(source)}
    func require(_ condition:String,_ label:String)async throws{guard (try await js(condition)) as? Bool==true else{throw NoteUIFailure(description:label)}}
    func wait(_ condition:String,_ label:String)async throws{let end=Date().addingTimeInterval(30);while Date()<end{if (try await js(condition)) as? Bool==true{return};try await Task.sleep(nanoseconds:100_000_000)};throw NoteUIFailure(description:"Timed out: "+label)}
    func fill(_ selector:String,_ value:String)async throws{try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;for(let d=e.closest('details');d;d=d.parentElement.closest('details'))d.open=true;e.value=\(literal(value));e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()","Missing field "+selector)}
    func click(_ selector:String)async throws{try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e||e.disabled)return false;for(let d=e.parentElement.closest('details');d;d=d.parentElement.closest('details'))if(e!==d.querySelector(':scope > summary'))d.open=true;e.focus();e.click();return true;})()","Missing/enabled control "+selector)}
    func snapshot(_ name:String)async throws{let shot=try await web.takeSnapshot(configuration:nil),bitmap=NSBitmapImageRep(data:shot.tiffRepresentation!)!;try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name))}
    func go(_ company:String,_ section:String)async throws{_ = try await js("location.hash="+literal("#/c/"+company+"/"+section))}
    func row(_ number:String)async throws->String{let id=try await js("window.__noteReview.rows.find(row=>row.number===\(literal(number))).recordId") as! String;return "[data-tally-gst-record=\"\(id)\"]"}
    func importArchive()async throws->String{
        _ = try await js("location.hash='#/tally-import';true")
        try await wait("!!document.querySelector('#tally-preview-form')","normal Tally archive import")
        picker=URL(fileURLWithPath:fixture["preparedArchive"]!);try await click("#tally-preview-form [name=files]")
        try await wait("document.querySelector('#tally-preview-form [name=files]').files.length===1","native archive picker")
        try await click("#tally-preview-form button");try await wait("!!document.querySelector('#tally-confirm')","native note archive preview")
        try await click("#tally-confirm input");try await click("#tally-confirm button")
        try await wait("location.hash.includes('/tally-source')&&window.__reviewCompany===location.hash.split('/')[2]&&document.querySelector('[data-tally-gst-rows]')?.getAttribute('aria-busy')==='false'","native note source review")
        return String(((try await js("location.hash")) as! String).split(separator:"/")[2].split(separator:"?")[0])
    }
    func exercise()async throws{
        let company=try await importArchive()
        try await require("window.__noteReview.summary.active===2&&window.__noteReview.originalInvoices.length===0&&window.__noteReview.originalInvoiceCount===2","Verified original invoice catalog missing")
        for (number,direction,legal,inventory) in [("CN-2","sales","Credit Note",true),("DN-7","sales","Debit Note",false),("PD-5","purchase","Credit Note",true),("PC-6","purchase","Debit Note",false)]{
            let selector=try await row(number)
            try await require("(()=>{const row=window.__noteReview.rows.find(r=>r.number===\(literal(number))),node=document.querySelector(\(literal(selector)));return row.source.note&&row.source.direction===\(literal(direction))&&row.source.type===\(literal(legal))&&row.source.noteInventory===\(inventory ? "true" : "false")&&node.querySelector('[data-tally-note-identity]').textContent.includes(\(literal(legal)))&&node.querySelector('[name=noteStockEffect]').value===''&&(\(inventory ? "node.querySelector('[name=noteStockEffect] [value=none]').disabled" : "!node.querySelector('[name=noteStockEffect] [value=quantity]')"));})()","Incorrect native/legal note role or automatic stock effect: "+number)
        }
        steps.append("All four native note cases display separate statutory roles: outward Credit/Debit; inward Tally Debit as supplier GST Credit and inward Tally Credit as supplier GST Debit; physical stock is never preselected")
        let purchase=try await row("PD-5")
        try await click(purchase+" [data-tally-gst-match-source]")
        try await wait("document.querySelector(\(literal(purchase+" [data-tally-gst-mapping]"))).dataset.originalLoading==='false'&&document.querySelector(\(literal(purchase+" [name=noteOriginalInvoiceId]"))).options.length>1","bounded original purchase lookup")
        let original=try await js("window.__noteReview.rows.find(i=>i.number==='P-48').voucherId") as! String
        try await fill(purchase+" [name=noteOriginalInvoiceId]",original)
        try await wait("document.querySelector(\(literal(purchase+" [data-tally-gst-mapping]"))).dataset.originalLoading==='false'&&document.querySelector(\(literal(purchase+" [name=noteLine-0]"))).options.length>1","selected original purchase detail")
        try await require("(()=>{const f=document.querySelector(\(literal(purchase+" [data-tally-gst-mapping]")));return f.elements.noteOriginalNumber.value==='INV/3103'&&f.elements.noteOriginalDate.value==='2026-03-31'&&f.elements.supplierNoteNumber.value==='SCN/9'&&f.elements.supplierNoteDate.value==='2026-04-09';})()","Original supplier identity/date or actual supplier Credit Note lost")
        try await fill(purchase+" [name=noteOriginalDate]","2026-03-30")
        try await require("document.querySelector(\(literal(purchase+" [name=\"sourceCorrection:originalDate\"]"))).required","Original invoice correction lacks evidence reason")
        try await fill(purchase+" [name=noteOriginalDate]","2026-03-31")
        try await fill(purchase+" [name=noteLine-0]","0")
        try await fill(purchase+" [name=noteOriginalSearch]","no-such-synthetic-invoice")
        try await click(purchase+" [data-search-note-originals]")
        try await wait("document.querySelector(\(literal(purchase+" [data-tally-gst-mapping]"))).dataset.originalLoading==='false'&&document.querySelector(\(literal(purchase+" [data-note-original-status]"))).textContent.includes('Selected original retained')","chosen original retained outside search")
        try await require("document.querySelector(\(literal(purchase+" [name=noteOriginalInvoiceId]"))).value===\(literal(original))&&document.querySelector(\(literal(purchase+" [name=noteLine-0]"))).value==='0'&&window.__originalLookups.every(r=>r.response.rows.length<=20&&r.response.rows.every(i=>!i.items&&!i.tallyOrigin))","Bounded original lookup lost selected draft or sent full snapshots")
        try await fill(purchase+" [name=noteOriginalSearch]","")
        try await click(purchase+" [data-search-note-originals]")
        try await wait("document.querySelector(\(literal(purchase+" [data-tally-gst-mapping]"))).dataset.originalLoading==='false'","cleared original search")
        try await fill(purchase+" [name=noteStockEffect]","quantity")
        for (role,name) in [("party","Deccan Fixture Vendor"),("purchase","Purchase"),("igst","Input IGST")]{let ledger=try await js("window.__noteReview.ledgers.find(l=>l.name===\(literal(name))).id") as! String;try await fill(purchase+" [name=account-\(role)]",ledger)}
        try await click(purchase+" [name=supplierDocumentConfirmed]");try await click(purchase+" [name=noteReviewed]")
        try await click(purchase+" [data-tally-gst-mapping] button[type=submit]")
        try await require("window.__mappingPosts.length===0&&document.querySelector(\(literal(purchase+" [name=evidenceName]"))).validity.valueMissing","Note mapping saved without named evidence")
        try await fill(purchase+" [name=evidenceName]","Synthetic supplier GST Credit Note SCN/9")
        try await fill(purchase+" [name=evidenceReference]","Synthetic SCN/9 09-04-2026 against INV/3103 31-03-2026; physical purchase return of one unit; no real business data")
        try await click(purchase+" [name=noteReviewed]")
        try await click(purchase+" [data-tally-gst-mapping] button[type=submit]")
        try await wait("window.__noteReview.rows.find(r=>r.number==='PD-5').status==='ready'&&document.querySelector('[data-tally-gst-rows]').getAttribute('aria-busy')==='false'","verified purchase return note ready")
        try await require("(()=>{const p=window.__mappingPosts[0];return p.noteReview.direction==='purchase'&&p.noteReview.originalInvoiceId===\(literal(original))&&p.noteReview.originalNumber==='INV/3103'&&p.noteReview.originalDate==='2026-03-31'&&p.noteReview.supplierNoteNumber==='SCN/9'&&p.noteReview.supplierNoteDate==='2026-04-09'&&p.noteReview.supplierDocumentConfirmed&&p.noteReview.stockEffect==='quantity'&&p.noteReview.lines.length===1&&p.noteReview.lines[0].sourceLineIndex===0&&p.noteReview.lines[0].originalLineIndex===0&&!p.purchaseReview;})()","Native note save payload lost explicit legal/original/stock review")
        _ = try await js("document.querySelector(\(literal(purchase+" [data-tally-note-identity]"))).scrollIntoView({block:'start'});true")
        try await snapshot("note-ready-wide.png")
        for width in [375,768,1024,1440]{window.setContentSize(NSSize(width:width,height:1050));try await wait("innerWidth===\(width)","note viewport");try await require("document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.tally-gst-review').scrollWidth<=document.querySelector('.tally-gst-review').clientWidth+1","Note source desk overflow");if width==375{_ = try await js("document.querySelector(\(literal(purchase+" [data-tally-note-identity]"))).scrollIntoView({block:'start'});true");try await snapshot("note-mobile.png");_ = try await js("document.querySelector(\(literal(purchase+" [data-tally-note-allocations]"))).scrollIntoView({block:'start'});true");try await snapshot("note-mobile-allocation.png")}}
        try await click(purchase+" [data-tally-gst-select]");try await click("[data-tally-gst-activate]")
        try await wait("window.__noteReview.summary.active===3&&document.querySelector('[data-tally-gst-summary]').textContent.includes('3 active')","one note activated")
        try await require("!document.querySelector(\(literal(purchase+" [data-tally-gst-mapping]")))&&document.querySelector(\(literal(purchase+" [data-tally-note-linked] a"))).getAttribute('href').endsWith('/'+\(literal(original)))&&window.__activationPosts.length===1&&document.querySelector('[data-tally-gst-activate]').disabled","Active note lost original linkage or permits repeat activation")
        try await click(purchase+" a[href*='/gst-document/']")
        try await wait("!!document.querySelector('.gst-document')","active statutory GST note")
        try await require("document.querySelector('h1').textContent.toLowerCase()==='credit note'&&document.querySelector('.gst-document').textContent.includes('SCN/9')&&document.querySelector('.gst-document').textContent.includes('INV/3103')","Native Debit displayed as incorrect statutory note or original reference lost")
        try await snapshot("note-active-document.png")
        try await go(company,"tally-source?review=gst")
        try await wait("window.__reviewCompany===\(literal(company))&&document.querySelector('[data-tally-gst-rows]')?.getAttribute('aria-busy')==='false'","saved note source review")
        steps.append("PD-5 linked to verified supplier INV/3103 dated31-03; actual supplier Credit Note SCN/9 dated09-04 confirmed with explicit original-line/physical-return allocation and evidence; one activation reopened a Credit Note and its original invoice")
        let financial=try await row("DN-7")
        try await click(financial+" [data-tally-gst-match-source]")
        try await wait("document.querySelector(\(literal(financial+" [data-tally-gst-mapping]"))).dataset.originalLoading==='false'&&document.querySelector(\(literal(financial+" [name=noteOriginalInvoiceId]"))).options.length>1","bounded original sale lookup")
        let sale=try await js("window.__noteReview.rows.find(i=>i.number==='S-10').voucherId") as! String
        try await fill(financial+" [name=noteOriginalInvoiceId]",sale)
        try await wait("document.querySelector(\(literal(financial+" [data-tally-gst-mapping]"))).dataset.originalLoading==='false'&&document.querySelector(\(literal(financial+" [name=noteLine-0]"))).options.length>1","selected original sale detail")
        try await fill(financial+" [name=noteStockEffect]","none")
        try await fill(financial+" [name=noteLine-0]","0")
        try await fill(financial+" [name=noteQuantity-0]","1")
        try await fill(financial+" [name=notePrice-0]","10")
        try await fill(financial+" [name=noteDiscount-0]","0")
        for (role,name) in [("party","Central Fixture Customer"),("sales","Domestic Sales"),("cgst","Output CGST"),("sgst","Output SGST")]{let ledger=try await js("window.__noteReview.ledgers.find(l=>l.name===\(literal(name))).id") as! String;try await fill(financial+" [name=account-\(role)]",ledger)}
        try await fill(financial+" [name=evidenceName]","Synthetic outward financial Debit Note")
        try await fill(financial+" [name=evidenceReference]","Synthetic DN-7 financial value increase of ten rupees against S-10; no stock movement")
        try await click(financial+" [name=noteReviewed]");try await click(financial+" [data-tally-gst-mapping] button[type=submit]")
        try await wait("window.__noteReview.rows.find(r=>r.number==='DN-7').status==='ready'&&document.querySelector('[data-tally-gst-rows]').getAttribute('aria-busy')==='false'","financial note explicit allocation ready")
        try await require("(()=>{const p=window.__mappingPosts.at(-1);return p.items.length===0&&p.noteReview.direction==='sales'&&p.noteReview.stockEffect==='none'&&p.noteReview.lines[0].originalLineIndex===0&&p.noteReview.lines[0].quantity==='1'&&p.noteReview.lines[0].unitPricePaise===1000&&p.noteReview.lines[0].discountBps===0;})()","Financial note inferred item/quantity or stock movement")
        _ = try await js("document.querySelector(\(literal(financial+" [data-tally-note-allocations]"))).scrollIntoView({block:'start'});true")
        try await snapshot("note-financial-allocation.png")
        steps.append("Outward financial DN-7 required an explicit original line, quantity and unit value at the saved original HSN/rate; mapping saved ready with no stock movement and was not activated")
        try await go(company,"gst-invoice")
        try await wait("!!document.querySelector('#gst-compose')","normal manual Credit Note form")
        try await fill("#gst-compose [name=type]","Credit Note")
        try await fill("#gst-compose [name=date]","2026-04-20")
        try await fill("#gst-compose [name=stockEffect]","none")
        try await fill("#gst-compose [name=originalInvoiceId]",sale)
        try await fill("#gst-compose [data-field=originalLineIndex]","0")
        try await fill("#gst-compose [data-field=quantity]","1")
        try await require("document.querySelector('.gst-item-code').textContent.includes('8541')&&document.querySelector('.gst-item-code').textContent.includes('NOS')&&document.querySelector('[data-field=gstRate]').value==='18'&&Number(document.querySelector('[data-field=unitPrice]').value)===150&&document.querySelector('[data-field=godownId]').disabled","Manual original-line selector substituted current HSN/rate/unit/price or goods movement")
        try await wait("!document.querySelector('[data-post-invoice]').disabled&&window.__manualPreviews.at(-1)?.response.invoice.type==='Credit Note'&&window.__manualPreviews.at(-1)?.response.invoice.totals.totalPaise===17700","manual historical financial Credit Note preview")
        try await require("(()=>{const p=window.__manualPreviews.at(-1);return p.request.stockEffect==='none'&&p.request.originalLineMap[0]===0&&!p.request.items[0].godownId&&p.response.invoice.originalInvoiceId===\(literal(sale))&&p.response.invoice.items[0].hsnSac==='8541'&&p.response.invoice.items[0].gstRateBps===1800&&p.response.invoice.items[0].unit==='NOS'&&p.response.invoice.items[0].unitPricePaise===15000;})()","Manual preview lost historical invoice line or created physical quantity")
        _ = try await js("document.querySelector('[name=originalInvoiceId]').closest('label').scrollIntoView({block:'start'});true")
        try await snapshot("manual-note-historical-wide.png")
        window.setContentSize(NSSize(width:375,height:1050));try await wait("innerWidth===375","manual Credit Note narrow viewport")
        try await require("document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('#gst-compose .gst-entry-table').closest('.table-scroll').getBoundingClientRect().right<=innerWidth+1","Manual Credit Note overflows narrow viewport")
        _ = try await js("document.querySelector('#gst-compose .gst-entry-table').closest('.table-scroll').scrollIntoView({block:'start'});true")
        try await require("(()=>{const box=document.querySelector('#gst-compose .gst-entry-table').closest('.table-scroll'),table=box.querySelector('table');return table.offsetWidth>=840&&box.scrollWidth>box.clientWidth&&box.clientWidth<=innerWidth})()","Narrow note editor must scroll horizontally with legible quantity and rate inputs")
        try await snapshot("manual-note-historical-mobile.png")
        window.setContentSize(NSSize(width:1440,height:1050));try await wait("innerWidth===1440","manual Credit Note wide viewport")
        try await go(company,"transfer");try await wait("!!document.querySelector('#book-import')","leave manual note draft")
        try await go(company,"gst-invoice");try await wait("!!document.querySelector('#gst-compose')&&document.querySelector('[data-draft-status]').textContent==='Saved draft restored'","manual note draft restored")
        try await require("document.querySelector('[name=type]').value==='Credit Note'&&document.querySelector('[name=stockEffect]').value==='none'&&document.querySelector('[name=originalInvoiceId]').value===\(literal(sale))&&document.querySelector('[data-field=originalLineIndex]').value==='0'&&document.querySelector('.gst-item-code').textContent.includes('8541')&&document.querySelector('.gst-item-code').textContent.includes('NOS')&&document.querySelector('[data-field=gstRate]').value==='18'&&Number(document.querySelector('[data-field=unitPrice]').value)===150","Restored manual note draft lost original historical line or financial-only stock choice")
        try await wait("!document.querySelector('[data-post-invoice]').disabled&&window.__manualPreviews.at(-1)?.response.invoice.stockEffect==='none'","restored financial Credit Note preview")
        let manualPreview=try await js("window.__manualPreviews.at(-1).response") as! [String:Any]
        try await require("window.__manualInvoices.length===0","Manual preview unexpectedly posted a new accounting note")
        steps.append("Normal New invoice→Credit Note→verified S-10→original line0 used historical HSN8541/rate18%/NOS/₹150 despite current catalog HSN9999/rate5%/₹900; financial-only preview ₹177 fit375px and retained original line/values/stock choice after draft restore")
        try await click("[data-post-invoice]")
        try await wait("location.hash.includes('/gst-document/')&&!!document.querySelector('.gst-document')","manual historical Credit Note posted")
        let manualId=try await js("location.hash.split('/')[4]") as! String
        try await require("window.__manualInvoices.length===1&&document.querySelector('h1').textContent.toLowerCase()==='credit note'","Manual note posting duplicated or showed wrong statutory type")
        try await go(company,"gst-returns?month=2026-04")
        try await wait("!!document.querySelector('#section34-note')&&window.__returnReports.at(-1)?.creditReviews.some(r=>r.id===\(literal(manualId)))","normal section34 credit note review")
        try await fill("#section34-note",manualId)
        try await require("document.querySelector('[data-section34-status]').textContent.includes('Held from return workings')&&window.__returnReports.at(-1).summary.outwardTaxable.taxablePaise===30000","Unreviewed outward credit already reduced working return")
        let beforeReturn=try await js("window.__returnReports.at(-1).summary.outwardTaxable") as! [String:Any]
        try await fill("[data-section34-review] [name=declarationDate]","2026-05-10")
        try await fill("[data-section34-review] [name=annualReturnStatus]","not-filed")
        try await fill("[data-section34-review] [name=recipientBasis]","not-availed")
        try await fill("[data-section34-review] [name=adjustmentGround]","excess-value-or-tax")
        try await click("[data-section34-review] [name=groundConfirmed]")
        try await fill("[data-section34-review] [name=reference]","Synthetic excess-value credit against S-10; recipient did not avail attributable credit; original FY annual return not filed")
        _ = try await js("document.querySelector('[data-section34]').scrollIntoView({block:'start'});true")
        try await snapshot("section34-held-review.png")
        try await require("getComputedStyle(document.querySelector('[data-annual-date]')).display==='none'","Unfiled annual return must hide its inapplicable filing date")
        try await click("[data-section34-review] button[type=submit]")
        try await wait("document.querySelector('[data-section34-status]')?.textContent.includes('Included in return workings')===true&&window.__returnReports.at(-1)?.creditReviews.find(r=>r.id===\(literal(manualId)))?.eligible===true","section34 held credit eligible after saved evidence")
        try await require("(()=>{const report=window.__returnReports.at(-1),row=report.creditReviews.find(r=>r.id===\(literal(manualId)));return window.__section34Posts.length===1&&row.review.declarationDate==='2026-05-10'&&row.review.annualReturnStatus==='not-filed'&&row.review.recipientBasis==='not-availed'&&row.review.adjustmentGround==='excess-value-or-tax'&&row.review.groundConfirmed===true&&row.review.reference.includes('Synthetic excess-value credit')&&report.summary.outwardTaxable.taxablePaise===15000&&report.summary.outwardTaxable.cgstPaise===1350&&report.summary.outwardTaxable.sgstPaise===1350;})()","Saved section34 evidence or working return reduction lost")
        _ = try await js("document.querySelector('[data-section34]').scrollIntoView({block:'start'});true")
        try await snapshot("section34-eligible-review.png")
        var section34=try await js("({before:window.__returnReports[window.__returnReports.length-2].summary.outwardTaxable,after:window.__returnReports.at(-1).summary.outwardTaxable,review:window.__returnReports.at(-1).creditReviews.find(r=>r.id===\(literal(manualId))).review})") as! [String:Any]
        section34["before"]=beforeReturn
        steps.append("Normal GST returns desk held the new registered-customer outward credit until declaration10-05/annual-not-filed/not-availed/excess-value-or-tax confirmation evidence was saved; then marked Included and reduced working outward taxable₹300→₹150 and CGST/SGST₹27→₹13.50, without filing any return")
        try await require("window.__errors.length===0&&window.__creditPosts.length===0&&window.__activationPosts.length===1","Page errors, unexpected credit actions or double activation")
        let payloads=try await js("window.__mappingPosts") as! [[String:Any]]
        let result:[String:Any]=["passed":true,"browser":"macOS WKWebView on isolated synthetic books","company":company,"nativePickerCalls":pickerCalls,"activationRequests":1,"mappingRequests":payloads,"manualPreview":manualPreview,"manualInvoicesPosted":1,"manualCreditId":manualId,"section34":section34,"creditActionsPosted":0,"steps":steps,"pageErrors":[]]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-results.json"));window.close()
    }
    func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping([URL]?)->Void){pickerCalls+=1;completionHandler(picker.map{[$0]})}
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){decisionHandler(navigationAction.request.url?.host=="127.0.0.1" ? .allow : .cancel)}
}
try MainActor.assumeIsolated{let app=NSApplication.shared,runner=try NoteUIRunner(CommandLine.arguments[1]);app.delegate=runner;app.setActivationPolicy(.accessory);app.run()}
