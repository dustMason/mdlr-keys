#!/usr/bin/env python3
"""Render the fixed corpus and optionally hill-climb GLOBAL analog constants.
Uses training cases only for optimization; reports an untouched held-out case.
No patch controls, tuning, timing, or stored samples are fitted. An explicitly
unknown performance velocity may be profiled over a fixed documented grid.
"""
import argparse,json,subprocess,shutil
from pathlib import Path
from audio_compare import compare_files
BASE=Path(__file__).resolve().parent/'data'

class Runner:
 def __init__(self,renderer,manifest,output,max_lag_ms):
  self.renderer=renderer.resolve();self.manifest=json.loads(manifest.read_text());self.root=manifest.parent
  self.output=output.resolve();self.output.mkdir(parents=True,exist_ok=True);self.max_lag_ms=max_lag_ms;self.history=[]
 def evaluate(self,calibration,label,split=None):
  out=self.output/label;out.mkdir(exist_ok=True);cp=out/'calibration.json';cp.write_text(json.dumps(calibration,indent=2)+'\n');metrics=[]
  for case in self.manifest['cases']:
   if split and case['split']!=split:continue
   wav=out/(case['id']+'.wav');profile=[]
   velocities=case.get('velocity_candidates',[case['velocity']])
   for vi,velocity in enumerate(velocities):
    events=json.loads((self.root/case['events']).read_text())
    for event in events:
     if event['type']=='on':event['velocity']=velocity
    ep=out/(case['id']+f'.v{vi}.events.json');ep.write_text(json.dumps(events,indent=2)+'\n')
    vp=out/(case['id']+f'.v{vi}.wav')
    cmd=[str(self.renderer),'--output',str(vp),'--program',str(self.root/case['program']),
     '--events',str(ep),'--sample-rate','48000','--duration',str(case['duration']),'--calibration',str(cp)]
    run=subprocess.run(cmd,text=True,capture_output=True,timeout=45)
    if run.returncode:raise RuntimeError('Renderer failed: '+run.stderr[-3000:]+run.stdout[-1000:])
    scores=compare_files(self.root/case['reference'],vp,self.max_lag_ms)
    profile.append({'velocity':velocity,'metrics':scores,'index':vi})
   selected=min(profile,key=lambda row:row['metrics']['objective']);vi=selected['index']
   shutil.copyfile(out/(case['id']+f'.v{vi}.wav'),wav)
   shutil.copyfile(out/(case['id']+f'.v{vi}.events.json'),out/(case['id']+'.events.json'))
   for pi in range(len(velocities)):
    (out/(case['id']+f'.v{pi}.wav')).unlink();(out/(case['id']+f'.v{pi}.events.json')).unlink()
   metrics.append({'id':case['id'],'split':case['split'],'metrics':selected['metrics'],
    'selected_velocity':selected['velocity'],'velocity_policy':'profiled_unknown_performance' if len(velocities)>1 else 'fixed',
    'velocity_profile':[{'velocity':row['velocity'],'objective':row['metrics']['objective'],
      'fitted_gain_db':row['metrics']['fitted_gain_db'],'envelope_mae_db':row['metrics']['envelope_mae_db'],
      'spectral_mae_db':row['metrics']['spectral_mae_db']} for row in profile]})
  means={s:sum(c['metrics']['objective'] for c in metrics if c['split']==s)/sum(c['split']==s for c in metrics) for s in ['train','held_out'] if any(c['split']==s for c in metrics)}
  report={'calibration':calibration,'scores':means,'cases':metrics}
  (out/'metrics.json').write_text(json.dumps(report,indent=2)+'\n')
  self.history.append({'label':label,'calibration':dict(calibration),'scores':means})
  (self.output/'history.json').write_text(json.dumps(self.history,indent=2)+'\n')
  return report

# Only shape/filter/drive constants with evidence in this small corpus.
# Boundaries deliberately tighter than renderer safety limits.
DEFAULT_SPACE={
 'cutoff_curve':{'initial':1.0,'low':.65,'high':1.5,'step':.2},
 'filter_eg_octaves':{'initial':8.0,'low':4.0,'high':12.0,'step':2.0},
 'shape_amount':{'initial':2.0,'low':0.0,'high':4.0,'step':.75},
 'drive_mix_curve':{'initial':1.0,'low':.5,'high':2.0,'step':.3},
 'drive_gain':{'initial':12.0,'low':4.0,'high':24.0,'step':4.0},
 'triangle_shape_amount':{'initial':4.0,'low':0.0,'high':8.0,'step':2.0},
 'triangle_shape_fall':{'initial':1.0,'low':0.0,'high':2.0,'step':.5},
}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('renderer',type=Path);p.add_argument('--data-root',type=Path,default=BASE);p.add_argument('--manifest',type=Path);p.add_argument('--output',type=Path);p.add_argument('--calibration',type=Path);p.add_argument('--max-lag-ms',type=float,default=20);p.add_argument('--fit',action='store_true');p.add_argument('--passes',type=int,default=2);p.add_argument('--space',type=Path);a=p.parse_args()
 a.manifest=a.manifest or a.data_root/'corpus.json';a.output=a.output or a.data_root/'runs/calibration'
 runner=Runner(a.renderer,a.manifest,a.output,a.max_lag_ms);cal=json.loads(a.calibration.read_text()) if a.calibration else {}
 space=json.loads(a.space.read_text()) if a.space else DEFAULT_SPACE
 if a.fit:
  for k,v in space.items():cal.setdefault(k,v['initial'])
 baseline=runner.evaluate(cal,'baseline');print(json.dumps({'baseline':baseline['scores']}),flush=True)
 if not a.fit:return
 best=baseline['scores']['train'];trial=0
 for iteration in range(a.passes):
  for key,spec in space.items():
   current=dict(cal);candidates=[]
   for sign in [-1,1]:
    val=max(spec['low'],min(spec['high'],current[key]+sign*spec['step']/(2**iteration)))
    if val==current[key]:continue
    candidate={**current,key:val};trial+=1;label=f'trial-{trial:03d}'
    report=runner.evaluate(candidate,label,'train');score=report['scores']['train'];candidates.append((score,candidate))
    print(json.dumps({'trial':trial,'field':key,'value':val,'train_objective':score,'best':best}),flush=True)
    # Scores and exact constants persist; only baseline/final WAVs need retention.
    for wav in (runner.output/label).glob('*.wav'):wav.unlink()
   if candidates:
    score,candidate=min(candidates,key=lambda x:x[0])
    if score<best:best=score;cal=candidate
 final=runner.evaluate(cal,'best');(runner.output/'best-calibration.json').write_text(json.dumps(cal,indent=2)+'\n')
 summary={'baseline':baseline['scores'],'best':final['scores'],'training_improvement_percent':100*(baseline['scores']['train']-final['scores']['train'])/baseline['scores']['train'],
  'calibration':cal,'held_out_used_for_optimization':False,'limitations':runner.manifest['warnings']}
 (runner.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
if __name__=='__main__':main()
