import SwiftUI
// A displayed octave can change while a mouse gesture is held. Release the
// pitch pressed at its start, and emit at most one down/up per gesture.
struct TouchKeyOrigin {
    private var pitch:Int?
    var isHeld:Bool { pitch != nil }
    mutating func press(_ note:Int) -> Int? {
        guard pitch == nil else { return nil };pitch=note;return note
    }
    mutating func release() -> Int? { defer { pitch=nil };return pitch }
}
#if os(iOS)
import UIKit
struct PianoKeyboard: UIViewRepresentable {
    let baseNote: Int
    let accent: Color
    let changed: (Int,Bool)->Void
    func makeUIView(context:Context)->PianoView {let v=PianoView();v.isMultipleTouchEnabled=true;v.backgroundColor = .clear;return v}
    func updateUIView(_ view:PianoView,context:Context){view.base=baseNote;view.accent=UIColor(accent);view.changed=changed;view.setNeedsDisplay()}
    static func dismantleUIView(_ view:PianoView,coordinator:()){view.releaseAll()}
}
final class PianoView: UIView {
    var base=48
    var accent=UIColor.cyan
    var changed:((Int,Bool)->Void)?
    private var fingers:[ObjectIdentifier:Int]=[:]
    private let whites=[0,2,4,5,7,9,11,12,14,16,17,19,21,23]
    private let blacks=[(1,1),(3,2),(6,4),(8,5),(10,6),(13,8),(15,9),(18,11),(20,12),(22,13)]
    private func blackRect(_ boundary:Int)->CGRect{let w=bounds.width/14;return CGRect(x:CGFloat(boundary)*w-w*0.3,y:0,width:w*0.6,height:bounds.height*0.62)}
    override func draw(_ rect:CGRect){
        let active=Set(fingers.values),w=bounds.width/14
        for (i,n) in whites.enumerated(){let r=CGRect(x:CGFloat(i)*w+1,y:0,width:w-2,height:bounds.height);(active.contains(n+base) ? accent:UIColor(white:0.87,alpha:1)).setFill();UIBezierPath(roundedRect:r,cornerRadius:5).fill()
            if n%12==0 {let title="C\((base+n)/12-1)" as NSString;title.draw(at:CGPoint(x:r.minX+6,y:r.maxY-23),withAttributes:[.font:UIFont.monospacedSystemFont(ofSize:11,weight:.medium),.foregroundColor:UIColor.darkGray])}
        }
        for (n,b) in blacks{(active.contains(n+base) ? accent:UIColor(white:0.12,alpha:1)).setFill();UIBezierPath(roundedRect:blackRect(b),cornerRadius:4).fill()}
    }
    private func note(at p:CGPoint)->Int?{guard bounds.contains(p) else{return nil};for(n,b)in blacks{if blackRect(b).contains(p){return base+n}};return base+whites[min(13,max(0,Int(p.x/(bounds.width/14))))]}
    private func update(_ touches:Set<UITouch>){for t in touches{let id=ObjectIdentifier(t),old=fingers[id],new=note(at:t.location(in:self));if old != new{if let old{fingers.removeValue(forKey:id);if !fingers.values.contains(old){changed?(old,false)}};if let new{let already=fingers.values.contains(new);fingers[id]=new;if !already{changed?(new,true)}}}};setNeedsDisplay()}
    override func touchesBegan(_ touches:Set<UITouch>,with event:UIEvent?){update(touches)}
    override func touchesMoved(_ touches:Set<UITouch>,with event:UIEvent?){update(touches)}
    override func touchesEnded(_ touches:Set<UITouch>,with event:UIEvent?){for t in touches{if let n=fingers.removeValue(forKey:ObjectIdentifier(t)), !fingers.values.contains(n){changed?(n,false)}};setNeedsDisplay()}
    override func touchesCancelled(_ touches:Set<UITouch>,with event:UIEvent?){touchesEnded(touches,with:event)}
    func releaseAll(){for n in Set(fingers.values){changed?(n,false)};fingers.removeAll();setNeedsDisplay()}
}
#else
struct PianoKeyboard: View {
    let baseNote: Int
    let accent: Color
    let changed: (Int,Bool)->Void
    var body:some View{HStack(spacing:2){ForEach(0..<24){n in MacKey(note:baseNote+n,accent:accent,changed:changed)}}}
}
private struct MacKey:View{
    let note:Int
    let accent:Color
    let changed:(Int,Bool)->Void
    @State private var origin=TouchKeyOrigin()
    private var black:Bool{[1,3,6,8,10].contains(note%12)}
    var body:some View{RoundedRectangle(cornerRadius:4).fill(origin.isHeld ? accent:black ? Color(white:0.17):Color(white:0.87)).overlay(alignment:.bottom){Text(note%12==0 ? "C\(note/12-1)":"").font(.caption).foregroundStyle(.gray).padding(.bottom,8)}.gesture(DragGesture(minimumDistance:0).onChanged{_ in if let held=origin.press(note){changed(held,true)}}.onEnded{_ in if let held=origin.release(){changed(held,false)}}).onDisappear{if let held=origin.release(){changed(held,false)}}}
}
#endif
