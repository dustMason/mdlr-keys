#!/usr/bin/env python3
"""Import the user's own verified ROM and derive factory SRAM by running its real reset routine."""
from pathlib import Path
import sys,os,json,hashlib,shutil,subprocess
N=Path(__file__).resolve().parents[1]
if len(sys.argv)!=2:raise SystemExit('Usage: python3 Native/JP8000/tools/prepare.py /path/to/jp8000_v1.05.bin')
rom=Path(sys.argv[1]).expanduser().resolve();manifest=json.loads((N/'private-inputs.json').read_text());sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
if not rom.is_file() or sha(rom)!=manifest['rom']['sha256']:raise SystemExit('Expected verified512KiB JP-8000 v1.05 ROM; see private-inputs.json')
private=N/'Private';private.mkdir(exist_ok=True);destination=private/'jp8000_v1.05.bin'
if destination.exists() and sha(destination)!=sha(rom):raise SystemExit('Existing private ROM differs; it was left untouched')
if not destination.exists():shutil.copy2(rom,destination)
env=dict(os.environ,JP8000_ROM=str(destination),JP8000_BASELINE_RAM=str(private/'ram_dump.bin'),JP8000_PREPARE_ONLY='1');subprocess.run([sys.executable,str(N/'tools/build.py')],env=env,check=True)
