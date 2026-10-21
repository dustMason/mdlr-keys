#!/usr/bin/env python3
"""Download hash-verified public paired recordings/patches, never firmware.
Default: four calibration patches plus source attribution (~15MB).
--all retrieves the full bounded seven-recording research subset.
"""
import argparse,hashlib,json,urllib.request
from pathlib import Path
from decode_patch import read_patch
from build_corpus import CASES
HERE=Path(__file__).resolve().parent

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--data-root',type=Path,default=HERE/'data');p.add_argument('--all',action='store_true');a=p.parse_args()
 root=(a.data_root/'callimero').resolve();root.mkdir(parents=True,exist_ok=True)
 manifest=json.loads((HERE/'sources/callimero-provenance.json').read_text());names={x[1] for x in CASES}
 rows=[row for row in manifest['files'] if a.all or row['path'] in ['LICENSE','README.md','patches/Readme.md'] or Path(row['path']).stem in names]
 for row in rows:
  dest=(root/row['path']).resolve()
  if not dest.is_relative_to(root):raise ValueError('Unsafe manifest path')
  if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest()==row['sha256']:continue
  request=urllib.request.Request(row['url'],headers={'User-Agent':'mdlr-keys-monologue-calibration/1'})
  with urllib.request.urlopen(request,timeout=30) as response:data=response.read(row['bytes']+1)
  if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:raise ValueError('Source checksum changed: '+row['path'])
  dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data);print(row['path'],flush=True)
 manifest['files']=rows;(root/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n')
 for path in (root/'patches').glob('*.molgprog'):path.with_suffix('.prog_bin').write_bytes(read_patch(path))
 print('Source assets verified; run build_corpus.py with the same --data-root.')
if __name__=='__main__':main()
