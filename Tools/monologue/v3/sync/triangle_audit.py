"""Whole-engine ring rate consistency; synthetic notes, no hardware sound fit."""
from pathlib import Path
import hashlib,json,re,subprocess
import numpy as np
import soundfile as sf
from scipy import signal
HERE=Path(__file__).resolve().parent
import argparse
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--renderer',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--low',action='store_true')
args=parser.parse_args()
LOW=args.low
OUT=args.output.resolve();OUT.mkdir(parents=True,exist_ok=True)
BINS={'raw':args.renderer.resolve(),'aa':args.renderer.resolve()}
FLAGS={'raw':'off','aa':'on'}
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
HASH={k:sha(p) for k,p in BINS.items()}
assert HASH['raw']==HASH['aa']
text=(HERE.parents[3]/'Rust/src/modules/monologue_fir.rs').read_text().split('= [')[1]
fir=np.array([float(x) for x in re.findall(r'[-+]?\d+\.\d+e[-+]?\d+',text)])
FM=55.0 if LOW else 1123.45
NOTE=45 if LOW else 97
base={str(i):0 for i in range(37)}
base.update({'2':0,'5':1,'8':2,'9':1,'12':1,'14':.25,'16':2,'17':1,'19':.3,'23':.15,'29':1,'33':120,'28':1200*np.log2(FM/(440*2**((NOTE-12-69)/12)))})
events=OUT/'held.events.json';events.write_text(json.dumps([{'time':0,'type':'on','note':NOTE,'velocity':1}])+'\n')
cases=[('saw_saw_shaped',0,.65,0,.8,19,8),('pulse_triangle',2,.35,1,0,19,8),('plain_triangle_pair',1,0,1,0,19,8),('triangle_triangle_fold',1,.8,1,.8,7,4),('pulse_saw_shaped',2,.8,0,.65,11,8)]
results=[]
for name,k1,s1,k2,s2,num,den in cases:
 ratio=num/den;octave=int(np.floor(np.log2(ratio)));tune=1200*(np.log2(ratio)-octave);f0=FM/den
 p=base|{'0':k1,'1':s1,'3':k2,'4':s2,'6':octave,'7':tune}
 pp=OUT/(name+'.params.json');pp.write_text(json.dumps(p,indent=2)+'\n')
 row={'case':name,'params':p,'master_hz':FM,'slave_ratio':ratio,'family_fundamental_hz':f0,'renders':[]}
 for model,binary in BINS.items():
  model_rows=[]
  for sr in ([48000] if LOW else [44100,48000,96000,192000]):
   wav=OUT/f'{name}.{model}.{sr}.wav'
   subprocess.run([str(binary),'--params',str(pp),'--events',str(events),'--sample-rate',str(sr),'--duration','4','--output',str(wav),'--oscillator-phases','0.137,0.731','--ring-model','product','--triangle-aa',FLAGS[model]],capture_output=True,check=True)
   x,rate=sf.read(wav);assert np.isfinite(x).all() and abs(x).max()<.999
   if sr==44100:x=signal.resample_poly(x,160,147,window=('kaiser',12))
   elif sr!=48000:x=signal.resample_poly(x,1,sr//48000,window=signal.remez(255,[0,20000,24000,sr/2],[1,0],weight=[1,100],fs=sr))
   x=x[48000:168000];dc=float(x.mean());x-=dc;nfft=2**int(np.ceil(np.log2(len(x)*8)))
   power=abs(np.fft.rfft(x*np.hanning(len(x)),nfft))**2;f=np.fft.rfftfreq(nfft,1/48000)
   band=(f>=40)&(f<16000);family=np.rint(f/f0).astype(int);near=abs(f-family*f0)<min(12,.4*f0);use=band&near
   off=10*np.log10(max(power[band&~near].sum(),1e-30)/power[band].sum())
   family_power=np.bincount(family[use],weights=power[use],minlength=int(16000/f0)+1)
   family_hz=np.arange(len(family_power))*f0
   response=abs(np.sum(np.exp(-2j*np.pi*family_hz[:,None]/(4*sr)*np.arange(len(fir))[None,:])*fir,axis=1))**2
   assert np.isfinite(response).all() and response.min()>.01
   corrected=family_power/np.maximum(response,1e-6)
   r={'model':model,'render_rate':sr,'off_family_16k_db':float(off),'mean_dc':dc,'audio_sha256':sha(wav),'family_power':family_power.tolist(),'fir_compensated_family_power':corrected.tolist()}
   model_rows.append(r)
  for r in model_rows:
   ref=model_rows[-1]
   for key,label in [('family_power','raw'),('fir_compensated_family_power','fir_compensated')]:
    a=np.array(r[key]);b=np.array(ref[key]);r[label+'_family_amplitude_error_percent']=float(100*np.sqrt(np.sum((np.sqrt(a)-np.sqrt(b))**2)/b.sum()));r[label+'_power_gain_db']=float(10*np.log10(a.sum()/b.sum()))
  row['renders'].extend(model_rows)
 results.append(row)
 print(name,[(r['model'],r['render_rate'],round(r['off_family_16k_db'],2),round(r['fir_compensated_family_amplitude_error_percent'],3)) for r in row['renders']],flush=True)
report={'experiment':'free triangle BLAMP; product ring in both variants','added_group_delay_seconds':0,'renderer_sha256':HASH,'model_flags':FLAGS,'script_sha256':sha(Path(__file__)),'sample_rates':([48000] if LOW else [44100,48000,96000,192000]),'analysis_window_s':[1,3.5],'analysis_band_hz':[40,16000],'family_half_width_hz':min(12,.4*FM/8),'cases':results,'notes':['All integer n*f1+m*f2 products lie on the declared family grid for the exact rational source ratio. This permits an off-family residual measure; arbitrary irrational ratios would make dense masks invalid.','Off-family energy misses aliases that land on valid families. Family amplitudes versus192k output are also reported; no phase/time/pitch/gain fitting is applied.','The same FIR coefficients scale their physical passband with sample rate. Both raw family-amplitude error and a correction for its known linear magnitude response are reported.','Product paths use raw oscillator inputs without the experimental physical coupling. The one-second preroll settles envelope and filter state. No phase, pitch, or gain fitting is used.','Numerical rate consistency is not evidence of hardware parity. Cross-rate family amplitude differences can include accumulated float phase drift and coincident-family cancellation; they are diagnostics, not pure alias error. The same-rate raw/AA low-band comparison avoids that confound.']}
if LOW:
 for row in results:
  a,_=sf.read(OUT/f"{row['case']}.raw.48000.wav");b,_=sf.read(OUT/f"{row['case']}.aa.48000.wav")
  a=a[48000:168000];b=b[48000:168000];w=np.hanning(len(a));nfft=2**int(np.ceil(np.log2(len(a)*8)));f=np.fft.rfftfreq(nfft,1/48000)
  ra=np.fft.rfft((a-a.mean())*w,nfft);ab=np.fft.rfft((b-b.mean())*w,nfft)
  band=(f>=40)&(f<2000)
  row['lowband_change_percent']=float(100*np.sqrt(np.sum(abs(ab[band]-ra[band])**2)/np.sum(abs(ra[band])**2)))
  row['lowband_power_gain_db']=float(10*np.log10(np.sum(abs(ab[band])**2)/np.sum(abs(ra[band])**2)))
(OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
assert all(sha(p)==HASH[k] for k,p in BINS.items())
