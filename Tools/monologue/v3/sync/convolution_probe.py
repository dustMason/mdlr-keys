"""Independent exact triangular-convolution check of the compiled Rust module."""
from pathlib import Path
import argparse,hashlib,json,subprocess
import numpy as np
HERE=Path(__file__).resolve().parent

def raw(p,th):
 p%=1
 tri=1-4*abs(p-.5)
 edge=(th+1)*.25
 inverted=th<=-1 or (th<1 and p>=edge and p<1-edge)
 saw=(4*p-(3 if p>=.5 else 1))*(-1 if inverted else 1)
 return np.array([tri,saw])

def reference(pp,inc,previous_reset,p,current_reset,th):
 edge=(th+1)*.25
 knots=[-1.,0.,1.]
 def add(phase,duration,offset):
  finish=phase+duration*inc
  for cycle in [0,1]:
   for point in [0,.5,edge,1-edge,1]:
    pos=cycle+point
    if phase<pos<finish:knots.append(offset+(pos-phase)/inc)
 for phase,reset,offset in [(pp,previous_reset,-1),(p,current_reset,0)]:
  if reset<0:add(phase,1,offset)
  else:
   add(phase,reset,offset);knots.append(offset+reset);add(0,1-reset,offset+reset)
 knots=sorted(set(knots))
 out=np.zeros(2)
 for lo,hi in zip(knots[:-1],knots[1:]):
  # Wave and triangular weight are affine in each segment: 2-point Gauss is exact.
  for u in [(hi+lo)/2-(hi-lo)/(2*np.sqrt(3)),(hi+lo)/2+(hi-lo)/(2*np.sqrt(3))]:
   phase,reset,t=(pp,previous_reset,u+1) if u<0 else (p,current_reset,u)
   q=phase+inc*t if reset<0 or t<reset else inc*(t-reset)
   out+=raw(q,th)*(1-abs(u))*(hi-lo)/2
 return out

def main(output):
 output.mkdir(parents=True,exist_ok=True)
 source=HERE.parents[3]/'Rust/src/modules/monologue_sync.rs'
 digest=hashlib.sha256(source.read_bytes()).hexdigest()
 subprocess.run(['rustc','--edition','2021','-O',str(HERE/'convolution_probe.rs'),'-o',str(output/'convolution_probe')],check=True)
 rng=np.random.default_rng(7341);cases=[]
 for i in range(3000):
  pp,inc=np.float32(rng.random()),np.float32(10**rng.uniform(-5,np.log10(.2)))
  prev=np.float32(rng.random()) if rng.random()<.6 else np.float32(-1)
  nxt=np.float32(rng.random()) if rng.random()<.6 else np.float32(-1)
  th=np.float32(rng.uniform(-1,1))
  if i%10==0:th=np.nextafter(np.float32(1),np.float32(0))
  if i%10==1:th=np.nextafter(np.float32(-1),np.float32(0))
  if i%10==2:th=np.float32(1)
  if i%10==3:th=np.float32(-1)
  p=np.float32(inc*np.float32(1-prev)) if prev>=0 else np.float32(pp+inc)%np.float32(1)
  cases.append([float(pp),float(inc),float(prev),float(p),float(nxt),float(th)])
 text=''.join(' '.join(map(repr,c))+'\n' for c in cases)
 run=subprocess.run([str(output/'convolution_probe')],input=text,text=True,capture_output=True,check=True)
 got=np.array([[float(v) for v in line.split()] for line in run.stdout.splitlines()]);expected=np.array([reference(*c) for c in cases]);error=np.abs(got-expected)
 worst=int(error.max(axis=1).argmax());bad=np.flatnonzero(error.max(axis=1)>2e-5)
 report={'cases':len(cases),'seed':7341,'method':'Exact two-point Gauss integration on every piecewise-linear oscillator segment with a triangular convolution kernel of radius 1 internal sample. Independent of BLEP/BLAMP event formulas.','rust_source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'max_absolute_error':error.max(axis=0).tolist(),'failures_above_2e_minus5':len(bad),'worst':{'inputs':cases[worst],'rust':got[worst].tolist(),'reference':expected[worst].tolist()},'notes':['Float32 phase rounding can introduce sub-micro-unit discrepancies from the f64 continuous reference.','300 cases each use the nearest f32 values inside both threshold endpoints.']}
 (output/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))

 assert digest==hashlib.sha256(source.read_bytes()).hexdigest(), 'Source changed during validation'
 assert len(bad)==0, 'Rust output differs from exact triangular convolution'

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--output',type=Path,required=True)
 main(parser.parse_args().output.resolve())
