"""Independent f64 oscillator-only sync audit; no corpus audio or hardware fit."""
from pathlib import Path
import argparse,json,hashlib,re
import numpy as np
from scipy import signal
from numba import njit

HERE=Path(__file__).resolve().parent
FS=192000
DURATION=1.0
PEAK=.78

@njit
def threshold(shape):
    if shape<=15/4096:return 1.
    if shape>=8176/4096:return -1.
    return min(1.,max(-1.,PEAK*(1.3232422-shape*1.2929688)))

@njit
def raw(p,kind,shape):
    if kind==1:return 1-4*abs(p-.5)
    edge=(threshold(shape)+1)*.25
    r=2*((2*p)%1)-1
    return -r if p>=edge and p<1-edge else r

@njit
def slope(p,kind,shape):
    if kind==1:return 4. if p<.5 else -4.
    edge=(threshold(shape)+1)*.25
    return -4. if p>=edge and p<1-edge else 4.

@njit
def blep(p,inc):
    if p<inc:
        x=p/inc;return 2*x-x*x-1
    if p>1-inc:
        x=(p-1)/inc;return x*x+2*x+1
    return 0.

@njit
def legacy(p,kind,shape,inc):
    if kind==1:return raw(p,kind,shape)
    th=threshold(shape);edge=(th+1)*.25
    return raw(p,kind,shape)-blep(p,inc)+blep((p-.5)%1,inc)-th*(blep((p-edge)%1,inc)+blep((p-(1-edge))%1,inc))

@njit
def correction(jump,derivative,t,blamp):
    a=jump*.5*(1-t)**2;b=-jump*.5*t*t
    if blamp:a+=derivative/6*(1-t)**3;b+=derivative/6*t**3
    return a,b

@njit
def segment(p,duration,offset,inc,kind,shape,blamp):
    a=0.;b=0.;th=threshold(shape);edge=(th+1)*.25
    for k in range(2 if kind==1 else 4):
        if kind==1:
            e=0. if k==0 else .5
            j=0.;d=8. if k==0 else -8.
        else:
            if k==0:e=0.;j=-2.;d=0.
            elif k==1:e=.5;j=2.;d=0.
            elif k==2:e=edge;j=-2*th;d=-8.
            else:e=1-edge;j=-2*th;d=8.
        distance=e+np.floor(p-e)+1-p
        if distance<=duration*inc+1e-13:
            t=offset+distance/inc
            aa,bb=correction(j,d*inc,min(1.,max(0.,t)),blamp)
            a+=aa;b+=bb
    return a,b

@njit
def event_step(p1,p2,d1,d2,kind,shape,blamp):
    if p1+d1<1:
        a,b=segment(p2,1.,0.,d2,kind,shape,blamp)
        return a,b,(p2+d2)%1
    tau=(1-p1)/d1
    a,b=segment(p2,tau,0.,d2,kind,shape,blamp)
    q=(p2+d2*tau)%1
    if q<1e-12 or q>1-1e-12:q=0.
    # Snap exact corner coincidences to their right-side convention.
    if abs(q-.5)<1e-12:q=.5
    if kind==0:
        edge=(threshold(shape)+1)*.25
        if abs(q-edge)<1e-12:q=edge
        if abs(q-(1-edge))<1e-12:q=1-edge
    aa,bb=correction(raw(0.,kind,shape)-raw(q,kind,shape),(slope(0.,kind,shape)-slope(q,kind,shape))*d2,tau,blamp)
    a+=aa;b+=bb
    aa,bb=segment(0.,1-tau,tau,d2,kind,shape,blamp)
    return a+aa,b+bb,(1-tau)*d2

@njit
def render(fs,seconds,fmaster,ratio,p1,p2,kind,shape,mode):
    # mode0=current phase BLEP;1=raw;2=event BLEP;3=event BLEP+BLAMP
    out=np.empty(round(fs*seconds));d1=fmaster/fs;d2=d1*ratio
    carry=0.;rc_state=0.
    cutoff=1/(2*np.pi*180*47e-9)
    g=np.tan(np.pi*cutoff/fs);coef=g/(1+g)
    for n in range(len(out)):
        if mode<2:
            y=legacy(p2,kind,shape,d2) if mode==0 else raw(p2,kind,shape)
            nextp2=p2+d2
            if p1+d1>=1:nextp2=(p1+d1-1)/d1*d2
            nextp2%=1
        else:
            pre,post,nextp2=event_step(p1,p2,d1,d2,kind,shape,mode==3)
            y=raw(p2,kind,shape)+carry+pre
            carry=post
        # Match circuit RC placement, preserving state across reset.
        delta=(y-rc_state)*coef;rc_y=rc_state+delta;rc_state=rc_y+delta
        if kind==1:
            th=1.5 if shape<=15/2304 else PEAK*(1.3232422-shape*.7272949)
            y=-2.2*(rc_y-2.7*np.sign(rc_y)*max(abs(rc_y)-th,0.))
        else:y=rc_y
        out[n]=y;p2=nextp2;p1=(p1+d1)%1
    return out


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def spectrum(x):
    x=x[9600:45600];x=x-x.mean();win=np.hanning(len(x));nfft=2**int(np.ceil(np.log2(len(x)*8)))
    return np.fft.rfftfreq(nfft,1/48000),abs(np.fft.rfft(x*win,nfft))**2

def metric(x,ref,fm):
    f,p=spectrum(x);_,q=spectrum(ref);band=(f>=40)&(f<16000);mask=np.zeros(len(f),bool)
    for h in range(1,int(24000/fm)+1):mask|=abs(f-h*fm)<30
    residual=10*np.log10(max(p[band&~mask].sum(),1e-30)/p[band].sum())
    ref_residual=10*np.log10(max(q[band&~mask].sum(),1e-30)/q[band].sum())
    # Direct in-band coherent error: same exact clocks/reset phase; no time/gain fitting.
    e=x-ref;_,ep=spectrum(e)
    error=10*np.log10(max(ep[band].sum(),1e-30)/q[band].sum())
    return {'off_harmonic_16k_db':float(residual),'reference_off_harmonic_16k_db':float(ref_residual),'coherent_error_16k_db':float(error)}


def canonical_coefficients(kind,shape,ratio,count):
    # Exact piecewise-linear periodic function coefficients, before analog RC.
    th=threshold(shape);e=(th+1)*.25
    edges=[0.,.5] if kind==1 else sorted(set([0.,.5,e,(1-e)%1]))
    knots=[0.,1.]
    for cycle in range(int(np.ceil(ratio))+1):
        for edge in edges:
            q=cycle+edge
            if 1e-12<q<ratio-1e-12:knots.append(q/ratio)
    knots=sorted(set(knots));events=[]
    def left(q):
        eps=1e-9;p=(q-eps)%1
        return raw(p,kind,shape)+slope(p,kind,shape)*eps,slope(p,kind,shape)
    prev,prev_slope=left(ratio)
    events.append((0.,raw(0.,kind,shape)-prev,ratio*(slope(0.,kind,shape)-prev_slope)))
    for u in knots[1:-1]:
        q=u*ratio;ph=q%1
        # Canonical knots are exact right limits, with decimal rounding snapped.
        for edge in edges:
            if abs(ph-edge)<1e-12:ph=edge
        prev,prev_slope=left(q)
        events.append((u,raw(ph,kind,shape)-prev,ratio*(slope(ph,kind,shape)-prev_slope)))
    k=np.arange(1,count+1);iw=2j*np.pi*k;c=np.zeros(count,dtype=complex)
    for u,jump,dslope in events:c+=np.exp(-iw*u)*(jump/iw+dslope/(iw*iw))
    dc=sum((v-u)*raw((((v+u)*.5)*ratio)%1,kind,shape) for u,v in zip(knots[:-1],knots[1:]))
    return dc,c

def analytic_reference(kind,shape,fm,ratio,p1,fir):
    count=16384 if kind==1 else int(24000/fm)
    dc,c=canonical_coefficients(kind,shape,ratio,count)
    k=np.arange(1,count+1);c/=1+2j*np.pi*k*fm*180*47e-9
    if kind==1:
        # Resolve the analog-RC triangle then its continuous precision-rectifier fold.
        ngrid=262144;spec=np.zeros(ngrid//2+1,dtype=complex);spec[0]=dc;spec[1:count+1]=c
        triangle=np.fft.irfft(spec*ngrid)
        th=1.5 if shape<=15/2304 else PEAK*(1.3232422-shape*.7272949)
        folded=-2.2*(triangle-2.7*np.sign(triangle)*np.maximum(abs(triangle)-th,0))
        spec=np.fft.rfft(folded)/ngrid;dc=spec[0].real;c=spec[1:int(24000/fm)+1]
    n=np.arange(round(DURATION*48000));out=np.full(len(n),dc*np.sum(fir))
    for h,ch in enumerate(c,1):
        hz=h*fm
        if hz>=24000:break
        hf=np.sum(fir*np.exp(-2j*np.pi*hz/FS*np.arange(len(fir))))
        phase=h*(p1+fm*(n*4+3)/FS)
        out+=2*np.real(ch*hf*np.exp(2j*np.pi*phase))
    return out

def main(repo,output,save_signals=False):
    output.mkdir(parents=True,exist_ok=True)
    firtext=(repo/'Rust/src/modules/monologue_fir.rs').read_text().split('= [')[1]
    fir=np.array([float(x) for x in re.findall(r'[-+]?\d+\.\d+e[-+]?\d+',firtext)])
    assert len(fir)==127
    highfilter=signal.firwin(2049,80000,fs=FS*16,window=('kaiser',12))
    results=[]
    cases=[
        ('saw_plain',0,0.,997.3,2.375,.137,.731),
        ('saw_shaped',0,.8,997.3,2.375,.137,.731),
        ('saw_shaped_lowratio',0,.8,997.3,.73,.137,.731),
        ('saw_shaped_nearint',0,.8,997.3,3.995,.137,.731),
        ('saw_shaped_aboveint',0,.8,997.3,4.005,.137,.731),
        ('triangle_plain',1,0.,997.3,2.375,.137,.731),
        ('triangle_folded',1,.8,997.3,2.375,.137,.731),
        ('saw_shaped_high',0,.8,3989.2,2.375,.137,.731),
        ('triangle_high',1,0.,3989.2,2.375,.137,.731),
    ]
    # Exact integer master periods with controlled reset fractions.
    for tau in [.125,.5,.875]:
        cases.append((f'saw_reset_fraction_{tau}',0,.8,1000.,2.375,1-(1000/FS)*tau,.731))
    saved={}
    for name,kind,shape,fm,ratio,p1,p2 in cases:
        shape*=1023/1024
        high=render(FS*16,DURATION,fm,ratio,p1,p2,kind,shape,3)
        base_ref=signal.resample_poly(high,1,16,window=highfilter)
        high_ref=signal.lfilter(fir,[1],base_ref)[3::4]
        ref=analytic_reference(kind,shape,fm,ratio,p1,fir)
        row={'case':name,'master_hz':fm,'ratio':ratio,'initial_phases':[p1,p2],'kind':kind,'shape':shape,'high_rate_convergence':metric(high_ref,ref,fm),'results':{}}
        for mode,label in [(0,'current_phase_blep'),(2,'event_blep'),(3,'event_blep_blamp')]:
            raw_audio=render(FS,DURATION,fm,ratio,p1,p2,kind,shape,mode)
            x=signal.lfilter(fir,[1],raw_audio)[3::4]
            row['results'][label]=metric(x,ref,fm)
            if name=='saw_shaped':saved[label]=x
        if name=='saw_shaped':saved['reference']=ref
        results.append(row)
        print(name,{k:{m:round(v,2) for m,v in d.items()} for k,d in row['results'].items()},flush=True)
    unit=[]
    for p2 in [.3,.94,.97]:
        pre,post,pnext=event_step(.96,p2,.08,.1,0,0.,False)
        unit.append({'master_phase':.96,'master_increment':.08,'slave_phase':p2,'slave_increment':.1,'event_pre_correction':pre,'next_carry':post,'next_phase':pnext})
    report={'scope':'Independent f64 oscillator-only implementation of current phase-BLEP behavior and event-based proposals, with original RC/fold ordering; not the Rust integration and not a hardware-fidelity claim','base_internal_rate':FS,'reference_internal_rate':FS*16,'reference_method':'Exact piecewise-linear Fourier coefficients, continuous analog RC, continuous triangle fold on a 262144-point periodic grid; final FIR response retained. 16x event-corrected rendering independently checks convergence.','output_rate':48000,'analysis_window_s':[.2,.95],'analysis_upper_hz':16000,'reference_downsampler':'2049-tap Kaiser beta 12 lowpass at 80 kHz, then down16; common production 127-tap FIR then down4','fir_source_sha256':sha(repo/'Rust/src/modules/monologue_fir.rs'),'script_sha256':sha(Path(__file__)),'cases':results,'fractional_ordering_examples':unit,'limitations':['Analytic reference retains the same modeled waveform/RC and reset-to-zero assumption; no hardware reset parameter is fitted.','Prototype uses f64 to separate timing/event errors from f32 phase drift.','Small residual magnitude differences include low-order polynomial smoothing and RC prewarping; off-harmonic energy and coherent error are both reported.','Triangle folding remains after RC and can itself alias; input-step correction cannot eliminate every nonlinear artifact.']}
    (output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    if save_signals:np.savez(output/'example-signals.npz',**saved)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,default=HERE.parents[3])
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--save-signals',action='store_true')
    args=parser.parse_args()
    main(args.repo,args.output,args.save_signals)
