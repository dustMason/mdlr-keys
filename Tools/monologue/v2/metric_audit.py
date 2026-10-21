#!/usr/bin/env python3
"""Independent audio diagnostics. Does not change the production fitting score.

Measures local harmonic-band POWER, not the magnitude of a long coherent integral.
Each signal has its own bounded f0 estimate, avoiding small tuning/bin offsets.
Version 2 expands the default harmonic count to 64 and the center-frequency
cap to 12 kHz (or Nyquist), frozen before the first v2 engine search.
These diagnostics deliberately remove recording gain; raw gain and pitch remain
reported separately. Results are shape/dynamics evidence, not a fidelity rating.
"""
import numpy as np
from scipy import signal
from audio_compare import read_audio,compare_arrays,pitch,rms_env


def harmonic_frames(x,sr,guess,frame_s=.096,hop_s=.024,start_s=.075,end_s=None,harmonics=64):
    """Bound f0 within +/-35 cents of supplied note. Band radii include the Hann
    main lobe plus small harmonic inharmonicity, capped below adjacent harmonics.
    This is suitable for tonal low-register diagnostics, not arbitrary FM/noise.
    """
    size=round(frame_s*sr);hop=round(hop_s*sr);end=min(len(x),round((end_s or len(x)/sr)*sr))
    first=max(size//2,round(start_s*sr));last=end-size//2
    centers=np.arange(first,last+1,hop)
    if not len(centers):centers=np.array([len(x)//2]);size=min(size,len(x)//2*2)
    window=np.hanning(size);fft=2**int(np.ceil(np.log2(size*16)))
    freq=np.fft.rfftfreq(fft,1/sr);df=sr/fft;maxh=min(harmonics,int(min(12000,sr*.5)/guess))
    rows=[];pitches=[];rms=[];coverage=[];edges=[]
    for center in centers:
        frame=x[center-size//2:center+size//2];frame=frame-frame.mean()
        p=abs(np.fft.rfft(frame*window,fft))**2
        # Use several partials: a nearly absent or cancelled fundamental should
        # not force the local pitch estimate against a search boundary.
        grid=np.linspace(guess*2**(-35/1200),guess*2**(35/1200),161)
        comb=sum(np.interp(grid*h,freq,p)/np.sqrt(h) for h in range(1,min(8,maxh)+1))
        peak=int(np.argmax(comb));f0=grid[peak]
        edges.append(peak in (0,len(grid)-1))
        hs=[];covered=np.zeros(len(p),bool)
        for h in range(1,maxh+1):
            radius=min(.40*f0,max(2.0/(size/sr),.035*h*f0))
            band=abs(freq-h*f0)<=radius
            hs.append(float(np.sum(p[band])*df));covered|=band
        rows.append(hs);pitches.append(float(f0));rms.append(float(np.sqrt(np.mean(frame**2))))
        allband=(freq>=35)&(freq<=min(12000,sr*.5));coverage.append(float(p[covered&allband].sum()/max(p[allband].sum(),1e-30)))
    return {'times':centers/sr,'power':np.array(rows),'f0':np.array(pitches),'rms':np.array(rms),'coverage':np.array(coverage),'pitch_search_edge':np.array(edges)}


def shape_scores(r,c):
    n=min(len(r['power']),len(c['power']));rp=r['power'][:n];cp=c['power'][:n]
    rp=rp/np.maximum(rp.sum(axis=1,keepdims=True),1e-30)
    cp=cp/np.maximum(cp.sum(axis=1,keepdims=True),1e-30)
    floor=1e-5;rd=10*np.log10(np.maximum(rp,floor));cd=10*np.log10(np.maximum(cp,floor))
    mask=np.maximum(rp,cp)>1e-4
    weights=np.sqrt(rp);weights/=weights.sum(axis=1,keepdims=True)
    # Median frames resists a single accidental oscillator cancellation.
    weighted=float(np.median(np.sum(weights*abs(rd-cd),axis=1)))
    uniform=float(np.mean(abs(rd-cd)[mask]))
    tv=float(np.mean(.5*np.sum(abs(rp-cp),axis=1)))
    pooled_r=rp.mean(axis=0);pooled_c=cp.mean(axis=0)
    pr=10*np.log10(np.maximum(pooled_r,floor));pc=10*np.log10(np.maximum(pooled_c,floor))
    pw=np.sqrt(pooled_r);pw/=pw.sum()
    return {'harmonic_shape_weighted_db':weighted,'harmonic_shape_union_mae_db':uniform,'harmonic_energy_distance':tv,
            'pooled_harmonic_shape_weighted_db':float(np.sum(pw*abs(pr-pc))),
            'pitch_cents_median':float(np.median(1200*np.log2(c['f0'][:n]/r['f0'][:n]))),
            'reference_harmonics_db':pr.tolist(),'candidate_harmonics_db':pc.tolist(),
            'reference_harmonic_temporal_std_db':np.std(rd,axis=0).tolist(),'candidate_harmonic_temporal_std_db':np.std(cd,axis=0).tolist(),
            'reference_pitch_search_edge_fraction':float(np.mean(r['pitch_search_edge'])),'candidate_pitch_search_edge_fraction':float(np.mean(c['pitch_search_edge'])),
            'reference_harmonic_coverage':float(np.mean(r['coverage'])),'candidate_harmonic_coverage':float(np.mean(c['coverage']))}


def compare_files(reference,candidate,max_lag_ms=0,*,pitch_hz=None,start_s=.075,end_s=None):
    """Drop-in *diagnostic* alternative for calibrate.Runner's compare_files.

    Add this directory to sys.path, then `from metric_audit import compare_files`.
    `objective` = local harmonic shape error + 0.3 * aligned RMS-envelope error.
    Pitch is diagnosed separately; pitch_hz optionally supplies a known note.
    Relative oscillator phase is not eliminated and must be profiled upstream.
    """
    r,sr=read_audio(reference,48000);c,_=read_audio(candidate,sr)
    return compare_harmonic_arrays(r,c,sr,max_lag_ms,pitch_hz=pitch_hz,start_s=start_s,end_s=end_s)


def compare_harmonic_arrays(reference,candidate,sr=48000,max_lag_ms=0,*,pitch_hz=None,start_s=.075,end_s=None):
    n=min(len(reference),len(candidate));r=reference[:n];c=candidate[:n]
    reference_pitch=pitch(r,sr);candidate_pitch=pitch(c,sr)
    if pitch_hz is None:
        if reference_pitch is None:raise ValueError('Reference has no stable pitch; supply pitch_hz or use a noise-aware metric')
        pitch_hz=440*2**((round(reference_pitch['midi'])-69)/12)
    hop=max(1,round(sr*.002));lag=0
    if max_lag_ms:
        er=rms_env(r,hop);ec=rms_env(c,hop);corr=signal.correlate(er-er.mean(),ec-ec.mean());lags=signal.correlation_lags(len(er),len(ec));mask=abs(lags*hop/sr*1000)<=max_lag_ms
        lag=int(lags[mask][np.argmax(corr[mask])])*hop
        if lag>0:r=r[lag:];c=c[:len(r)]
        elif lag<0:c=c[-lag:];r=r[:len(c)]
    rr=float(np.sqrt(np.mean(r*r)));cr=float(np.sqrt(np.mean(c*c)));gain=rr/max(cr,1e-15);c=c*gain
    er=rms_env(r,round(sr*.005));ec=rms_env(c,round(sr*.005));floor=max(float(er.max())*.01,1e-8);mask=np.maximum(er,ec)>floor
    env=float(np.mean(abs(20*np.log10(np.maximum(er[mask],floor)/np.maximum(ec[mask],floor)))))
    hr=harmonic_frames(r,sr,pitch_hz,start_s=start_s,end_s=end_s);hc=harmonic_frames(c,sr,pitch_hz,start_s=start_s,end_s=end_s)
    report=shape_scores(hr,hc)
    report.update({'objective':report['harmonic_shape_weighted_db']+.3*env,'spectral_mae_db':report['harmonic_shape_weighted_db'],'envelope_mae_db':env,'alignment_ms':lag/sr*1000,'duration_s':len(r)/sr,
                   'reference_rms':rr,'candidate_rms':cr,'fitted_gain_db':float(20*np.log10(max(gain,1e-15))),'reference_pitch':reference_pitch,'candidate_pitch':candidate_pitch,'nominal_hz':pitch_hz,
                   'diagnostic_method':'local harmonic-band power v2: 64 harmonics, 12 kHz/Nyquist center cap'})
    if reference_pitch and candidate_pitch:report['pitch_error_cents']=100*(candidate_pitch['midi']-reference_pitch['midi'])
    return report


def serial_frames(x):return {k:v.tolist() for k,v in x.items()}


def synthetic_audit():
    sr=24000;t=np.arange(round(sr*.8))/sr;f0=130.81278265;h=np.arange(1,25)
    def saw(cents=0,phase=0,h3=1):
        amps=1/h.astype(float);amps[2]*=h3
        return np.sum(amps[:,None]*np.sin(2*np.pi*h[:,None]*f0*2**(cents/1200)*t[None,:]+h[:,None]*phase),axis=0)
    r=saw();hr=harmonic_frames(r,sr,f0);rows=[]
    for name,c in [('identical',r),('phase_1.3_rad',saw(phase=1.3)),('tuning_3_cents',saw(cents=3)),('tuning_10_cents',saw(cents=10)),('third_harmonic_minus_6dB',saw(h3=.5)),('gain_minus_12dB',r*.25)]:
        old=compare_arrays(r,c,sr);new=shape_scores(hr,harmonic_frames(c,sr,f0))
        rows.append({'id':name,'original_objective':old['objective'],'original_spectral_convergence':np.mean([a['spectral_convergence'] for a in old['multiresolution']]),**new})
    return rows
