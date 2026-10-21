import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import java.io.*;
public class MonologueDump extends GhidraScript {
 public void run() throws Exception {
  DecompInterface di=new DecompInterface();di.openProgram(currentProgram);
  String[] args=getScriptArgs();String dir=args[0];new File(dir).mkdirs();
  for(int i=1;i<args.length;i++){long a=Long.decode(args[i]);Function f=getFunctionContaining(toAddr(a));if(f==null)f=createFunction(toAddr(a),null);if(f==null)continue;
   DecompileResults d=di.decompileFunction(f,60,monitor);
   String name=Long.toHexString(f.getEntryPoint().getOffset());try(PrintWriter w=new PrintWriter(new File(dir,name+".c"))){w.println("// entry "+f.getEntryPoint());if(d.decompileCompleted())w.println(d.getDecompiledFunction().getC());else w.println(d.getErrorMessage());}
   println("DECOMPILED "+name);
  }
  di.dispose();
 }
}
