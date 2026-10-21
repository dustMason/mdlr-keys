#!/usr/bin/env python3
"""Reproduce decoded controls and bounded first-note reference excerpts."""
from pathlib import Path
import argparse,hashlib,json,urllib.parse
import numpy as np
import soundfile as sf
from decode_patch import decode
BASE=Path(__file__).resolve().parent/'data'
# Boundaries inferred from RMS/periodicity; performance timing was not published.
# Crop boundaries never encompass a second note. Later S0S event avoids fade-in.
CASES=[
 ('s0s_triangle','S0S',1.222,1.625,76,.05,.347,'train','Clean open-filter triangles; recorded note88 sounds76. First three source events faded, so excluded.'),
 ('harpie_saw','Harpie',.146,.745,48,.05,None,'train','Single VCO2 saw with one-shot shape modulation; crop excludes next note. Recorded note60 sounds48.'),
 ('pinoesque','Pinoesque',.410,1.000,48,.05,None,'train','Two oscillators, post-VCA drive; manually played first C3 inferred from audio. Gate-off lies outside crop.'),
 ('string_hold','String Hold',.418,1.300,57,.05,None,'held_out','Single VCO2 saw plus stronger drive and shape modulation; first A3 inferred, gate-off outside crop.'),
]

def main():
 global BASE
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--data-root',type=Path,default=BASE);a=p.parse_args();BASE=a.data_root.resolve()
 corpus=BASE/'corpus';corpus.mkdir(exist_ok=True)
 prov=json.loads((BASE/'callimero/provenance.json').read_text());commit=prov['commit']
 manifest={'version':1,'sample_rate':48000,'reference_repository':'https://github.com/callimero/Monologue','reference_commit':commit,'license':'MIT (see callimero/LICENSE)',
  'warnings':['Patch parameters are paired with source audio, but MIDI performance and recording gain were not published.',
   'Note/gate timings and sounding MIDI pitch are inferred, not hardware-verified. Gain is fitted per excerpt.',
   'Pinoesque amplitude velocity sensitivity is 50/127 and cutoff velocity sensitivity is 50%; its unknown performance velocity is profiled on a fixed grid. Earlier runs assumed 0.8.',
   'No pitch/time warping in the objective; oscillator start phase is unobserved.',
   'These four expressive patches do not identify every analog transfer function. Hold-out must never enter optimization.'],
  'cases':[]}
 for ident,name,start,end,note,on,off,split,notes in CASES:
  patch=BASE/'callimero/patches'/(name+'.prog_bin');wav=patch.with_suffix('.wav');x,sr=sf.read(wav,always_2d=True)
  ref=corpus/(ident+'.reference.wav');sf.write(ref,x[round(start*sr):round(end*sr)],sr,subtype='PCM_24')
  ev=[{'time':on,'note':note,'velocity':.8,'type':'on'}]
  if off is not None:ev.append({'time':off,'note':note,'velocity':0,'type':'off'})
  (corpus/(ident+'.events.json')).write_text(json.dumps(ev,indent=2)+'\n')
  decoded=decode(patch)
  (corpus/(ident+'.patch.json')).write_text(json.dumps(decoded,indent=2)+'\n')
  manifest['cases'].append({'id':ident,'split':split,'program':str(patch.relative_to(BASE)),
   'reference':str(ref.relative_to(BASE)),'events':'corpus/'+ident+'.events.json','duration':end-start,
   'source_audio':str(wav.relative_to(BASE)),'source_crop_seconds':[start,end],
   'sounding_note':note,'velocity':.8,'velocity_confidence':('unknown and profiled; amplitude and filter velocity sensitivities enabled' if decoded['scalar']['amp_velocity'] or decoded['scalar']['cutoff_velocity'] else 'assumed; decoded amplitude/filter velocity sensitivities both 0'),
   'amp_velocity_raw':decoded['scalar']['amp_velocity'],'cutoff_velocity_raw':decoded['scalar']['cutoff_velocity'],
   'notes':notes})
  if decoded['scalar']['amp_velocity'] or decoded['scalar']['cutoff_velocity']:manifest['cases'][-1]['velocity_candidates']=[v/127 for v in [1,16,32,48,64,80,96,112,127]]
 (BASE/'corpus.json').write_text(json.dumps(manifest,indent=2)+'\n')
 # Rebuild source provenance for every downloaded original, pinning the same revision.
 rows=[]
 for p in sorted((BASE/'callimero').rglob('*')):
  if not p.is_file() or p.name in ['provenance.json','tree.json'] or p.suffix=='.prog_bin':continue
  rel=p.relative_to(BASE/'callimero').as_posix();d=p.read_bytes()
  rows.append({'path':rel,'url':'https://raw.githubusercontent.com/callimero/Monologue/'+commit+'/'+urllib.parse.quote(rel),
   'bytes':len(d),'sha256':hashlib.sha256(d).hexdigest()})
 prov['files']=rows;(BASE/'callimero/provenance.json').write_text(json.dumps(prov,indent=2)+'\n')
 print(json.dumps({'cases':len(CASES),'manifest':str(BASE/'corpus.json'),'source_files':len(rows)},indent=2))
if __name__=='__main__':main()
