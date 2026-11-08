import AppKit
import WebKit

struct HistoryFailure: Error,CustomStringConvertible {let description:String}
@MainActor final class HistoryRunner:NSObject,NSApplicationDelegate,WKNavigationDelegate {
    let fixture:[String:String],output:URL
    var web:WKWebView!,window:NSWindow!,started=false
    var steps:[String]=[]
    init(_ file:String)throws{fixture=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:file))) as! [String:String];output=URL(fileURLWithPath:fixture["output"]!);super.init()}
    func applicationDidFinishLaunching(_ notification:Notification){
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        config.userContentController.addUserScript(WKUserScript(source:"""
        window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));
        window.__historyQueries=[];window.__maxHistoryRows=0;
        new MutationObserver(()=>{window.__maxHistoryRows=Math.max(window.__maxHistoryRows,document.querySelectorAll('[data-stock-journals] > details[data-stock-journal]').length);}).observe(document,{childList:true,subtree:true});
        const nativeFetch=window.fetch;
        window.fetch=async(u,o)=>{
          const url=new URL(typeof u==='string'?u:u.url,location.href);
          const response=await nativeFetch(u,o);
          if(url.pathname.endsWith('/stock/journals')){
            window.__historyQueries.push(Object.fromEntries(url.searchParams));
            if(window.__holdAnnexHistory&&url.searchParams.get('godownId')==='annex'){
              window.__holdAnnexHistory=false;
              await response.clone().arrayBuffer();
              const parse=response.json.bind(response);
              response.json=async()=>{const body=await parse();setTimeout(()=>{window.__heldBodyFinished=true;},0);return body;};
              return await new Promise(resolve=>{window.__releaseHistory=()=>resolve(response);window.__heldHistoryReady=true;});
            }
          }
          return response;
        };
        """,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:NSRect(x:0,y:0,width:1440,height:1050),configuration:config);web.navigationDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.contentView=web;window.title="Ledgercraft isolated stock history pagination";window.orderFront(nil)
        web.load(URLRequest(url:URL(string:fixture["base"]!)!))
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){if started{return};started=true;Task{do{try await exercise();print("Native stock history pagination verification passed");exit(0)}catch{let body=(try? await js("document.body.innerText.slice(-5000)")) as? String ?? "";try? (String(describing:error)+"\n"+body).write(to:output.appendingPathComponent("failure.txt"),atomically:true,encoding:.utf8);try? await screenshot("failure.png");print("Native stock history pagination failed: \(error)");exit(1)}}}
    func literal(_ s:String)->String{String(String(data:try! JSONSerialization.data(withJSONObject:[s]),encoding:.utf8)!.dropFirst().dropLast())}
    func js(_ s:String)async throws->Any?{try await web.evaluateJavaScript(s)}
    func wait(_ condition:String,_ label:String)async throws{let end=Date().addingTimeInterval(30);while Date()<end{if (try await js(condition)) as? Bool==true{return};try await Task.sleep(nanoseconds:100_000_000)};throw HistoryFailure(description:"Timed out: "+label)}
    func require(_ condition:String,_ label:String)async throws{guard (try await js(condition)) as? Bool==true else{throw HistoryFailure(description:label)}}
    func click(_ selector:String)async throws{try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;e.focus();e.click();return true;})()","Missing control "+selector)}
    func fill(_ selector:String,_ value:String)async throws{try await require("(()=>{const e=document.querySelector(\(literal(selector)));if(!e)return false;const d=e.closest('details');if(d&&!d.open)d.querySelector('summary').click();e.value=\(literal(value));e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()","Missing field "+selector)}
    func go(_ section:String)async throws{_ = try await js("location.hash="+literal("#/c/"+fixture["company"]!+"/"+section))}
    func page(_ first:String,_ count:Int,_ range:String)async throws{try await wait("document.querySelectorAll('[data-stock-journals] > details').length===\(count)&&document.querySelector('[data-stock-journals] > details > summary')?.textContent.includes(\(literal(first)))&&document.querySelector('[data-stock-history-page]')?.textContent.includes(\(literal(range)))&&document.querySelector('[data-stock-journals]').getAttribute('aria-busy')==='false'",range)}
    func screenshot(_ name:String)async throws{let image=try await web.takeSnapshot(configuration:nil);let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!;try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name))}
    func holdAnnex()async throws{_ = try await js("window.__holdAnnexHistory=true;window.__heldHistoryReady=false;window.__heldBodyFinished=false;window.__releaseHistory=null;");try await fill("#stock-period [name=godown]","annex");try await wait("window.__heldHistoryReady===true","held Annex response")}
    func releaseHeld()async throws{_ = try await js("window.__releaseHistory()");try await wait("window.__heldBodyFinished===true","delayed response parsed")}
    func exercise()async throws{
        try await go("stock?from=2026-04-01&to=2026-04-30")
        try await page("ENTRY-115",50,"1–50 of 115")
        try await require("document.querySelector('[data-stock-history-direction=later]').disabled","First page permits a newer page")
        try await fill("#stock-journal [name=number]","DRAFT-PAGING")
        try await fill("#stock-journal [data-field=quantity]","2")
        try await click("[data-stock-history-direction=earlier]");try await page("ENTRY-065",50,"51–100 of 115")
        try await require("document.activeElement.dataset.stockHistoryDirection==='earlier'","Keyboard focus lost on history navigation")
        try await click("[data-stock-history-direction=earlier]");try await page("ENTRY-015",15,"101–115 of 115")
        try await require("document.querySelector('[data-stock-history-direction=earlier]').disabled&&document.activeElement.dataset.stockHistoryDirection==='later'","Last-page controls/focus incorrect")
        _ = try await js("document.querySelector('[data-stock-journals]').scrollIntoView({block:'start'})")
        try await screenshot("history-last-page.png")
        try await click("[data-stock-history-direction=later]");try await page("ENTRY-065",50,"51–100 of 115")
        try await click("[data-stock-history-direction=earlier]");try await page("ENTRY-015",15,"101–115 of 115")
        steps.append("Three 50-row pages navigate newest-first with correct ranges and keyboard focus")
        try await fill("#stock-period [name=godown]","annex");try await page("ENTRY-110",50,"1–50 of 55")
        try await require("document.querySelector('[data-stock-history-direction=later]').disabled","Godown change did not reset to page one")
        try await click("[data-stock-history-direction=earlier]");try await page("ENTRY-010",5,"51–55 of 55")
        try await require("[...document.querySelectorAll('[data-stock-journals] > details')].every(e=>e.textContent.includes('Annex')&&!e.textContent.includes('item B'))","Godown-filtered last page includes other data")
        try await fill("#stock-period [name=godown]","main");try await page("ENTRY-115",50,"1–50 of 60")
        try await require("document.querySelector('#stock-journal [name=number]').value==='DRAFT-PAGING'&&document.querySelector('#stock-journal [data-field=quantity]').value==='2'","Paging/filtering discarded journal draft")
        steps.append("Godown changes reset page one; earlier/later preserve filters and unsaved journal fields")
        try await go("stock-item/"+fixture["itemA"]!+"?from=2026-04-01&to=2026-04-30&godown=annex")
        try await page("ENTRY-110",50,"1–50 of 55")
        try await click("[data-stock-history-direction=earlier]");try await page("ENTRY-010",5,"51–55 of 55")
        try await require("[...document.querySelectorAll('[data-stock-journals] > details')].every(e=>e.textContent.includes('item A')&&!e.textContent.includes('item B'))","Item filter was lost on later page")
        try await fill("#stock-period [name=godown]","main");try await page("ENTRY-109",50,"1–50 of 55")
        steps.append("Initial item+godown page and subsequent pages retain exact item/date/location scope")
        try await holdAnnex()
        try await fill("#stock-period [name=godown]","main");try await page("ENTRY-109",50,"1–50 of 55")
        try await releaseHeld();try await page("ENTRY-109",50,"1–50 of 55")
        try await require("document.querySelector('#stock-period [name=godown]').value==='main'&&[...document.querySelectorAll('[data-stock-journals] > details')].every(e=>!e.textContent.includes('Annex'))","Delayed old filter redrew current journals")
        steps.append("Out-of-order stale filter response is ignored")
        try await holdAnnex()
        try await go("stock?from=2026-04-01&to=2026-04-30");try await page("ENTRY-115",50,"1–50 of 115")
        try await releaseHeld();try await page("ENTRY-115",50,"1–50 of 115")
        try await require("document.querySelector('h1').textContent==='Stock summary'","Stale request replaced new route")
        steps.append("Delayed old item request cannot redraw after route navigation")
        try await require("window.__maxHistoryRows===50&&window.__errors.length===0","History exceeded row bound or emitted page errors")
        try await require("window.__historyQueries.length>=8&&window.__historyQueries.every(q=>q.from==='2026-04-01'&&q.to==='2026-04-30'&&q.limit==='50')","History requests lost their date or page bound")
        try await require("window.__historyQueries.some(q=>q.itemId===\(literal(fixture["itemA"]!))&&q.godownId==='annex'&&q.offset==='50')","Item/location pagination request not exercised")
        _ = try await js("document.querySelector('[data-stock-journals]').scrollIntoView({block:'start'})")
        try await screenshot("history-first-page.png")
        let queries=try await js("window.__historyQueries") as! [[String:String]]
        let result:[String:Any]=["passed":true,"browser":"macOS WKWebView on isolated synthetic books","steps":steps,"fixtureJournals":115,"maxRenderedRows":50,"pageErrors":[],"historyQueries":queries,"latencyFixture":"One actual Annex response is held until a later filter/navigation completes; response bytes are unchanged"]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-results.json"));window.close()
    }
}
try MainActor.assumeIsolated{let app=NSApplication.shared;let runner=try HistoryRunner(CommandLine.arguments[1]);app.delegate=runner;app.setActivationPolicy(.accessory);app.run()}
