#!/usr/bin/env python3
"""Phase-independent, gain-aware audio metrics for monologue approximation.
No time stretching or pitch correction is applied. A bounded onset-lag search is
optional; residual pitch is reported separately and must not be tuned away by
global model fitting. Gain is a recording nuisance, disclosed in every report.
"""
import argparse, json, math
from pathlib import Path
import numpy as np
import soundfile as sf
from scipy import signal

def read_audio(path, rate=24000):
 x,sr=sf.read(path,always_2d=True);x=np.mean(x,axis=1)
 if sr!=rate:
  g=math.gcd(sr,rate);x=signal.resample_poly(x,rate//g,sr//g)
 return x-np.mean(x),rate

def rms_env(x,hop):
 n=len(x)//hop
 return np.sqrt(np.mean(x[:n*hop].reshape(n,hop)**2,axis=1)+1e-16)

def pitch(x,sr):
 # YIN difference estimate, with parabolic lag refinement. Diagnostic only.
 if np.sqrt(np.mean(x*x))<1e-6:return None
 if sr>12000:x=signal.resample_poly(x,1,2);sr=sr/2
 n=min(len(x),4096);start=max(0,(len(x)-n)//2);a=x[start:start+n];a=a-a.mean()
 ac=np.fft.irfft(abs(np.fft.rfft(a,2*n))**2)[:n];sq=np.r_[0,np.cumsum(a*a)];lags=np.arange(1,min(n//2,int(sr/30)))
 d=np.maximum(0,(sq[n-lags]+sq[n]-sq[lags]-2*ac[lags])/(n-lags));cmnd=d*lags/(np.cumsum(d)+1e-20)
 mins=signal.find_peaks(-cmnd)[0]+1
 good=[int(l) for l in mins if l>sr/1800 and cmnd[l-1]<.2]
 if not good:return None
 lag=good[0];i=lag-1
 if 0<i<len(cmnd)-1:
  denom=cmnd[i-1]-2*cmnd[i]+cmnd[i+1]
  lag+=.5*(cmnd[i-1]-cmnd[i+1])/denom if abs(denom)>1e-12 else 0
 f0=sr/lag
 return {'hz':float(f0),'midi':float(69+12*np.log2(f0/440)),'periodicity':float(1-cmnd[i])}

def compare_arrays(reference,candidate,sr=24000,max_lag_ms=0):
 n=min(len(reference),len(candidate));r=reference[:n];c=candidate[:n]
 lag=0;hop=max(1,int(sr*.002));er=rms_env(r,hop);ec=rms_env(c,hop)
 if max_lag_ms:
  maxlag=round(max_lag_ms/2);corr=signal.correlate(er-er.mean(),ec-ec.mean());lags=signal.correlation_lags(len(er),len(ec));mask=abs(lags)<=maxlag
  lag=int(lags[mask][np.argmax(corr[mask])])*hop
  if lag>0:r=r[lag:];c=c[:len(r)]
  elif lag<0:c=c[-lag:];r=r[:len(c)]
 rr=float(np.sqrt(np.mean(r*r)));cr=float(np.sqrt(np.mean(c*c)));gain=rr/max(cr,1e-12)
 c=c*gain;report={'reference_rms':rr,'candidate_rms':cr,'fitted_gain_db':float(20*np.log10(max(gain,1e-12))),'alignment_ms':lag/sr*1000,'duration_s':len(r)/sr}
 resolutions=[]
 for win in [256,1024,4096]:
  win=min(win,len(r)//2);_,_,rz=signal.stft(r,sr,nperseg=win,noverlap=win*3//4,boundary=None);_,_,cz=signal.stft(c,sr,nperseg=win,noverlap=win*3//4,boundary=None)
  ra=abs(rz);ca=abs(cz);f=np.fft.rfftfreq(win,1/sr);valid=(f>=35)&(f<=10000);ra=ra[valid];ca=ca[valid]
  floor=max(float(np.max(ra))*1e-4,1e-10)
  # Ignore bins below -60dB in both signals; include spurious model harmonics.
  mask=np.maximum(ra,ca)>floor*10
  db=20*np.log10(np.maximum(ra,floor)/np.maximum(ca,floor))
  logerr=float(np.mean(abs(db[mask]))) if np.any(mask) else 0
  convergence=float(np.linalg.norm(ra-ca)/max(np.linalg.norm(ra),1e-12))
  resolutions.append({'fft_size':win,'log_magnitude_mae_db':logerr,'spectral_convergence':convergence})
 er=rms_env(r,int(sr*.005));ec=rms_env(c,int(sr*.005));floor=max(float(er.max())*.01,1e-8);mask=np.maximum(er,ec)>floor
 env=float(np.mean(abs(20*np.log10(np.maximum(er[mask],floor)/np.maximum(ec[mask],floor)))))
 report.update({'multiresolution':resolutions,'envelope_mae_db':env,'spectral_mae_db':float(np.mean([v['log_magnitude_mae_db'] for v in resolutions])),
  'reference_pitch':pitch(r,sr),'candidate_pitch':pitch(c,sr)})
 report['objective']=report['spectral_mae_db']+.3*env
 if report['reference_pitch'] and report['candidate_pitch']:report['pitch_error_cents']=100*(report['candidate_pitch']['midi']-report['reference_pitch']['midi'])
 return report

def compare_files(reference,candidate,max_lag_ms=0):
 r,sr=read_audio(reference);c,_=read_audio(candidate,sr)
 return compare_arrays(r,c,sr,max_lag_ms)

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('reference',type=Path);p.add_argument('candidate',type=Path);p.add_argument('--max-lag-ms',type=float,default=0);p.add_argument('--output',type=Path);a=p.parse_args()
 s=json.dumps(compare_files(a.reference,a.candidate,a.max_lag_ms),indent=2)+'\n'
 if a.output:a.output.write_text(s)
 else:print(s,end='')
