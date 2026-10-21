import ghidra.app.script.GhidraScript;
import java.math.BigInteger;
public class MonologueInit extends GhidraScript {
 public void run() throws Exception {
  currentProgram.getProgramContext().setValue(currentProgram.getRegister("TMode"),toAddr(0),toAddr(0x3ffff),BigInteger.ONE);
  int[] entries={0x44,0x60,0xa8,0xd4,0x4140,0x7234,0x7528,0x758c};
  for(int e:entries){disassemble(toAddr(e));createFunction(toAddr(e),null);}
  for(int p=0x4000;p<0x4100;p+=4){int e=getInt(toAddr(p));if(e>0x4140&&e<0x20000&&(e&1)==1){disassemble(toAddr(e&~1));createFunction(toAddr(e&~1),null);}}
 }
}
