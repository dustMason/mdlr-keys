"""Compare frozen whole-engine sync renders; synthetic only, no sample recordings."""
from pathlib import Path
import hashlib,json,subprocess
import numpy as np
from scipy import signal
import soundfile as sf
import audit

HERE=Path(__file__).resolve().parent
import argparse
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline',type=Path,required=True)
parser.add_argument('--candidate',type=Path,required=True)
parser.add_argument('--candidate-ring-model',choices=['product','bridge','coupled-product','bridge-coupled'])
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
BINS={'baseline':args.baseline.resolve(),'sync':args.candidate.resolve()}
OUT=args.output.resolve();OUT.mkdir(parents=True,exist_ok=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
HASH={k:sha(p) for k,p in BINS.items()}
params={str(i):0 for i in range(37)}
params.update({'2':0,'5':1,'8':1,'9':1,'12':1,'14':.25,'16':2,'17':1,'19':.3,'23':.25,'29':1,'33':120})
params['28']=1200*np.log2(997.3/(440*2**((84-69)/12)))
cases=[('saw_plain',0,0,2.375,96),('saw_shaped',0,.8,2.375,96),('saw_ratio_below1',0,.8,.73,96),('saw_ratio_below4',0,.8,3.995,96),('saw_ratio_above4',0,.8,4.005,96),('triangle_plain',1,0,2.375,96),('triangle_fold',1,.8,2.375,96),('high_saw',0,.8,2.375,120),('high_triangle',1,0,2.375,120)]
results=[]
for name,kind,shape,ratio,note in cases:
 octave=int(np.floor(np.log2(ratio)));tune=1200*(np.log2(ratio)-octave)
 p=params|{'3':kind,'4':shape,'6':octave,'7':tune}
 pp=OUT/(name+'.params.json');pp.write_text(json.dumps(p,indent=2)+'\n')
 ep=OUT/(name+'.events.json');ep.write_text(json.dumps([{'time':0,'type':'on','note':note,'velocity':1}])+'\n')
 fm=997.3*2**((note-96)/12)
 row={'case':name,'master_hz':fm,'slave_ratio':ratio,'params':p,'events':json.loads(ep.read_text()),'renders':[]}
 for model,binary in BINS.items():
  for sr in [44100,48000,96000,192000]:
   wav=OUT/f'{name}.{model}.{sr}.wav'
   subprocess.run([str(binary),'--params',str(pp),'--events',str(ep),'--sample-rate',str(sr),'--duration','1','--output',str(wav),'--oscillator-phases','0.137,0.731']+(['--ring-model',args.candidate_ring_model] if model=='sync' and args.candidate_ring_model else []),capture_output=True,check=True)
   x,rate=sf.read(wav,dtype='float64');assert np.isfinite(x).all() and max(abs(x))<.999
   if sr==44100:x=signal.resample_poly(x,160,147,window=('kaiser',12))
   elif sr!=48000:
    filt=signal.remez(255,[0,20000,24000,sr/2],[1,0],weight=[1,100],fs=sr)
    x=signal.resample_poly(x,1,sr//48000,window=filt)
   f,power=audit.spectrum(x);mask=(f>40)&(f<16000);harm=np.zeros(len(f),bool)
   for h in range(1,int(24000/fm)+1):harm|=abs(f-h*fm)<=30
   residue=float(10*np.log10(max(power[mask&~harm].sum(),1e-30)/power[mask].sum()))
   row['renders'].append({'model':model,'render_rate':sr,'off_harmonic_16k_db':residue,'audio_sha256':sha(wav)})
 results.append(row)
 print(name,[(r['model'],r['render_rate'],round(r['off_harmonic_16k_db'],2)) for r in row['renders']],flush=True)
report={'renderer_sha256':HASH,'script_sha256':sha(Path(__file__)),'candidate_ring_model':args.candidate_ring_model,'analysis_band_hz':[40,16000],'harmonic_half_width_hz':30,'analysis_window_s':[.2,.95],'cases':results,'notes':['Synthetic steady notes; no hardware references used and no reset parameter retuned.','48/96/192k renders use a shared 48k analysis rate with offline 20k-pass/24k-stop resampling; 44.1k uses rational Kaiser resampling.','Native final FIR cutoff scales with render rate; measurements stop at 16k, below every native transition.','Off-harmonic residual does not measure aliases coincident with harmonics; reference Fourier audit separately checks harmonic/timing error.','Above max supported notes the internal increment cap can alter ratios; chosen cases stay below that cap.']}
(OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
for k,p in BINS.items():assert sha(p)==HASH[k]
