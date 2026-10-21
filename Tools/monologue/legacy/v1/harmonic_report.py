#!/usr/bin/env python3
"""Inspect harmonics without treating unobserved analog phase as an error."""
import argparse,json,os
from pathlib import Path
import numpy as np
from scipy.optimize import minimize_scalar
from audio_compare import read_audio
BASE=Path(__file__).resolve().parent/"data"
WINDOWS=[('s0s_triangle',.10,.30,76),('harpie_saw',.15,.40,48),('pinoesque',.15,.40,48),('string_hold',.20,.50,57)]
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('run',type=Path);p.add_argument('--data-root',type=Path,default=BASE);a=p.parse_args();rows=[];data_root=a.data_root.resolve()
 for ident,start,end,note in WINDOWS:
  row={'id':ident,'window_seconds':[start,end]}
  for kind,path in [('reference',data_root/'corpus'/(ident+'.reference.wav')),('baseline',a.run/'baseline'/(ident+'.wav')),('best',a.run/'best'/(ident+'.wav'))]:
   x,sr=read_audio(path,48000);x=x[round(start*sr):round(end*sr)];t=np.arange(len(x))/sr;window=np.hanning(len(x));guess=440*2**((note-69)/12)
   def power(f):return -abs(np.sum(x*window*np.exp(-2j*np.pi*f*t)))**2
   f=minimize_scalar(power,bounds=(guess*.99,guess*1.01),method='bounded').x
   amps=[float(abs(np.sum(x*window*np.exp(-2j*np.pi*f*h*t)))) for h in range(1,13)]
   row[kind]={'fundamental_hz':f,'harmonics_db_relative_fundamental':[float(20*np.log10(max(v,1e-12)/amps[0])) for v in amps]}
  rows.append(row)
 (a.run/'harmonic-residuals.json').write_text(json.dumps(rows,indent=2)+'\n')
 os.environ.setdefault("MPLCONFIGDIR",str(BASE/".matplotlib-cache"))
 import matplotlib
 matplotlib.use('Agg')
 import matplotlib.pyplot as plt
 fig,axs=plt.subplots(2,2,figsize=(10,6.7),sharex=True,sharey=True,layout='constrained')
 names={'s0s_triangle':'S0S · open-filter triangles','harpie_saw':'Harpie · single VCO2 saw','pinoesque':'Pinoesque · triangle + saw, drive','string_hold':'String Hold · held out'}
 for ax,row in zip(axs.flat,rows):
  for kind,label,color,style in [('reference','Recorded instrument','#222222','-'),('baseline','Initial model','#bd7e00','--'),('best','Fitted model','#3468d4','-')]:
   ax.plot(np.arange(1,13),np.maximum(-60,row[kind]['harmonics_db_relative_fundamental']),style,marker='o',ms=3,color=color,label=label)
  ax.set_title(names[row['id']],fontsize=11);ax.set_ylim(-61,15);ax.set_xticks([1,2,3,4,6,8,10,12]);ax.grid(alpha=.18);ax.spines[['top','right']].set_visible(False)
 axs[0,0].legend(fontsize=8,loc='lower left');fig.supxlabel('Harmonic number');fig.supylabel('dB relative to each signal’s fundamental')
 fig.suptitle('Monologue paired-patch harmonic comparison',fontsize=15)
 fig.savefig(a.run/'harmonic-residuals.png',dpi=170)
 print(a.run/'harmonic-residuals.png')
if __name__=='__main__':main()
