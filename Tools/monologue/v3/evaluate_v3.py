#!/usr/bin/env python3
"""Frozen sync/ring evaluation. Profiles performance, never synth calibration."""
from pathlib import Path
import argparse,concurrent.futures,hashlib,itertools,json,shutil,subprocess,sys,time
from metric_v3 import compare_files
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'v2'))
from calibrate_v2 import candidate_events
from audio_compare import compare_files as legacy_compare_files
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()

def evaluate(renderer,manifest_path,output,splits,workers=4,ring_model=None):
    root=manifest_path.resolve().parent;manifest=json.loads(manifest_path.read_text());renderer=renderer.resolve();output=output.resolve();output.mkdir(parents=True,exist_ok=True)
    protocol=root/manifest.get('protocol','protocol-v3.json');protocol_data=json.loads(protocol.read_text());idle_seconds=protocol_data.get('preconditioning',{}).get('idle_seconds',0);expected=protocol_data['metric_sha256'];assert sha(Path(__file__).resolve().parent/'metric_v3.py')==expected,'Frozen metric changed'
    provenance={'renderer_sha256':sha(renderer),'manifest_sha256':sha(manifest_path),'protocol_sha256':sha(protocol),'metric_sha256':sha(Path(__file__).resolve().parent/'metric_v3.py'),'runner_sha256':sha(Path(__file__)),'ring_model':ring_model,'idle_seconds':idle_seconds};started=time.monotonic();rows=[]
    for case in manifest['cases']:
        if case['split'] not in splits:continue
        assert sha(renderer)==provenance['renderer_sha256'],'Renderer changed during evaluation'
        for key in ['reference','program','events']:assert sha(root/case[key])==case[key+'_sha256'],('Corpus changed',case['id'],key)
        original=json.loads((root/case['events']).read_text());grid=list(itertools.product(case.get('velocity_candidates',[case['velocity']]),case.get('gate_off_candidates',[None]),case.get('oscillator_phase_candidates',[None]),case.get('lfo_phase_candidates',[0])))
        def trial(item):
            index,(velocity,gate,phases,lfo)=item;events=candidate_events(original,velocity,gate);ep=output/(case['id']+f'.{index}.events.json');ep.write_text(json.dumps(events,indent=2)+'\n');wp=ep.with_suffix('.wav');cmd=[str(renderer),'--output',str(wp),'--program',str(root/case['program']),'--events',str(ep),'--duration',str(case['duration']),'--sample-rate','48000','--lfo-phase',str(lfo)]
            if phases is not None:cmd+=['--oscillator-phases',','.join(map(str,phases))]
            if ring_model is not None:cmd+=['--ring-model',ring_model]
            if idle_seconds:cmd+=['--idle-seconds',str(idle_seconds)]
            done=subprocess.run(cmd,capture_output=True,text=True,timeout=30)
            if done.returncode:raise RuntimeError(done.stderr+done.stdout)
            metrics=compare_files(root/case['reference'],wp,pitch_hz=440*2**((case['observed_base_note']-69)/12),end_s=case.get('spectral_end_seconds'))
            return {'index':index,'velocity':velocity,'gate_off':gate,'oscillator_phases':phases,'lfo_phase':lfo,'metrics':metrics}
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:profile=list(pool.map(trial,enumerate(grid)))
        best=min(profile,key=lambda x:x['metrics']['objective']);stem=output/(case['id']+f".{best['index']}.events.json");ep=output/(case['id']+'.events.json');wave=output/(case['id']+'.wav');shutil.copyfile(stem,ep);shutil.copyfile(stem.with_suffix('.wav'),wave)
        for item in profile:
            p=output/(case['id']+f".{item['index']}.events.json");p.with_suffix('.wav').unlink();p.unlink()
        detail=compare_files(root/case['reference'],wave,pitch_hz=440*2**((case['observed_base_note']-69)/12),end_s=case.get('spectral_end_seconds'),include_frames=True);(output/(case['id']+'.temporal.json')).write_text(json.dumps(detail,indent=2)+'\n')
        record={'id':case['id'],'split':case['split'],'metrics':best['metrics'],'selected_velocity':best['velocity'],'selected_gate_off':best['gate_off'],'selected_oscillator_phases':best['oscillator_phases'],'selected_lfo_phase':best['lfo_phase'],'gate_at_profile_boundary':bool(case.get('gate_off_candidates') and best['gate_off'] in [min(case['gate_off_candidates']),max(case['gate_off_candidates'])]),'velocity_at_profile_boundary':bool(case.get('velocity_candidates') and best['velocity'] in [min(case['velocity_candidates']),max(case['velocity_candidates'])]),'minimum_v2_objective_same_grid':min(r['metrics']['v2_objective'] for r in profile),'wav_sha256':sha(wave),'legacy_metrics':legacy_compare_files(root/case['reference'],wave,4),'nuisance_profile':[{k:v for k,v in r.items() if k!='metrics'}|{'objective':r['metrics']['objective'],'v2_objective':r['metrics']['v2_objective'],'gain_db':r['metrics']['fitted_gain_db'],'transport_cents':r['metrics']['full_spectrum_transport']['mean_cents']} for r in profile]}
        rows.append(record);print(json.dumps({'case':case['id'],'trials':len(profile),'objective':best['metrics']['objective'],'v2':best['metrics']['v2_objective'],'transport':best['metrics']['full_spectrum_transport']['mean_cents'],'lfo':best['lfo_phase'],'phase':best['oscillator_phases'],'gate':best['gate_off']}),flush=True)
        report={'provenance':provenance,'cases':rows,'elapsed_seconds':time.monotonic()-started,'scores':{s:sum(r['metrics']['objective'] for r in rows if r['split']==s)/sum(r['split']==s for r in rows) for s in splits if any(r['split']==s for r in rows)},'selection':'Full frozen nuisance grids; no changes to native calibration. Per-case gain is for scoring only. V2 metrics are reported for the temporal-mean-selected performance, plus independent v2 minimum on same grid.'};(output/'metrics.json').write_text(json.dumps(report,indent=2)+'\n')
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--renderer',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True,help='Use the prepared corpus-v3.1.json for the active warm protocol');p.add_argument('--output',type=Path,required=True);p.add_argument('--split',choices=['development','regression','validation'],action='append',default=[]);p.add_argument('--workers',type=int,default=4);p.add_argument('--ring-model',choices=['product','bridge','coupled-product','bridge-coupled','bridge-coupled-aa','product-aa']);p.add_argument('--allow-validation',action='store_true',help='Only after parent freezes the final candidate');a=p.parse_args();splits=a.split or ['development']
    if 'validation' in splits and not a.allow_validation:p.error('Validation requires an explicit final-model freeze and --allow-validation')
    evaluate(a.renderer,a.manifest,a.output,splits,a.workers,a.ring_model)
