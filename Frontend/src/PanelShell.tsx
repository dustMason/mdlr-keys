import type { CSSProperties, PropsWithChildren } from 'react';
import type { ModuleRenderProps } from '../upstream/src/modules/types';

// Only the rack container is adapted: the original instrument faces are untouched.
export function ModuleShell({definition,children}:PropsWithChildren<ModuleRenderProps>) {
  return <section className={`rackModule moduleDefaultSkin module-${definition.slug} rackUnits-${definition.rackUnits}`}
    style={{width:'100%',height:'100%','--module-accent':definition.accent} as CSSProperties}>
    {['left','right'].map(side=><div key={side} className={`rackFlange rackFlange-${side}`}>
      {Array.from({length:definition.rackUnits},(_,i)=><div className="rackFlangeUnit" key={i}><span className="rackScrew rackScrew-top"/><span className="rackScrew rackScrew-bottom"/></div>)}
    </div>)}
    <div className="moduleFace">
      <div className="moduleHeader nativePanelHeader"><span className="moduleName">{definition.name}</span><span className="originalLabel">mdlr</span></div>
      <div className="moduleBody">{children}</div>
    </div>
  </section>;
}
