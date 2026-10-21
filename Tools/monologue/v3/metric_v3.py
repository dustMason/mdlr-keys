#!/usr/bin/env python3
"""Time-resolved diagnostics alongside the unchanged v2 harmonic objective.

No objective is claimed to measure hardware fidelity. Transport is a diagnostic
for non-harmonic energy and sidebands, not a replacement for the pitch report.
"""
from pathlib import Path
from functools import lru_cache
import sys
import numpy as np
from scipy import signal
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'v2'))
sys.path.insert(0,str(HERE.parent))
from cached_metric import compare_files as compare_v2
from metric_audit import harmonic_frames
from audio_compare import read_audio


def harmonic_temporal(reference,candidate,rate,pitch_hz,*,start_s=.075,end_s=None):
    rf=harmonic_frames(reference,rate,pitch_hz,start_s=start_s,end_s=end_s)
    cf=harmonic_frames(candidate,rate,pitch_hz,start_s=start_s,end_s=end_s)
    n=min(len(rf['power']),len(cf['power']))
    rp=rf['power'][:n]/np.maximum(rf['power'][:n].sum(axis=1,keepdims=True),1e-30)
    cp=cf['power'][:n]/np.maximum(cf['power'][:n].sum(axis=1,keepdims=True),1e-30)
    rd=10*np.log10(np.maximum(rp,1e-5));cd=10*np.log10(np.maximum(cp,1e-5))
    weights=np.sqrt(rp);weights/=np.maximum(weights.sum(axis=1,keepdims=True),1e-30)
    err=np.sum(weights*abs(rd-cd),axis=1)
    # Reference-only activity mask avoids interpreting recording noise as timbre.
    active=rf['rms'][:n]>max(float(rf['rms'].max())*10**(-45/20),1e-10)
    times=rf['times'][:n]
    windows={}
    # Relative to a 50 ms preroll: attack/early, middle, late. A 96 ms window
    # cannot isolate sub-cycle reset edges; direct event/alias tests cover those.
    for label,lo,hi in [('early',.075,.175),('middle',.175,.325),('late',.325,float('inf'))]:
        use=active&(times>=lo)&(times<hi)
        if use.any():
            windows[label]={'frames':int(use.sum()),'mean_db':float(np.mean(err[use])),'p90_db':float(np.quantile(err[use],.9)),'reference_h2_h1_db':float(np.mean(rd[use,1]-rd[use,0])),'candidate_h2_h1_db':float(np.mean(cd[use,1]-cd[use,0]))}
    return {'mean_db':float(np.mean(err[active])),'p90_db':float(np.quantile(err[active],.9)),'worst_db':float(np.max(err[active])),'windows':windows,'times_seconds':times.tolist(),'frame_error_db':err.tolist(),'reference_h2_h1_db':(rd[:,1]-rd[:,0]).tolist(),'candidate_h2_h1_db':(cd[:,1]-cd[:,0]).tolist(),'reference_harmonic_coverage':rf['coverage'][:n].tolist(),'candidate_harmonic_coverage':cf['coverage'][:n].tolist(),'reference_harmonics_db':rd.tolist(),'candidate_harmonics_db':cd.tolist(),'reference_pitch_hz':rf['f0'][:n].tolist(),'candidate_pitch_hz':cf['f0'][:n].tolist()}


def transport_frames(reference,candidate,rate,*,frame_s=.096,hop_s=.024,start_s=.075,end_s=None):
    """1D Wasserstein distance in cents over 35 Hz..12 kHz power.

    Resolves all FFT bins, including energy outside a harmonic comb. A uniform
    small pitch shift has a proportionate cost rather than a coherent-FFT null.
    Reported in cents of transported spectral mass, not pitch cents or dB.
    """
    size=round(frame_s*rate)//2*2;hop=round(hop_s*rate)
    end=min(len(reference),len(candidate),round((end_s or min(len(reference),len(candidate))/rate)*rate))
    centers=np.arange(max(size//2,round(start_s*rate)),end-size//2+1,hop)
    if not len(centers):raise ValueError('Clip too short for frozen spectral window')
    nfft=2**int(np.ceil(np.log2(size*4)));freq=np.fft.rfftfreq(nfft,1/rate);use=(freq>=35)&(freq<=min(12000,rate/2));axis=1200*np.log2(freq[use]);width=np.diff(axis)
    window=np.hanning(size);rows=[]
    for center in centers:
        ps=[]
        for x in [reference,candidate]:
            frame=x[center-size//2:center+size//2];p=abs(np.fft.rfft((frame-frame.mean())*window,nfft))**2;p=p[use];p/=max(p.sum(),1e-30);ps.append(p)
        distance=float(np.sum(abs(np.cumsum(ps[0])[:-1]-np.cumsum(ps[1])[:-1])*width));rows.append(distance)
    return {'mean_cents':float(np.mean(rows)),'p90_cents':float(np.quantile(rows,.9)),'times_seconds':(centers/rate).tolist(),'frame_cents':rows}


def compare_files(reference,candidate,max_lag_ms=4,*,pitch_hz,start_s=.075,end_s=None,include_frames=False):
    report=compare_v2(reference,candidate,max_lag_ms,pitch_hz=pitch_hz,start_s=start_s,end_s=end_s)
    r,rate=read_audio(reference,48000);c,_=read_audio(candidate,rate);n=min(len(r),len(c));r=r[:n];c=c[:n];lag=round(report['alignment_ms']*rate/1000)
    if lag>0:r=r[lag:];c=c[:-lag]
    elif lag<0:c=c[-lag:];r=r[:lag]
    temporal=harmonic_temporal(r,c,rate,pitch_hz,start_s=start_s,end_s=end_s)
    transport=transport_frames(r,c,rate,start_s=start_s,end_s=end_s)
    report['v2_objective']=report['objective']
    report['objective']=temporal['mean_db']+.3*report['envelope_mae_db']
    report['objective_name']='v3 temporal mean harmonic dB + 0.3 RMS envelope dB; unchanged v2 score retained'
    if not include_frames:
        temporal={k:v for k,v in temporal.items() if k in ['mean_db','p90_db','worst_db','windows']}
        transport={k:v for k,v in transport.items() if k in ['mean_cents','p90_cents']}
    report['temporal']=temporal;report['full_spectrum_transport']=transport
    return report


def audit():
    rate=48000;t=np.arange(round(.8*rate))/rate;f=130.81278265;h=np.arange(1,25,dtype=float)
    def make(phase=0,cents=0,transient=False,sideband=False):
        out=np.sum(np.sin(2*np.pi*h[:,None]*f*2**(cents/1200)*t+h[:,None]*phase)/h[:,None],axis=0)
        if transient:out+=np.sin(2*np.pi*f*3*t)*((t>.22)&(t<.32))
        if sideband:out+=.5*np.sin(2*np.pi*f*2.37*t)
        return out
    r=make();rows=[]
    for name,c in [('identity',r),('gain_quarter',r*.25),('phase_1_3',make(phase=1.3)),('pitch_plus_10c',make(cents=10)),('brief_h3_boost',make(transient=True)),('inharmonic_sideband',make(sideband=True))]:
        a=harmonic_temporal(r,c,rate,f);b=transport_frames(r,c,rate);rows.append({'id':name,'harmonic_mean_db':a['mean_db'],'harmonic_p90_db':a['p90_db'],'transport_cents':b['mean_cents'],'transport_p90_cents':b['p90_cents']})
    assert rows[0]['harmonic_mean_db']<1e-10 and rows[0]['transport_cents']<1e-10
    assert rows[1]['harmonic_mean_db']<1e-10 and rows[1]['transport_cents']<1e-10
    assert rows[2]['harmonic_mean_db']<.001 and rows[2]['transport_cents']<.1
    assert rows[3]['harmonic_mean_db']<.001 and 8<rows[3]['transport_cents']<12
    assert rows[4]['harmonic_mean_db']>.05 and rows[4]['harmonic_p90_db']>rows[4]['harmonic_mean_db']
    assert rows[5]['transport_cents']>40
    return {'rows':rows,'limits':['Mean/p90 keep brief errors visible; 96 ms windows still smear very short transients.','Transport includes sidebands and residual noise, but does not identify a circuit uniquely.','Transport is gain invariant; oscillator phase cancellation before nonlinear circuits remains a real nuisance.','A 10-cent pitch shift has about a 10-cent transport cost and is intentionally not removed.']}

if __name__=='__main__':
    import json
    out=audit();(HERE/'metric-audit.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
