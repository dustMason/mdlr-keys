"""Analysis-only ELF adapter: unchanged raw firmware bytes mapped to flash zero."""
from pathlib import Path
import struct, argparse
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory',type=Path)
p=parser.parse_args().directory;b=(p/'voice.bin').read_bytes()
names=b'\0.text\0.bss\0.shstrtab\0';off=0x1000;strings=off+len(b);shoff=(strings+len(names)+15)&~15
ident=b'\x7fELF'+bytes([1,1,1])+bytes(9)
h=ident+struct.pack('<HHIIIIIHHHHHH',2,40,1,0x8f55,52,shoff,0x5000200,52,32,2,40,4,3)
ph=struct.pack('<8I',1,off,0,0,len(b),len(b),5,0x1000)+struct.pack('<8I',1,0,0x1fffe000,0x1fffe000,0,0x4000,6,0x1000)
out=bytearray(h+ph);out+=bytes(off-len(out));out+=b+names;out+=bytes(shoff-len(out));out+=bytes(40)
out+=struct.pack('<10I',1,1,6,0,off,len(b),0,0,4,0)
out+=struct.pack('<10I',7,8,3,0x1fffe000,0,0x4000,0,0,4,0)
out+=struct.pack('<10I',12,3,0,0,strings,len(names),0,0,1,0)
(p/'voice-analysis.elf').write_bytes(out)
