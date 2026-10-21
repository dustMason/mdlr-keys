import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
public class MonologueRefs extends GhidraScript {
 public void run() throws Exception {
  for(String a:getScriptArgs()){
   Function f=getFunctionContaining(toAddr(Long.decode(a))); if(f==null){println("NOFUNCTION "+a);continue;}
   println("FUNCTION "+a+" = "+f.getEntryPoint());
   for(Reference r:getReferencesTo(f.getEntryPoint())){Function c=getFunctionContaining(r.getFromAddress());println("CALLER "+r.getFromAddress()+" "+(c==null?"?":c.getEntryPoint()));}
  }
 }
}
