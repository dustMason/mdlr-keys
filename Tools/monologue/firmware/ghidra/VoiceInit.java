import ghidra.app.script.GhidraScript;
import java.math.BigInteger;
public class VoiceInit extends GhidraScript {
 public void run() throws Exception {
  currentProgram.getProgramContext().setValue(currentProgram.getRegister("TMode"),toAddr(0),toAddr(0x97ff),BigInteger.ONE);
  for(int p=0x4004;p<0x4100;p+=4){int e=getInt(toAddr(p));if(e>0x110&&e<0x9000&&(e&1)==1){disassemble(toAddr(e&~1));createFunction(toAddr(e&~1),null);}}
  disassemble(toAddr(0x8f54));createFunction(toAddr(0x8f54),null);
 }
}
