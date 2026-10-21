#!/usr/bin/env python3
"""Build an ARM64 static ESP emulator. Mac exporter only; target runtime never creates executable memory."""
from pathlib import Path
import os,sys,subprocess,json,shutil,hashlib,fcntl
N=Path(__file__).resolve().parents[1]; repo=N.parents[1]
B=Path(os.environ.get('JP8000_BUILD_DIR',str(N/'Build')));B.mkdir(parents=True,exist_ok=True)
lock=open(B/'build.lock','a');fcntl.flock(lock,fcntl.LOCK_EX)
V=N/'vendor/gearmulator';S=V/'source'
def run(args,**kw):subprocess.run([str(x) for x in args],check=True,**kw)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
rom=Path(os.environ.get('JP8000_ROM',str(N/'Private/jp8000_v1.05.bin')));ram=Path(os.environ.get('JP8000_BASELINE_RAM',str(N/'Private/ram_dump.bin')))
inputs=json.loads((N/'private-inputs.json').read_text())
prepare=os.environ.get('JP8000_PREPARE_ONLY')=='1'
for p,k in [(rom,'rom'),(ram,'ram')]:
 if prepare and k=='ram' and not p.exists():continue
 if not p.is_file() or sha(p)!=inputs[k]['sha256']:raise SystemExit('Provide verified '+k+' using JP8000_ROM / JP8000_BASELINE_RAM; see Native/JP8000/README.md')
# Overlay keeps upstream vendor content and hashes unmodified.
for mode in ['runtime','export']:
 d=B/mode/'custom_chips/esp';shutil.copytree(S/'ronaldo/custom_chips/esp',d,dirs_exist_ok=True)
 if mode=='runtime':shutil.copy2(N/'patches/esp-runtime.h',d/'esp.h')
 else:
  shutil.copy2(N/'patches/esp-export-arm64.h',d/'esp_jit_arm64.h');shutil.copy2(N/'patches/esp-export-emitter.h',d/'esp_jit_emitter.h')
base=['-std=c++20','-O3','-DNDEBUG','-fvisibility=hidden','-Wno-deprecated-anon-enum-enum-conversion','-I'+str(N/'src')]
for p in [S,S/'cpu',S/'ronaldo',S/'framework',S/'cpu/dsp56300/source',S/'ronaldo/je8086',N/'include']:base+=['-I'+str(p)]
sources=[V/p for p in json.loads((N/'sources.json').read_text())]
sources += [N/'src/logging_adapter.cpp',N/'src/filesystem_adapter.cpp']
macsdk=subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip()
mac=['-target','arm64-apple-macos13.0','-isysroot',macsdk]
# All source/header/adapter patches participate in the build cache identity.
fingerprint=hashlib.sha256();exportprint=hashlib.sha256(b'apple-static-export-v2')
for p in sorted(N.rglob('*')):
 if not p.is_file() or any(x in p.relative_to(N).parts for x in ['Build','Private']):continue
 if p.suffix not in ['.cpp','.h','.hpp','.inc'] and p.name!='sources.json':continue
 fingerprint.update(str(p.relative_to(N)).encode());fingerprint.update(p.read_bytes())
 if p.relative_to(N).parts[0]=='vendor' or p.name.startswith('esp-export-') or p.name in ['aot_export.cpp','aot_key.h','sources.json']:exportprint.update(str(p.relative_to(N)).encode());exportprint.update(p.read_bytes())
version=fingerprint.hexdigest()
def compile_set(mode,flags,extra):
 d=B/(mode+'-objects');d.mkdir(exist_ok=True);objs=[]
 stamp=hashlib.sha256((version+repr(flags)+repr(extra)).encode()).hexdigest();old=(d/'stamp').read_text() if (d/'stamp').exists() else ''
 for i,p in enumerate(sources+extra):
  if p.name=='esp.cpp':p=B/mode/'custom_chips/esp/esp.cpp'
  o=d/(str(i)+'-'+p.stem+'.o');objs.append(o)
  if old!=stamp or not o.exists():run(['clang++','-I'+str(B/mode),*base,*flags,'-c',p,'-o',o])
 (d/'stamp').write_text(stamp);return objs
def build_exporter():
 a=B/'asmjit';run(['cmake','-S',N/'vendor/asmjit','-B',a,'-DASMJIT_STATIC=ON','-DASMJIT_TEST=OFF','-DASMJIT_NO_X86=ON','-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DCMAKE_OSX_ARCHITECTURES=arm64','-DCMAKE_OSX_SYSROOT='+macsdk],stdout=sys.stderr)
 run(['cmake','--build',a,'--parallel','2'],stdout=sys.stderr)
 objects=compile_set('export',[*mac,'-DASMJIT_STATIC','-I'+str(N/'vendor/asmjit/src')],[N/'tools/aot_export.cpp'])
 exporter=B/'aot-export';run(['clang++',*mac,*objects,a/'libasmjit.a','-o',exporter]);return exporter
if prepare:
 if ram.exists():print('Verified existing factory RAM:',ram);sys.exit(0)
 exporter=build_exporter();temporary=B/'factory-ram-new.bin';run([exporter,'--factory-ram',rom,temporary],stdout=sys.stderr)
 if sha(temporary)!=inputs['ram']['sha256']:raise SystemExit('Generated factory RAM hash differs; preserving it privately for inspection and leaving destination untouched')
 ram.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(temporary,ram);print('Generated and verified factory RAM:',ram);sys.exit(0)
export_identity=exportprint.hexdigest()+sha(rom)+sha(ram)
generated=B/'generated';generated.mkdir(exist_ok=True)
if not (generated/'stamp').exists() or (generated/'stamp').read_text()!=export_identity:
 exporter=build_exporter();run([exporter,rom,ram,generated],stdout=sys.stderr)
 records=json.loads((generated/'kernels.json').read_text())
 registry='#include "aot_registry.h"\n'
 for rec in records:registry+='extern "C" void jp_aot_%d(esp::KernelFrame*);\n'%rec['id']
 registry+='namespace jp_aot_probe { struct Entry { Key key; esp::KernelFn fn; }; static const Entry entries[]={\n'
 for rec in records:
  k=rec['key'];registry+='{{1,'+','.join(map(str,k[:7]))+',{{'+','.join(map(str,k[7:]))+'}}},jp_aot_'+str(rec['id'])+'},\n'
 registry+='}; esp::KernelFn lookup(const Key& key){for(const auto& e:entries)if(e.key==key)return e.fn;return nullptr;} }\n'
 (generated/'registry.cpp').write_text(registry);(generated/'stamp').write_text(export_identity)
sdk=os.environ.get('PLATFORM_NAME','macosx')
if sdk not in ['macosx','iphoneos','iphonesimulator']:raise SystemExit('JP-8000 supports arm64 Apple targets only')
sdkroot=subprocess.check_output(['xcrun','--sdk',sdk,'--show-sdk-path'],text=True).strip()
target={'macosx':'arm64-apple-macos13.0','iphoneos':'arm64-apple-ios16.0','iphonesimulator':'arm64-apple-ios16.0-simulator'}[sdk]
flags=['-target',target,'-isysroot',sdkroot,'-DCHIPS_FORCE_NO_JIT=1']
objects=compile_set('runtime',flags,[generated/'registry.cpp',N/'src/jp8000_bridge.cpp'])
obj=B/(sdk+'-kernels.o');run(['clang','-target',target,'-isysroot',sdkroot,'-c',generated/'kernels.S','-o',obj]);objects.append(obj)
product=Path(os.environ.get('BUILT_PRODUCTS_DIR',str(B/sdk)));product.mkdir(parents=True,exist_ok=True);archive=product/'libmdlr_jp8000.a';run(['xcrun','libtool','-static','-o',archive,*objects])
if os.environ.get('TARGET_BUILD_DIR') and os.environ.get('UNLOCALIZED_RESOURCES_FOLDER_PATH'):
 resources=Path(os.environ['TARGET_BUILD_DIR'])/os.environ['UNLOCALIZED_RESOURCES_FOLDER_PATH']/'JP8000';resources.mkdir(parents=True,exist_ok=True)
 shutil.copy2(rom,resources/'jp8000_v1.05.bin');shutil.copy2(ram,resources/'ram_dump.bin')
receipt={'target':target,'archive':str(archive),'archive_bytes':archive.stat().st_size,'kernels':len(json.loads((generated/'kernels.json').read_text())),'runtime_jit':False,'inputs':inputs,'source_revision':json.loads((N/'vendor-manifest.json').read_text())['revision']}
(product/'jp8000-build.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
