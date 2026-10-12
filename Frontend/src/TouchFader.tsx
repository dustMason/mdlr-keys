import type { CSSProperties, ReactNode } from 'react';
import type { ParamDefinition } from '../upstream/src/modules/types';
import { useKnobControl } from './TouchKnob';

/** The entire lane owns the gesture; there is no invisible native range thumb. */
export function TouchFader({param,value,onChange,theme,label,className='',decoration,style}: {
  param:ParamDefinition; value:number; onChange:(value:number)=>void;
  theme:'one'|'six'; label?:string; className?:string;
  decoration?:ReactNode; style?:CSSProperties;
}) {
  const control=useKnobControl({param,value,onChange});
  return <span {...control.faceProps}
    aria-orientation="vertical" data-param-id={param.id}
    className={`${theme}Fader touchFader ${className}`}
    onContextMenu={event=>event.preventDefault()}
    style={{...style,[`--${theme}-fader-fill`]:`${control.normalized*100}%`} as CSSProperties}>
    <span className={`${theme}FaderLabel`} aria-hidden="true">
      <span className={`${theme}FaderLabelText`}>{label ?? param.label}</span>{decoration}
    </span>
    <span className={`${theme}FaderTrack`} aria-hidden="true">
      {theme==='one' && <span className="oneFaderFill"/>}
      <span className={`${theme}FaderCap`}/>
    </span>
  </span>;
}
