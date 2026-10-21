"""Analyze firmware PCM captured by midi_sync_test.cpp; no audio-device access."""
import json
import sys
from pathlib import Path
import numpy as np
prefix = Path(sys.argv[1])
results = []
for phase in range(4):
    pcm = np.fromfile(f'{prefix}-{phase}.f32', dtype='<f4')
    sample_rate = 88200
    transitions = []
    last = None
    for begin in range(0, len(pcm) - 4096, 441):
        frame = pcm[begin:begin + 4096]
        spectrum = np.abs(np.fft.rfft((frame-frame.mean()) * np.hanning(len(frame)), 65536))
        spectrum[:50] = 0
        frequency = np.argmax(spectrum) * sample_rate / 65536
        note = min((60,64,67), key=lambda n: abs(440 * 2**((n-69)/12) - frequency))
        if note != last:
            transitions.append({'seconds': (begin+2048)/sample_rate, 'note': note})
            last = note
    periods = np.diff([x['seconds'] for x in transitions[1:]])
    results.append({'phase':phase, 'clock_bpm':120 if phase==1 else 240 if phase==3 else None,
                    'frames':len(pcm), 'rms':float(np.sqrt(np.mean(pcm*pcm))),
                    'transitions':transitions, 'median_step_seconds':float(np.median(periods)) if len(periods) else None})
assert abs(results[1]['median_step_seconds'] - .5) < .02
assert abs(results[3]['median_step_seconds'] - .25) < .02
assert results[2]['rms'] < results[1]['rms'] * .01
report = {'passed':True, 'sample_rate':88200, 'transport':'Start, Stop, Continue with newly pressed keys',
          'clock_ppqn':24, 'observations':results,
          'scope':'Actual firmware audio response; no physical MIDI or audio device used.'}
Path(f'{prefix}-analysis.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':True,'step_120_bpm':results[1]['median_step_seconds'],
                  'step_240_bpm':results[3]['median_step_seconds'],'stop_rms':results[2]['rms']}))
