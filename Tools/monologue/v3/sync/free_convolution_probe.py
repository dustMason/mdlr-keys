from pathlib import Path
import ast,hashlib,json,subprocess
import numpy as np
HERE=Path(__file__).resolve().parent
import argparse
from convolution_probe import reference
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args();OUT=args.output.resolve();OUT.mkdir(parents=True,exist_ok=True)
SOURCE=HERE.parents[3]/'Rust/src/modules/monologue_sync.rs'
SHA=hashlib.sha256(SOURCE.read_bytes()).hexdigest()
subprocess.run(['rustc','--edition','2021','-O',str(HERE/'free_convolution_probe.rs'),'-o',str(OUT/'probe')],check=True)
rng=np.random.default_rng(1642);cases=[]
for i in range(6000):
 phase=np.float32(rng.random());inc=np.float32(10**rng.uniform(-6,np.log10(.2)))
 if i%4==0:phase=np.float32(.5-rng.random()*inc)
 if i%4==1:phase=np.float32(1-rng.random()*inc)
 if phase>=1:phase=np.nextafter(np.float32(1),np.float32(0))
 current=np.float32(phase+inc)%np.float32(1)
 cases.append([float(phase),float(inc),float(current)])
run=subprocess.run([str(OUT/'probe')],input=''.join(' '.join(map(repr,c))+'\n' for c in cases),capture_output=True,text=True,check=True)
got=np.array([float(v) for v in run.stdout.splitlines()]);expected=np.array([reference(p,inc,-1,q,-1,1)[0] for p,inc,q in cases]);error=abs(got-expected);worst=int(error.argmax())
report={'source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'cases':len(cases),'seed':1642,'method':'Independent exact two-point Gauss integration of the triangle over every affine segment, weighted by a symmetric triangular kernel of radius one internal sample. Half of cases place a corner inside the interval.','max_absolute_error':float(error.max()),'failures_above_2e_minus5':int((error>2e-5).sum()),'worst':{'inputs':cases[worst],'rust':float(got[worst]),'exact_convolution':float(expected[worst])},'limit':'Float32 phase wrapping differs slightly from a continuous f64 oscillator. This checks numerical integration, not physical reset behavior.'}
(OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2));assert report['failures_above_2e_minus5']==0

assert SHA==hashlib.sha256(SOURCE.read_bytes()).hexdigest(), "Source changed during audit"
