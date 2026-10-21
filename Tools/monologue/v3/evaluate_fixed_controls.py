"""Render known controls with one preserved v2 performance, without selection."""
from pathlib import Path
import argparse,hashlib,json,subprocess
from metric_v3 import compare_files
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--renderer',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--performances',type=Path,default=Path(__file__).resolve().parent/'fixed-regression-performances.json');p.add_argument('--output',type=Path,required=True);p.add_argument('--ring-model');a=p.parse_args();root=a.manifest.resolve().parent;m=json.loads(a.manifest.read_text());perf=json.loads(a.performances.read_text());protocol=root/m.get('protocol','protocol-v3.json');pconf=json.loads(protocol.read_text());idle=pconf.get('preconditioning',{}).get('idle_seconds',0);assert sha(Path(__file__).resolve().parent/'metric_v3.py')==pconf['metric_sha256'];a.output.mkdir(parents=True,exist_ok=True);renderer=a.renderer.resolve();rows=[]
 provenance={'renderer_sha256':sha(renderer),'manifest_sha256':sha(a.manifest),'protocol_sha256':sha(protocol),'performance_sha256':sha(a.performances),'metric_sha256':pconf['metric_sha256'],'runner_sha256':sha(Path(__file__)),'idle_seconds':idle,'ring_model':a.ring_model}
 for c in m['cases']:
  if c['split']!='regression':continue
  for key in ['program','reference']:assert sha(root/c[key])==c[key+'_sha256']
  assert sha(renderer)==provenance['renderer_sha256'];prior=perf['cases'][c['id']];ep=a.output/(c['id']+'.events.json');ep.write_text(json.dumps(prior['events'],indent=2)+'\n');wp=a.output/(c['id']+'.wav');cmd=[str(renderer),'--output',str(wp),'--program',str(root/c['program']),'--events',str(ep),'--sample-rate','48000','--duration',str(c['duration']),'--lfo-phase',str(prior['selected_lfo_phase'])]
  if idle:cmd+=['--idle-seconds',str(idle)]
  if a.ring_model:cmd+=['--ring-model',a.ring_model]
  if prior['selected_oscillator_phases'] is not None:cmd+=['--oscillator-phases',','.join(map(str,prior['selected_oscillator_phases']))]
  subprocess.run(cmd,check=True,capture_output=True);score=compare_files(root/c['reference'],wp,pitch_hz=440*2**((c['observed_base_note']-69)/12),end_s=c.get('spectral_end_seconds'),include_frames=True);(a.output/(c['id']+'.temporal.json')).write_text(json.dumps(score,indent=2)+'\n');row={'id':c['id'],'split':'regression','metrics':score,'wav_sha256':sha(wp),**{k:v for k,v in prior.items() if k.startswith('selected_')}};rows.append(row);print(c['id'],score['objective'],flush=True)
 report={'provenance':provenance,'performance_protocol':'Fixed previously selected v2 events and phase seeds; no new nuisance profiling. In v3.1, phase seeds are applied before the fixed12-second warmup.','cases':rows,'scores':{'regression':sum(r['metrics']['objective'] for r in rows)/len(rows)}};(a.output/'metrics.json').write_text(json.dumps(report,indent=2)+'\n')
if __name__=='__main__':main()
