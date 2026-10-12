import SwiftUI
import WebKit

#if os(macOS)
typealias PanelRepresentable = NSViewRepresentable
#else
typealias PanelRepresentable = UIViewRepresentable
#endif

/// The original React/CSS instrument face is bundled locally. Only parameter
/// messages cross this bridge; audio and MIDI remain on the native side.
struct OriginalPanelView: PanelRepresentable {
    @ObservedObject var model: InstrumentModel
    var zoom: Double
    func makeCoordinator() -> Coordinator { Coordinator(model:model) }
#if os(macOS)
    func makeNSView(context:Context) -> WKWebView { makeWebView(context) }
    func updateNSView(_ view:WKWebView,context:Context) { context.coordinator.sync(view,zoom:zoom) }
    static func dismantleNSView(_ view:WKWebView,coordinator:Coordinator) { coordinator.detach(view) }
#else
    func makeUIView(context:Context) -> WKWebView { makeWebView(context) }
    func updateUIView(_ view:WKWebView,context:Context) { context.coordinator.sync(view,zoom:zoom) }
    static func dismantleUIView(_ view:WKWebView,coordinator:Coordinator) { coordinator.detach(view) }
#endif
    private func makeWebView(_ context:Context) -> WKWebView {
        let config=WKWebViewConfiguration()
        config.userContentController.add(context.coordinator,name:"mdlr")
        let view=WKWebView(frame:.zero,configuration:config)
        view.navigationDelegate=context.coordinator
#if os(iOS)
        view.isOpaque=false;view.backgroundColor = .clear
        view.scrollView.isScrollEnabled=false
#endif
        if let url=Bundle.main.url(forResource:"index",withExtension:"html",subdirectory:"WebPanel") {
            context.coordinator.root=url.deletingLastPathComponent()
            view.loadFileURL(url,allowingReadAccessTo:url.deletingLastPathComponent())
        } else { model.notice="Original panel files are missing. Choose All controls." }
        return view
    }
    @MainActor final class Coordinator:NSObject,WKScriptMessageHandler,WKNavigationDelegate {
        let model:InstrumentModel
        var root:URL?
        private var ready=false
        private var previous=""
        private var zoom=1.0
        init(model:InstrumentModel){self.model=model}
        func detach(_ view:WKWebView){view.configuration.userContentController.removeScriptMessageHandler(forName:"mdlr");view.navigationDelegate=nil}
        func sync(_ view:WKWebView,zoom:Double){
            self.zoom=zoom
            guard ready else{return}
            let parameters=Dictionary(uniqueKeysWithValues:model.engine.params.map{(String($0.id),model.value($0))})
            let snapshot:[String:Any]=["engine":model.selected,"params":parameters,"zoom":zoom]
            guard let data=try? JSONSerialization.data(withJSONObject:snapshot,options:.sortedKeys),let json=String(data:data,encoding:.utf8),json != previous else{return}
            previous=json
            view.evaluateJavaScript("window.mdlrPanel?.setState(\(json));") { [weak self] _,error in
                if let error {self?.model.notice="Panel update failed: \(error.localizedDescription)";self?.previous=""}
            }
        }
        func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage){
            guard message.frameInfo.isMainFrame,let url=message.frameInfo.request.url,allowed(url),let body=message.body as? [String:Any],let type=body["type"] as? String else{return}
            if type=="ready",let view=message.webView {ready=true;previous="";sync(view,zoom:zoom);return}
            guard type=="parameter",let engine=body["engine"] as? Int,engine==model.selected,let id=body["id"] as? Int,let value=body["value"] as? Double,value.isFinite,let parameter=model.engine.params.first(where:{$0.id==id}) else{return}
            model.set(parameter,min(parameter.max,max(parameter.min,value)))
        }
        private func allowed(_ url:URL)->Bool {url.isFileURL && root.map{url.standardizedFileURL.path.hasPrefix($0.standardizedFileURL.path+"/")} == true}
        func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){ready=true;sync(webView,zoom:zoom)}
        func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){decisionHandler(action.request.url.map{allowed($0)} == true ? .allow:.cancel)}
        func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error){model.notice="Panel failed to load. All controls is still available."}
        func webViewWebContentProcessDidTerminate(_ webView:WKWebView){ready=false;previous="";webView.reload()}
    }
}
