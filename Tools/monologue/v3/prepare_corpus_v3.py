#!/usr/bin/env python3
"""Reproduce frozen paired-audio excerpts; no audio/patches live in Git."""
import argparse,hashlib,json,shutil,sys,urllib.request
from pathlib import Path
import soundfile as sf
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from decode_patch import read_patch
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output-root',type=Path,required=True);p.add_argument('--cache',type=Path,action='append',default=[],help='Existing pinned asset roots, e.g. sources/ or callimero/');p.add_argument('--fetch',action='store_true',help='Download missing pinned public assets, bounded below64MB');a=p.parse_args();root=a.output_root.resolve();root.mkdir(parents=True,exist_ok=True);sources=json.loads((HERE/'sources-v3.json').read_text());assert sum(r['bytes'] for r in sources['files'])<64000000;fetched=[]
    for row in sources['files']:
        dest=root/'sources'/row['path'];dest.parent.mkdir(parents=True,exist_ok=True)
        if not dest.exists():
            cached=next((base/row['path'] for base in a.cache if (base/row['path']).is_file()),None)
            if cached:shutil.copyfile(cached,dest)
            elif a.fetch:
                with urllib.request.urlopen(row['url'],timeout=60) as response:data=response.read(row['bytes']+1)
                if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:raise RuntimeError('Pinned download mismatch: '+row['path'])
                dest.write_bytes(data);fetched.append(row['path'])
            else:raise FileNotFoundError('Missing '+row['path']+'; provide --cache or --fetch')
        assert dest.stat().st_size==row['bytes'] and sha(dest)==row['sha256'],row['path']
    m=json.loads((HERE/'corpus-template.json').read_text())
    for c in m['cases']:
        for field in ['program','reference','events']:(root/c[field]).parent.mkdir(parents=True,exist_ok=True)
        (root/c['program']).write_bytes(read_patch(root/c['source_program']));shutil.copyfile(HERE/c['events'],root/c['events']);x,sr=sf.read(root/c['source_audio'],always_2d=True);start,end=c['source_crop_seconds'];sf.write(root/c['reference'],x[round(start*sr):round(end*sr)],sr,subtype='PCM_24')
        for field in ['program','reference','events','source_audio']:assert sha(root/c[field])==c[field+'_sha256'],(c['id'],field,'Reproduced bytes differ')
    (root/'corpus-v3.json').write_text(json.dumps(m,indent=2)+'\n');shutil.copyfile(HERE/'protocol-v3.json',root/'protocol-v3.json')
    m31=json.loads((HERE/'corpus-template-v3.1.json').read_text());assert m31['cases']==m['cases'],'Amendment must preserve all samples, events and nuisance grids'
    (root/'corpus-v3.1.json').write_text(json.dumps(m31,indent=2)+'\n');shutil.copyfile(HERE/'protocol-v3.1.json',root/'protocol-v3.1.json')
    (root/'reproduction.json').write_text(json.dumps({'source_assets':len(sources['files']),'downloaded_this_run':fetched,'all_program_reference_event_bytes_match_frozen_corpus':True,'cases':len(m['cases']),'manifest_sha256':sha(root/'corpus-v3.json'),'conditioned_manifest_sha256':sha(root/'corpus-v3.1.json')},indent=2)+'\n');print(root/'corpus-v3.1.json')

if __name__=='__main__':main()
