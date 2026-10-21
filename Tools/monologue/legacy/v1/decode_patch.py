#!/usr/bin/env python3
"""Read, never execute, Korg .molgprog ZIP or its 448-byte PROG payload.
Primary schema: Korg monologue MIDI implementation 1.00, Table 2.
The note P1 summary rotates offsets26/27/28 incorrectly; Table2 and paired
MonoCtrl screenshots consistently use EG INT26/LFO RATE27/LFO INT28.
"""
import argparse, hashlib, json, zipfile
from pathlib import Path

TEN_BIT = {
 'vco1_pitch':(16,30,0), 'vco1_shape':(17,30,2),
 'vco2_pitch':(18,31,0), 'vco2_shape':(19,31,2),
 'vco1_level':(20,33,0), 'vco2_level':(21,33,2),
 'cutoff':(22,33,4), 'resonance':(23,33,6),
 'eg_attack':(24,34,2), 'eg_decay':(25,34,4),
 'eg_int':(26,35,0), 'lfo_rate':(27,35,2),
 'lfo_int':(28,35,4), 'drive':(29,35,6),
}
ENUMS = {
 'vco1_octave':(30,4,3,["16'","8'","4'","2'"]),
 'vco1_wave':(30,6,3,['square','triangle','saw']),
 'vco2_octave':(31,4,3,["16'","8'","4'","2'"]),
 'vco2_wave':(31,6,3,['noise','triangle','saw']),
 'sync_ring':(32,0,3,['ring','off','sync']),
 'eg_type':(34,0,3,['gate','attack_gate_decay','attack_decay']),
 'eg_target':(34,6,3,['cutoff','pitch2','pitch']),
 'lfo_wave':(36,0,3,['square','triangle','saw']),
 'lfo_mode':(36,2,3,['one_shot','slow','fast']),
 'lfo_target':(36,4,3,['cutoff','shape','pitch']),
}
def read_patch(path):
 path=Path(path)
 if zipfile.is_zipfile(path):
  with zipfile.ZipFile(path) as z:
   entries=[i for i in z.infolist() if i.filename.endswith('.prog_bin')]
   if len(entries)!=1 or entries[0].file_size!=448: raise ValueError('Expected one 448-byte program')
   b=z.read(entries[0])
 else:b=path.read_bytes()
 if len(b)!=448 or b[:4]!=b'PROG' or b[48:52]!=b'SEQD':raise ValueError('Invalid monologue program markers/length')
 return b

def decode(path):
 b=read_patch(path)
 raw={k:(b[hi]<<2)|((b[lo]>>shift)&3) for k,(hi,lo,shift) in TEN_BIT.items()}
 enum_raw={k:(b[pos]>>shift)&mask for k,(pos,shift,mask,labels) in ENUMS.items()}
 named={k:labels[enum_raw[k]] if enum_raw[k]<len(labels) else 'reserved' for k,(_,_,_,labels) in ENUMS.items()}
 scalar={'keyboard_octave':((b[32]>>2)&7)-2,'program_tuning_cents':b[37]-50,'micro_tuning':b[38],
  'scale_key':b[39]-12,'slide_time':b[40],'portamento_time':b[41],'slider_assign':b[42],
  'bend_up':b[43]&15,'bend_down':b[43]>>4,'portamento_mode':b[44]&1,'lfo_bpm_sync':(b[44]>>3)&1,
  'cutoff_velocity':(b[44]>>4)&3,'cutoff_keytrack':(b[44]>>6)&3,'program_level_db':b[45]-102,'amp_velocity':b[46]}
 steps=[]
 for i in range(16):
  s=b[96+22*i:118+22*i]
  steps.append({'index':i,'note':s[0],'velocity':s[2],'gate_raw':s[4]&127,'trigger':s[4]>>7,
   'motion_bytes':list(s[6:22])})
 return {'name':b[4:16].split(b'\0')[0].decode('ascii','replace'),'sha256':hashlib.sha256(b).hexdigest(),
  'raw10':raw,'enum_raw':enum_raw,'named':named,'scalar':scalar,
  'normalized':{k:(v-512)/512 if k in ['eg_int','lfo_int'] else v/1023 for k,v in raw.items()},
  'sequence':{'bpm':(b[52]+((b[53]&15)<<8))/10,'length':b[54],'resolution':b[55],
   'enabled_steps':b[64]|b[65]<<8,'slide_steps':b[68]|b[69]<<8,'motion_settings':list(b[72:88]),'steps':steps},
  'warnings':['Table2 offsets used instead of conflicting noteP1 summary.',
   'Step event stride is22 bytes from S2/448-byte total; Table2 first event ranges contain a typographical error.',
   'Normalized values are control positions, not measured analog transfer functions.']}

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('program',type=Path);p.add_argument('--output',type=Path);a=p.parse_args()
 s=json.dumps(decode(a.program),indent=2)+'\n'
 if a.output:a.output.write_text(s)
 else:print(s,end='')
