import AppKit
import WebKit

struct TallyGstFailure: Error, CustomStringConvertible { let description:String }
@MainActor final class TallyGstRunner: NSObject,NSApplicationDelegate,WKNavigationDelegate,WKUIDelegate,WKDownloadDelegate {
    let fixture:[String:String]
    let output:URL
    var web:WKWebView!
    var window:NSWindow!
    var started=false
    var picker:URL?
    var extraPicker:URL?
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
        config.userContentController.addUserScript(WKUserScript(source:"""
        window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));
        const nativeFetch=window.fetch;
        window.__tallyPreviewRequest=0;window.__tallyCommitRequests=0;window.__pagingWrites=0;window.__pagingQueries=[];
        window.fetch=async(u,o)=>{
          const url=new URL(typeof u==='string'?u:u.url,location.href),isPreview=url.pathname.endsWith('/tally/preview'),request=isPreview?++window.__tallyPreviewRequest:0;
          if(url.pathname.endsWith('/tally/commit'))window.__tallyCommitRequests++;
          if(window.__pagedGstRows&&url.pathname.includes('/gst/')&&o?.method&&!['GET','HEAD'].includes(o.method)){window.__pagingWrites++;throw new Error('Synthetic paging fixture cannot write books');}
          let r=await nativeFetch(u,o);
          if(window.__pagedGstRows&&/\\/api\\/tally\\/companies\\/[^/]+\\/gst$/.test(url.pathname)&&url.searchParams.get('view')==='desk'){
            const data=await r.clone().json(),q=(url.searchParams.get('q')||'').toLowerCase(),offset=Number(url.searchParams.get('offset')||0),all=window.__pagedGstRows.filter(row=>!q||(row.number+' '+row.source.partyName).toLowerCase().includes(q));
            window.__pagingQueries.push({q,offset});
            r=new Response(JSON.stringify({...data,rows:all.slice(offset,offset+20),page:{offset,limit:20,total:all.length},summary:{...data.summary,sourceInvoices:25,ready:25,active:0,blocked:0}}),{status:r.status,headers:r.headers});
          }
          if(isPreview){const data=await r.clone().json();if(window.__holdNextTallyPreview){window.__holdNextTallyPreview=false;window.__heldTallyPreview=true;const parse=r.json.bind(r);r.json=async()=>{const body=await parse();setTimeout(()=>window.__heldPreviewConsumed=true,0);return body;};await new Promise(resolve=>window.__releaseTallyPreview=resolve);window.__releasedTallyPreview=true;}if(request===window.__tallyPreviewRequest)window.__preview=data;}
          if(/\\/api\\/tally\\/companies\\/[^/]+\\/gst$/.test(url.pathname)){window.__review=await r.clone().json();window.__reviewCompany=url.pathname.split('/')[4];}
          return r;
        };
        """,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:NSRect(x:0,y:0,width:1440,height:1050),configuration:config);web.navigationDelegate=self;web.uiDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.contentView=web;window.title="Ledgercraft isolated Tally Excel and GST proof";window.orderFront(nil)
        web.load(URLRequest(url:URL(string:fixture["base"]!)!))
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) {
        if started{return};started=true
        Task {do {try await exercise();print("Native saved Tally Excel and GST verification passed");exit(0)}catch{let body=(try? await js("document.body.innerText")) as? String ?? "";try? (String(describing:error)+"\n"+body).write(to:output.appendingPathComponent("failure.txt"),atomically:true,encoding:.utf8);try? await screenshot("failure.png");print("Native Tally Excel/GST verification failed: \(error)");exit(1)}}
    }
    func literal(_ value:String)->String {String(String(data:try! JSONSerialization.data(withJSONObject:[value]),encoding:.utf8)!.dropFirst().dropLast())}
    func js(_ source:String) async throws -> Any? {try await web.evaluateJavaScript(source)}
    func wait(_ condition:String,_ label:String,seconds:Double=30) async throws {let end=Date().addingTimeInterval(seconds);while Date()<end {if (try await js(condition)) as? Bool == true{return};try await Task.sleep(nanoseconds:100_000_000)};throw TallyGstFailure(description:"Timed out: "+label)}
    func require(_ condition:String,_ label:String) async throws {guard (try await js(condition)) as? Bool == true else{throw TallyGstFailure(description:label)}}
    func fill(_ selector:String,_ value:String) async throws {try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;const d=e.closest('details');if(d&&!d.open&&e!==d.querySelector('summary'))d.querySelector('summary').click();e.value=\(literal(value));e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()","Missing field "+selector)}
    func click(_ selector:String) async throws {try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;const d=e.closest('details');if(d&&!d.open&&e!==d.querySelector('summary'))d.querySelector('summary').click();e.click();return true;})()","Missing control "+selector)}
    func go(_ company:String,_ section:String) async throws {_ = try await js("location.hash="+literal("#/c/"+company+"/"+section))}
    func screenshot(_ name:String) async throws {let image=try await web.takeSnapshot(configuration:nil);let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!;try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name))}
    func holdPreview() async throws {
        _ = try await js("window.__holdNextTallyPreview=true;window.__heldTallyPreview=false;window.__releasedTallyPreview=false;window.__heldPreviewConsumed=false;")
        try await click("#tally-preview-form button")
        try await wait("window.__heldTallyPreview===true","held real Tally preview response")
    }
    func releasePreview() async throws {
        _ = try await js("window.__releaseTallyPreview()")
        try await wait("window.__releasedTallyPreview===true&&window.__heldPreviewConsumed===true","held preview released")
    }
    func exercise() async throws {
        _ = try await js("location.hash='#/tally-import'")
        try await wait("!!document.querySelector('#tally-preview-form')","Tally import form")
        try await require("document.querySelector('#tally-preview-form [name=files]').accept.includes('.xlsx')","Excel is absent from native picker")
        picker=URL(fileURLWithPath:fixture["source"]!)
        try await click("#tally-preview-form [name=files]")
        try await wait("document.querySelector('#tally-preview-form [name=files]').files.length===1","native file for deferred-preview proof")
        try await fill("#tally-preview-form [name=companyName]","Deferred preview A")
        try await fill("#tally-preview-form [name=booksFrom]","2023-04-01")
        try await holdPreview()
        try await fill("#tally-preview-form [name=companyName]","Deferred preview B")
        try await require("!document.querySelector('#tally-preview-form button').disabled","Input edit cannot retry while old preview is pending")
        try await click("#tally-preview-form button")
        try await wait("document.querySelector('#tally-preview h2')?.textContent==='Deferred preview B'&&!!document.querySelector('#tally-confirm')","new preview while old response held")
        _ = try await js("window.__acceptedPreviewToken=window.__preview.token;window.__oldCommitForm=document.querySelector('#tally-confirm');true;")
        try await releasePreview()
        try await require("document.querySelector('#tally-preview h2').textContent==='Deferred preview B'&&window.__preview.token===window.__acceptedPreviewToken&&!!document.querySelector('#tally-confirm')","Old response replaced newer input preview")
        try await holdPreview()
        try await fill("#tally-preview-form [name=booksFrom]","2023-04-02")
        try await releasePreview()
        try await require("!document.querySelector('#tally-confirm')&&!document.querySelector('#tally-preview-form button').disabled","Date edit accepted stale preview or left retry disabled")
        _ = try await js("window.__oldCommitForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))")
        try await require("window.__tallyCommitRequests===0","Detached obsolete confirmation posted a company")
        try await fill("#tally-preview-form [name=booksFrom]","2023-04-01")
        try await holdPreview()
        extraPicker=URL(fileURLWithPath:fixture["overlapSource"]!)
        try await click("#tally-preview-form [name=files]")
        try await wait("document.querySelector('#tally-preview-form [name=files]').files.length===2","changed files during pending preview")
        try await releasePreview()
        try await require("!document.querySelector('#tally-confirm')&&document.querySelector('#tally-preview').childElementCount===0&&!document.querySelector('#tally-preview-form button').disabled","File edit accepted stale preview or blocked retry")
        steps.append("Real preview responses held across name/date/file edits cannot reinstall stale confirmation; a newer preview wins and a detached obsolete commit posts nothing")
        extraPicker=URL(fileURLWithPath:fixture["overlapSource"]!)
        try await click("#tally-preview-form [name=files]")
        try await wait("document.querySelector('#tally-preview-form [name=files]').files.length===2","native overlapping exports selection")
        try await fill("#tally-preview-form [name=companyName]","Synthetic overlap review of public sample")
        try await fill("#tally-preview-form [name=booksFrom]","2023-04-01")
        try await click("#tally-preview-form button")
        try await wait("!!document.querySelector('[data-overlap-choice]')&&window.__preview?.overlaps?.length===1","overlapping source review")
        try await require("!window.__preview.canCommit&&!document.querySelector('#tally-confirm')&&window.__preview.summary.vouchers===3","Unreviewed overlapping vouchers can be posted")
        let authority=try await js("window.__preview.overlaps[0].records.find(r=>r.file==='Synthetic-overlap.xml').recordId") as! String
        try await fill("[data-overlap-choice]",authority)
        try await click("[data-recheck-overlaps]")
        try await wait("window.__preview.overlaps[0].choice===\(literal(authority))&&window.__preview.summary.vouchers===4&&!!document.querySelector('#tally-confirm')","authoritative source posts once")
        try await fill("[data-overlap-choice]","distinct")
        try await require("!document.querySelector('#tally-confirm')","Changed overlap choice leaves stale commit control")
        try await click("[data-recheck-overlaps]")
        try await wait("window.__preview.overlaps[0].choice==='distinct'&&window.__preview.summary.vouchers===5&&!!document.querySelector('#tally-confirm')","explicitly distinct source vouchers")
        _ = try await js("document.querySelector('.tally-overlap-review').scrollIntoView({block:'start'})")
        try await screenshot("overlap-explicit-choice.png")
        steps.append("Actual ZIP plus synthetic overlapping XML block ambiguous posting; explicit source selection yields four vouchers, distinct confirmation yields five; neither preview is committed")
        extraPicker=URL(fileURLWithPath:fixture["supportingSource"]!)
        try await click("#tally-preview-form [name=files]")
        try await wait("document.querySelector('#tally-preview-form [name=files]').files.length===2","native synthetic supporting-master selection")
        try await fill("#tally-preview-form [name=companyName]","Synthetic supporting GST source facts")
        try await click("#tally-preview-form button")
        try await wait("!!document.querySelector('#tally-confirm')&&window.__preview.canCommit===true","supporting-master import preview")
        _ = try await js("document.querySelector('#tally-confirm input').click()")
        try await click("#tally-confirm button")
        try await wait("location.hash.includes('/tally-source')&&window.__reviewCompany===location.hash.split('/')[2]&&window.__review?.rows?.[0]?.source?.taxFacts?.sellerGstin?.status==='supplied'","supplied tax facts from accompanying masters")
        let supportingCompany=String(((try await js("location.hash")) as! String).split(separator:"/")[2])
        try await click("[data-tally-gst-details] > summary")
        try await click(".tally-gst-invoice > summary")
        try await click(".tally-gst-facts > summary")
        try await require("(()=>{const f=window.__review.rows[0].source.taxFacts.items.find(i=>i.sourceName==='Marker-Blue');return f.hsnSac.status==='supplied'&&f.hsnSac.value==='96082000'&&f.gstRateBps.status==='supplied'&&f.gstRateBps.value===1800;})()","Dated source HSN/rate not treated as supplied")
        try await require("document.querySelector('.tally-gst-facts').textContent.includes('96082000')&&document.querySelector('.tally-gst-facts').textContent.includes('18%')&&document.querySelector('.tally-gst-facts').textContent.includes('01-04-2023')&&document.querySelector('.tally-gst-facts').textContent.includes('tally-gst-support.xml')","Source facts lack readable value/date/file basis")
        _ = try await js("document.querySelector('.tally-gst-facts').scrollIntoView({block:'start'})")
        try await screenshot("supplied-source-gst-facts.png")
        try await click("[data-tally-gst-prepare=seller]")
        try await require("document.querySelector('[data-tally-gst-master=settings]').elements.gstin.value===window.__review.rows[0].source.taxFacts.sellerGstin.value&&window.__review.registrations.length===0","Source seller preparation saved silently or omitted source GSTIN")
        try await click("[data-tally-gst-prepare=item][data-source-name='Marker-Blue']")
        try await require("(()=>{const f=document.querySelector('[data-tally-gst-master=items]');return f.elements.hsnSac.value==='96082000'&&f.elements.gstRate.value==='18'&&f.elements.stockItemId.value!==''&&window.__review.items.length===0;})()","Explicit source item preparation lost supplied HSN/rate or saved silently")
        try await screenshot("prepared-source-item-facts.png")
        try await click("[data-tally-gst-master=items] button")
        try await wait("window.__review.items.length===1&&!document.querySelector('[data-tally-gst-refresh]').disabled","saved matching source item master")
        let sourceItem=try await js("window.__review.items[0].id") as! String
        try await fill("[data-tally-gst-master=items] [name=stockItemId]",sourceItem)
        try await fill("[data-tally-gst-master=items] [name=hsnSac]","96081000")
        try await fill("[data-tally-gst-master=items] [name=gstRate]","12")
        try await click("[data-tally-gst-master=items] button")
        try await wait("window.__review.items[0].gstRateBps===1200&&!document.querySelector('[data-tally-gst-refresh]').disabled","explicit synthetic current-master change")
        try await click(".tally-gst-invoice > summary")
        try await click("[data-tally-gst-match-source]")
        try await require("document.querySelector('.tally-gst-invoice [data-tally-gst-mapping]').elements['item-0'].value===window.__review.items[0].id&&window.__review.rows.every(r=>r.mapping===null)","Explicit matching source-master selection missing or invoice mapping saved silently")
        try await require("(()=>{const f=document.querySelector('.tally-gst-invoice [data-tally-gst-mapping]');return f.elements['sourceChoice:item:Marker-Blue:hsnSac'].value==='source'&&f.elements['sourceChoice:item:Marker-Blue:gstRateBps'].value==='source'&&!f.elements['sourceCorrection:item:Marker-Blue:gstRateBps'];})()","Dated source did not remain default when current master changed")
        try await fill("[name='sourceChoice:item:Marker-Blue:gstRateBps']","master")
        try await require("(()=>{const f=document.querySelector('.tally-gst-invoice [data-tally-gst-mapping]');return f.elements['sourceCorrection:item:Marker-Blue:gstRateBps'].required&&f.elements['sourceCorrection:item:Marker-Blue:gstRateBps'].value==='';})()","Deliberate current-master correction lacks required reason")
        try await fill("[name='sourceCorrection:item:Marker-Blue:gstRateBps']","Synthetic current-master correction evidence")
        try await fill("[name='sourceChoice:item:Marker-Blue:gstRateBps']","source")
        try await require("!document.querySelector('.tally-gst-invoice [data-tally-gst-mapping]').elements['sourceCorrection:item:Marker-Blue:gstRateBps']&&window.__review.items[0].gstRateBps===1200","Returning to source kept correction or rewrote master")
        _ = try await js("document.querySelector('[data-tally-gst-corrections]').scrollIntoView({block:'start'})")
        try await screenshot("historical-source-default.png")
        steps.append("Separate synthetic supporting-master book showed supplied GSTIN and dated HSN/rate with provenance; explicit preparation saved no invoice mapping; after an explicit current-master change, dated source stayed default and opting into a master correction required its own reason")
        _ = try await js("location.hash='#/tally-import'")
        try await wait("!!document.querySelector('#tally-preview-form')","return to public-file-only import")
        extraPicker=nil
        try await click("#tally-preview-form [name=files]")
        try await wait("document.querySelector('#tally-preview-form [name=files]').files.length===1","native official ZIP selection")
        try await fill("#tally-preview-form [name=companyName]","Published Tally GST workbook — disposable acceptance")
        try await fill("#tally-preview-form [name=booksFrom]","2023-04-01")
        try await click("#tally-preview-form button")
        try await wait("!!document.querySelector('[data-recheck-groups]')","ledger role preview")
        try await require("window.__preview.summary.openingScope.transactionOnly===true&&!document.querySelector('[data-billed-as-actual]').checked","Transaction-only/physical-quantity scope is missing or assumed")
        try await require("window.__preview.summary.vouchers===4","Public workbook voucher count")
        _ = try await js("document.querySelectorAll('[data-account-group]').forEach(e=>{e.value=/sales/i.test(e.dataset.accountGroup)?'g-sales':/tax|cgst|sgst|igst/i.test(e.dataset.accountGroup)?'g-duties':'g-debtors';e.dispatchEvent(new Event('change',{bubbles:true}));});document.querySelector('[data-billed-as-actual]').click();")
        try await click("[data-recheck-groups]")
        try await wait("!!document.querySelector('#tally-confirm')&&window.__preview.canCommit===true","reviewed workbook preview")
        try await require("document.querySelector('[data-billed-as-actual]').checked","Billed quantity decision lost during recheck")
        try await screenshot("workbook-reviewed-preview.png")
        try await fill("#tally-preview-form [name=companyName]","Published Tally GST workbook — reviewed acceptance")
        try await require("!document.querySelector('#tally-confirm')","Changed import settings left stale commit control")
        try await click("#tally-preview-form button")
        try await wait("!!document.querySelector('#tally-confirm')&&window.__preview.canCommit===true","preview after settings edit")
        try await require("document.querySelector('[data-billed-as-actual]').checked","Recheck lost physical quantity decision")
        _ = try await js("document.querySelector('#tally-confirm input').click()")
        try await click("#tally-confirm button")
        try await wait("location.hash.includes('/tally-source')&&!!document.querySelector('[data-tally-gst-summary]')&&window.__review?.rows?.length===4&&window.__reviewCompany===location.hash.split('/')[2]","imported source and GST review")
        let company=String(((try await js("location.hash")) as! String).split(separator:"/")[2])
        try await click("[data-tally-gst-details] > summary")
        steps.append("Native picker selected intact official ZIP; preview showed transaction-only openings and four vouchers; ledger roles and physical quantities were explicitly reviewed")
        try await wait("document.querySelector('[data-stock-source-summary]')?.textContent.includes('Activated')===true","reviewed source stock active on import")
        try await require("document.querySelector('[data-stock-source-summary]').textContent.includes('7 supported items')&&document.querySelector('[data-stock-source-summary]').textContent.includes('4 stock journals')","Reviewed source stock item/journal counts")
        try await click("[data-tally-gst-refresh]")
        try await wait("window.__review?.sourceStockItems?.length===7","source item links")
        try await click("[data-tally-gst-enrichment] > details > summary")
        let reg="[data-tally-gst-master=settings]"
        try await fill(reg+" [name=name]","Synthetic seller for public sample")
        try await fill(reg+" [name=legalName]","Synthetic seller for public sample")
        try await fill(reg+" [name=gstin]",fixture["sellerGstin"]!)
        try await fill(reg+" [name=stateCode]","06")
        try await fill(reg+" [name=address]","Synthetic acceptance address, Haryana")
        try await click(reg+" button")
        try await wait("window.__review?.registrations?.length===1&&!document.querySelector('[data-tally-gst-refresh]').disabled","saved seller master")
        let parties = try await js("[...new Map(window.__review.rows.map(r=>[r.source.partyLedgerId+':'+r.source.placeOfSupply,{id:r.source.partyLedgerId,name:r.source.partyName+' ('+r.source.placeOfSupply+')',state:r.source.placeOfSupply}])).values()]") as! [[String:String]]
        for (index,party) in parties.enumerated() {
            let form="[data-tally-gst-master=parties]"
            try await fill(form+" [name=customerLedgerId]",party["id"]!)
            try await fill(form+" [name=name]",party["name"]!)
            try await fill(form+" [name=gstin]",fixture["buyer"+String(index)]!)
            try await fill(form+" [name=stateCode]",party["state"]!)
            try await fill(form+" [name=address]","Synthetic customer acceptance address")
            try await click(form+" button")
            try await wait("window.__review?.parties?.length===\(index+1)&&!document.querySelector('[data-tally-gst-refresh]').disabled","saved linked source customer")
        }
        let items=try await js("window.__review.sourceStockItems.map(i=>({id:i.id,name:i.name}))") as! [[String:String]]
        for (index,item) in items.enumerated() {
            let form="[data-tally-gst-master=items]"
            try await fill(form+" [name=stockItemId]",item["id"]!)
            let name=item["name"]!.lowercased()
            let hsn=name.contains("eraser") ? "40169200" : name.contains("pencil") ? "96091000" : name.contains("envelope") ? "48171000" : name.contains("folder") ? "48203000" : "96082000"
            try await fill(form+" [name=hsnSac]",hsn)
            try await fill(form+" [name=gstRate]","18")
            try await click(form+" button")
            try await wait("window.__review?.items?.length===\(index+1)&&!document.querySelector('[data-tally-gst-refresh]').disabled","saved source item HSN")
        }
        steps.append("Source-specific forms saved an explicitly synthetic seller and customers plus seven HSN masters linked to original party ledgers and stock IDs")
        let recordIds=try await js("window.__review.rows.map(r=>r.recordId)") as! [String]
        for (index,recordId) in recordIds.enumerated() {
            let form="[data-tally-gst-record='"+recordId+"'] [data-tally-gst-mapping]"
            if index==1 {
                try await fill(form+" [data-copy-source]",recordIds[0])
                try await click(form+" [data-copy-mapping]")
                try await require("document.querySelector(\(literal(form))).elements.registrationId.value===window.__review.registrations[0].id&&document.querySelector(\(literal(form))).elements.partyId.value===''","Explicit mapping reuse copied a customer identity")
            }
            _ = try await js("""
            (()=>{const row=window.__review.rows.find(r=>r.recordId===\(literal(recordId))),form=document.querySelector(\(literal(form))),state=window.__review;const values={registrationId:state.registrations[0].id,partyId:state.parties.find(p=>p.customerLedgerId===row.source.partyLedgerId&&p.stateCode===row.source.placeOfSupply).id,evidenceName:'Synthetic public-sample acceptance mapping',evidenceReference:'Local test only: explicit seller, buyer identity corrections, HSN and 18% rates; published source retained'};const items=[...new Set(row.source.items.map(i=>i.sourceName))];items.forEach((name,i)=>values['item-'+i]=state.items.find(item=>item.name===name).id);for(const role of ['party','sales','cgst','sgst','utgst','igst','cess']){if(!form.elements['account-'+role])continue;values['account-'+role]=role==='party'?row.source.partyLedgerId:state.ledgers.find(l=>role==='sales'?l.name==='Sales':new RegExp(role,'i').test(l.name)).id;}for(const [name,value]of Object.entries(values)){form.elements[name].value=value;form.elements[name].dispatchEvent(new Event('input',{bubbles:true}));}for(const input of form.querySelectorAll('[name^=\"sourceCorrection:\"]')){input.value='Synthetic acceptance correction: selected test master replaces conflicting source facts under the named local test evidence';input.dispatchEvent(new Event('input',{bubbles:true}));}return true;})()
            """)
            try await click(form+" button[type=submit]")
            try await wait("window.__review.summary.ready===\(index+1)&&!document.querySelector('[data-tally-gst-refresh]').disabled","saved invoice mapping")
        }
        _ = try await js("window.__pagedGstRows=Array.from({length:25},(_,i)=>{const row=JSON.parse(JSON.stringify(window.__review.rows[0]));row.recordId='r-ui-paging-'+String(i+1).padStart(3,'0');row.number='UI-PAGE-'+String(i+1).padStart(3,'0');row.source.partyName='Synthetic UI-only paging customer';row.mapping.recordId=row.recordId;return row;});true;")
        try await click("[data-tally-gst-refresh]")
        try await wait("document.querySelectorAll('[data-tally-gst-mapping]').length===20&&document.querySelector('[data-tally-gst-page]').textContent.includes('1–20 of 25')&&document.querySelector('[data-tally-gst-rows]').getAttribute('aria-busy')==='false'","bounded first synthetic UI page")
        _ = try await js("(()=>{const form=document.querySelector('[data-tally-gst-mapping]');for(const [name,value]of Object.entries({stockMode:'report-only',evidenceName:'Synthetic paged draft'})){form.elements[name].value=value;form.elements[name].dispatchEvent(new Event('input',{bubbles:true}));}const correction=form.querySelector('[name^=\"sourceCorrection:\"]');window.__pagedCorrectionName=correction.name;correction.value='Synthetic correction draft retained across pages';correction.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-tally-gst-select]:not(:disabled)').click();return true;})()")
        try await require("!document.querySelector('[data-tally-gst-activate]').disabled","Visible ready selection cannot be activated")
        try await click("[data-tally-gst-next]")
        try await wait("document.querySelectorAll('[data-tally-gst-mapping]').length===5&&document.querySelector('[data-tally-gst-page]').textContent.includes('21–25 of 25')&&document.querySelector('[data-tally-gst-rows]').getAttribute('aria-busy')==='false'","bounded last synthetic UI page")
        try await require("document.querySelectorAll('[data-tally-gst-select]:checked').length===0&&document.querySelector('[data-tally-gst-activate]').disabled&&document.querySelector('[data-tally-gst-next]').disabled","Selection crossed page or last page allows another next page")
        try await click("[data-tally-gst-previous]")
        try await wait("document.querySelector('[data-tally-gst-page]').textContent.includes('1–20 of 25')&&document.querySelector('[data-tally-gst-rows]').getAttribute('aria-busy')==='false'","return to first synthetic UI page")
        try await require("(()=>{const f=document.querySelector('[data-tally-gst-mapping]');return f.elements.stockMode.value==='report-only'&&f.elements.evidenceName.value==='Synthetic paged draft'&&f.elements[window.__pagedCorrectionName].value==='Synthetic correction draft retained across pages'&&document.querySelectorAll('[data-tally-gst-select]:checked').length===0;})()","Paging lost stock/evidence/correction draft or retained hidden selection")
        try await fill("[data-tally-gst-filter] [name=q]","UI-PAGE-025")
        try await click("[data-tally-gst-filter] button")
        try await wait("document.querySelectorAll('[data-tally-gst-mapping]').length===1&&document.querySelector('[data-tally-gst-page]').textContent.includes('1–1 of 1')&&document.querySelector('[data-tally-gst-rows]').getAttribute('aria-busy')==='false'","synthetic source invoice search")
        _ = try await js("document.querySelector('.tally-gst-review').scrollIntoView({block:'start'})")
        try await screenshot("synthetic-ui-paging-search.png")
        try await fill("[data-tally-gst-filter] [name=q]","")
        try await click("[data-tally-gst-filter] button")
        try await wait("document.querySelectorAll('[data-tally-gst-mapping]').length===20&&document.querySelector('[data-tally-gst-rows]').getAttribute('aria-busy')==='false'","cleared synthetic invoice search")
        try await require("document.querySelector('[data-tally-gst-mapping]').elements.evidenceName.value==='Synthetic paged draft'&&window.__pagingWrites===0&&window.__pagingQueries.some(q=>q.offset===20)&&window.__pagingQueries.some(q=>q.q==='ui-page-025')","Search lost draft or synthetic UI fixture wrote books")
        _ = try await js("window.__pagedGstRows=null")
        try await click("[data-tally-gst-refresh]")
        try await wait("document.querySelectorAll('[data-tally-gst-mapping]').length===4&&window.__review.rows.length===4&&document.querySelector('[data-tally-gst-rows]').getAttribute('aria-busy')==='false'","actual public example restored after synthetic UI transport fixture")
        steps.append("Isolated UI transport fixture cloned25 labeled synthetic ready rows:20/5 bounded pages, searchable last row, stock/evidence/source-correction drafts retained, page selection cleared, zero fixture writes; actual four-row report restored before activation")
        try await require("document.querySelectorAll('[data-tally-gst-select]').length===4","Ready invoice selection missing")
        _ = try await js("document.querySelector('.tally-gst-review').scrollIntoView({block:'start'})")
        try await screenshot("gst-ready-mappings.png")
        _ = try await js("document.querySelectorAll('[data-tally-gst-select]').forEach(e=>e.click())")
        try await require("!document.querySelector('[data-tally-gst-activate]').disabled","Explicit selection did not enable activation")
        try await click("[data-tally-gst-activate]")
        try await wait("window.__review.summary.active===4&&document.querySelector('[data-tally-gst-summary]').textContent.includes('4 active')","four GST source invoices activated")
        try await require("document.querySelector('[data-tally-gst-summary]').textContent.includes('27,200.00')&&document.querySelector('[data-tally-gst-summary]').textContent.includes('4,896.00')","Activated totals do not match official workbook")
        steps.append("Four explicitly mapped invoices activated as GST documents with ₹27,200 taxable and ₹4,896 tax")
        try await click(".tally-gst-invoice > summary")
        try await click(".tally-gst-original > summary")
        try await require("document.querySelector('.tally-gst-original pre').textContent.includes('IRN')&&document.querySelector('.tally-gst-original pre').textContent.includes('EWAYBILL')","Source transport and IRN references missing")
        _ = try await js("document.querySelector('.tally-gst-review').scrollIntoView({block:'start'})")
        try await screenshot("gst-active-source.png")
        for width in [375,768,1024,1440] {
            window.setContentSize(NSSize(width:width,height:1050));try await wait("window.innerWidth===\(width)","viewport")
            try await require("document.documentElement.scrollWidth<=window.innerWidth+1","GST review overflows viewport \(width)")
            try await require("document.querySelector('.tally-gst-review').scrollWidth<=document.querySelector('.tally-gst-review').clientWidth+1","GST review content overflows its column")
            _ = try await js("document.querySelector('.tally-gst-review').scrollIntoView({block:'start'})")
            if width==375 {try await screenshot("gst-source-mobile.png")}
        }
        try await go(company,"tally-source/"+recordIds[0])
        try await wait("[...document.querySelectorAll('.tally-data-section h2')].some(e=>e.textContent.includes('Spreadsheet source'))","spreadsheet source cells")
        try await require("document.body.innerText.includes('Billed Quantity')&&document.body.innerText.includes('EWAYBILLNUMBER')","Readable original spreadsheet/transport fields missing")
        _ = try await js("[...document.querySelectorAll('.tally-data-section')].find(e=>e.textContent.includes('Spreadsheet source')).scrollIntoView({block:'start'})")
        try await screenshot("source-spreadsheet.png")
        try await go(company,"transfer")
        try await wait("!!document.querySelector('a[href$=\"/backup\"]')","backup link")
        try await click("a[href$='/backup']")
        let end=Date().addingTimeInterval(30);while !finished.contains("company-backup.json")&&Date()<end{try await Task.sleep(nanoseconds:100_000_000)}
        guard finished.contains("company-backup.json") else{throw TallyGstFailure(description:"Native backup download failed")}
        picker=output.appendingPathComponent("company-backup.json")
        try await click("#book-files");try await wait("document.querySelector('#book-files').files.length===1","native backup selection")
        try await click("#book-import button")
        try await wait("location.hash.startsWith('#/c/')&&location.hash.split('/')[2]!==\(literal(company))&&!!document.querySelector('main h1')","native restore")
        let restored=String(((try await js("location.hash")) as! String).split(separator:"/")[2])
        try await go(restored,"tally-source?review=gst")
        try await wait("window.__review.summary.active===4&&document.querySelector('[data-tally-gst-summary]')?.textContent.includes('4 active')===true","restored GST activation review")
        try await click(".tally-export-menu > summary")
        _ = try await js("(()=>{const select=document.querySelector('[data-original-file]'),option=[...select.options].find(o=>/\\.zip$/i.test(o.textContent));if(option){select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));}return true;})()")
        try await click("[data-original-download]")
        let sourceEnd=Date().addingTimeInterval(30);while !finished.contains("source-original-1.zip")&&Date()<sourceEnd{try await Task.sleep(nanoseconds:100_000_000)}
        guard finished.contains("source-original-1.zip") else{throw TallyGstFailure(description:"Restored original source download failed")}
        try await require("window.__errors.length===0","Native page errors")
        steps.append("Review fits 375–1440 pixel viewports; normal native backup/restore retains four active GST invoices and downloadable original source bytes")
        let result:[String:Any]=["passed":true,"browser":"macOS WKWebView on disposable public-example books","company":company,"restoredCompany":restored,"supportingMasterCompany":supportingCompany,"steps":steps,"nativeOpenFileDelegateCalls":pickerCalls,"downloads":finished,"pageErrors":[],"syntheticMappings":true]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-results.json"));window.close()
    }
    func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping([URL]?)->Void) {pickerCalls+=1;var selection:[URL]=[];if let picker{selection.append(picker)};if let extraPicker{selection.append(extraPicker)};completionHandler(selection)}
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {if navigationAction.shouldPerformDownload{decisionHandler(.download)}else{decisionHandler(navigationAction.request.url?.host=="127.0.0.1" ? .allow : .cancel)}}
    func webView(_ webView:WKWebView,decidePolicyFor navigationResponse:WKNavigationResponse,decisionHandler:@escaping(WKNavigationResponsePolicy)->Void) {decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)}
    func webView(_ webView:WKWebView,navigationAction:WKNavigationAction,didBecome download:WKDownload) {downloads.append(download);download.delegate=self}
    func webView(_ webView:WKWebView,navigationResponse:WKNavigationResponse,didBecome download:WKDownload) {downloads.append(download);download.delegate=self}
    func download(_ download:WKDownload,decideDestinationUsing response:URLResponse,suggestedFilename:String,completionHandler:@escaping(URL?)->Void) {
        let name:String
        if response.url?.path.hasSuffix("/backup")==true {name="company-backup.json"}else if response.url?.path.hasSuffix("/archive")==true {name="tally-full-archive.json"}else{originalCount+=1;name="source-original-\(originalCount).zip"}
        destinationNames[ObjectIdentifier(download)]=name
        let file=output.appendingPathComponent(name);try? FileManager.default.removeItem(at:file);completionHandler(file)
    }
    func downloadDidFinish(_ download:WKDownload) {if let name=destinationNames.removeValue(forKey:ObjectIdentifier(download)){finished.append(name)}}
    func download(_ download:WKDownload,didFailWithError error:Error,resumeData:Data?) {downloadErrors.append(error.localizedDescription)}
}
try MainActor.assumeIsolated {let app=NSApplication.shared;let runner=try TallyGstRunner(CommandLine.arguments[1]);app.delegate=runner;app.setActivationPolicy(.accessory);app.run()}
