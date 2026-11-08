import AppKit
import WebKit
struct BrandingFailure:Error,CustomStringConvertible {let description:String}
@MainActor final class BrandingRunner:NSObject,NSApplicationDelegate,WKNavigationDelegate {
    let config:[String:String],output:URL
    var web:WKWebView!,window:NSWindow!,started=false
    init(_ path:String)throws {config=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:path))) as! [String:String];output=URL(fileURLWithPath:config["output"]!);super.init()}
    func applicationDidFinishLaunching(_ notification:Notification){
        let configuration=WKWebViewConfiguration();configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(source:"window.__brandingErrors=[];window.addEventListener('error',e=>window.__brandingErrors.push(e.message));",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:NSRect(x:0,y:0,width:1440,height:1000),configuration:configuration);web.navigationDelegate=self
        window=NSWindow(contentRect:web.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.contentView=web;window.title="Ledgercraft branding — isolated native proof";window.orderFront(nil)
        web.load(URLRequest(url:URL(string:config["base"]!)!))
    }
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){if started{return};started=true;Task{do{try await exercise();print("Ledgercraft native branding passed");exit(0)}catch{try? String(describing:error).write(to:output.appendingPathComponent("failure.txt"),atomically:true,encoding:.utf8);try? await snapshot("failure.png");print("Ledgercraft native branding failed: \(error)");exit(1)}}}
    func js(_ source:String)async throws->Any?{try await web.evaluateJavaScript(source)}
    func require(_ source:String,_ name:String)async throws{guard (try await js(source)) as? Bool==true else{throw BrandingFailure(description:name)}}
    func wait(_ source:String,_ name:String)async throws{let end=Date().addingTimeInterval(20);while Date()<end{if (try await js(source)) as? Bool==true{return};try await Task.sleep(nanoseconds:100_000_000)};throw BrandingFailure(description:"Timed out: "+name)}
    func snapshot(_ file:String)async throws{let shot=try await web.takeSnapshot(configuration:nil),bitmap=NSBitmapImageRep(data:shot.tiffRepresentation!)!;try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(file))}
    func exercise()async throws{
        try await wait("document.querySelector('.wordmark')?.textContent.trim()==='Ledgercraft'&&document.title==='Ledgercraft'","Ledgercraft company chooser")
        _ = try await js("window.__brandFontsReady=false;document.fonts.ready.then(()=>window.__brandFontsReady=true);true")
        try await wait("window.__brandFontsReady===true","local wordmark font")
        var measurements:[[String:Any]]=[]
        for width in [1440,1024,1000,850,768,375] {
            window.setContentSize(NSSize(width:width,height:1000));try await wait("window.innerWidth===\(width)","viewport")
            let measure=try await js("(()=>{const e=document.querySelector('.wordmark'),rail=e.closest('.rail'),r=e.getBoundingClientRect(),rr=rail.getBoundingClientRect(),text=document.createRange();text.selectNode(e.lastChild);const tr=text.getBoundingClientRect();return {viewport:innerWidth,wordmarkWidth:r.width,wordmarkScrollWidth:e.scrollWidth,wordmarkClientWidth:e.clientWidth,railWidth:rr.width,textRight:tr.right,railRight:rr.right};})()") as! [String:Any]
            measurements.append(measure)
            try await require("(()=>{const e=document.querySelector('.wordmark'),r=e.getBoundingClientRect(),rr=e.closest('.rail').getBoundingClientRect();return e.scrollWidth<=e.clientWidth+1&&r.right<=rr.right+1&&document.documentElement.scrollWidth<=innerWidth+1;})()","Wordmark or page overflows at \(width)px")
            if width==1440 {try await snapshot("ledgercraft-desktop.png")}
            if width==850 {try await snapshot("ledgercraft-narrow-rail.png")}
            if width==375 {try await snapshot("ledgercraft-mobile.png")}
        }
        window.setContentSize(NSSize(width:1440,height:1000));try await wait("innerWidth===1440","desktop reset")
        _ = try await js("document.querySelector('.search-button').click();true")
        try await wait("document.querySelector('dialog[open]')?.getAttribute('aria-label')==='Find in Ledgercraft'","renamed finder dialog")
        try await require("document.querySelector('dialog[open]').textContent.includes('Find in Ledgercraft')","Finder heading keeps old brand")
        try await snapshot("ledgercraft-finder.png")
        _ = try await js("document.querySelector('dialog[open] button').click();location.hash='#/transfer';true")
        try await wait("document.body.innerText.includes('Choose a Ledgercraft backup')&&document.title.includes('Ledgercraft')","backup import wording")
        _ = try await js("location.hash='#/tally-import';true")
        try await wait("document.body.innerText.includes('full Ledgercraft Tally archive')&&document.title.includes('Ledgercraft')","Tally import wording")
        _ = try await js("window.__brandIconDone=false;fetch('/favicon.svg').then(r=>r.text()).then(s=>{window.__brandIcon=s;window.__brandIconDone=true;});true")
        try await wait("window.__brandIconDone===true","served icon")
        try await require("window.__brandIcon.includes('>LC<')&&!window.__brandIcon.includes('>Fn<')&&window.__brandingErrors.length===0&&!document.body.innerText.includes('Financer')","LC icon or visible branding failed")
        let result:[String:Any]=["passed":true,"browser":"macOS WKWebView on isolated empty books","product":"Ledgercraft","iconMonogram":"LC","measurements":measurements,"finderRenamed":true,"backupAndTallyWordingRenamed":true,"pageErrors":[]]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-results.json"));window.close()
    }
}
try MainActor.assumeIsolated {let app=NSApplication.shared,runner=try BrandingRunner(CommandLine.arguments[1]);app.delegate=runner;app.setActivationPolicy(.accessory);app.run()}
