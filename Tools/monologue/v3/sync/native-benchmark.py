"""Paired standalone native voice benchmark; no analysis feature or app launch."""
from pathlib import Path
import argparse,datetime,hashlib,json,platform,subprocess
P=argparse.ArgumentParser()
P.add_argument('--baseline-source',type=Path,required=True)
P.add_argument('--candidate-source',type=Path,required=True)
P.add_argument('--output',type=Path,required=True)
P.add_argument('--run',action='store_true',help='Time only after other task workloads are idle')
P.add_argument('--no-build',action='store_true',help='Reuse verified native harnesses without compiling')
a=P.parse_args();out=a.output.resolve();out.mkdir(parents=True,exist_ok=True)
here=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
sources={name:root.resolve() for name,root in [('baseline',a.baseline_source),('candidate',a.candidate_source)]}
def hashes():return {name:{str(p.relative_to(root)):sha(p) for p in sorted(root.glob('monologue*.rs'))} for name,root in sources.items()}
initial=hashes();assert all(initial.values())
compile_flags=['--edition','2021','-C','opt-level=3','-C','lto=yes','-C','codegen-units=1','-C','panic=abort']
if a.no_build:
 manifest=json.loads((out/'manifest.json').read_text())
 assert manifest['source_sha256']==initial
 assert manifest['compile_flags']==compile_flags
 assert manifest['harness_sha256']==sha(here/'native-benchmark.rs.in')
 assert manifest['script_sha256']==sha(Path(__file__))
 assert all(sha(out/name)==manifest['binary_sha256'][name] for name in sources)
else:
 for name,root in sources.items():
  source=out/(name+'.rs');source.write_text((here/'native-benchmark.rs.in').read_text().replace('@SOURCE@',str(root/'monologue.rs')))
  command=['rustc',*compile_flags,str(source),'-o',str(out/name)]
  build=subprocess.run(command,text=True,capture_output=True)
  (out/(name+'.build.log')).write_text(build.stdout+build.stderr)
  build.check_returncode()
 manifest={'source_sha256':initial,'binary_sha256':{name:sha(out/name) for name in sources},'compile_flags':compile_flags,'analysis_feature':False,'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),'harness_sha256':sha(here/'native-benchmark.rs.in'),'script_sha256':sha(Path(__file__))}
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
if not a.run:
 print('Native harnesses compiled; no timings requested.');raise SystemExit(0)
rows=[]
cases=['open_saw','resonant_drive_sync','high_triangle_ring','fast_shape_ring']
for repeat in range(3):
 for case,name in enumerate(cases):
  for rate in [48000,96000]:
   order=['baseline','candidate']
   if (repeat+case+(rate==96000))%2:order.reverse()
   for model in order:
    command=[str(out/model),str(rate),str(case),'20000']
    value=json.loads(subprocess.check_output(command,text=True))
    row={'model':model,'case':name,'repeat':repeat+1,**value};rows.append(row);print(json.dumps(row),flush=True)
assert hashes()==initial
assert all(sha(out/name)==manifest['binary_sha256'][name] for name in sources)
report={**manifest,'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':{'cpu':'Apple M4 Max','logical_cores':16,'memory_bytes':137438953472,'os':'macOS 26.7.1 (25G241)','architecture':platform.machine()},'scope':'Native Monologue::process_block, 64 frames and 4x oversampling. Both binaries omit the analysis feature and therefore omit the experimental diode LUT, coupling capacitors, and bridge quadrature. Excludes Synth C ABI, AVAudioEngine, MIDI transport, and hardware buffering.','method':'Three paired repeats of 20000 callbacks per patch/rate. Model order alternates by patch, rate, and repeat. Each fresh process warms its held note for .25 seconds. Parameters and float block types mirror the production trait; code uses release opt3/LTO/codegen1/panic-abort settings.','limitations':['This is normal-priority host timing, not a real-time scheduling guarantee or a physical iPad latency measurement.','The standalone monologue module is compiled into a small executable; whole-app optimizer/linker context can differ.'], 'runs':rows}
(out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
