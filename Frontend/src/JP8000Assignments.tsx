import {useId, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import type {JPParam, JPPart} from './JP8000Panel';

type Destination = readonly [key:string,label:string];
const groups:readonly {id:string;label:string;destinations:readonly Destination[]}[] = [
  {id:'filter',label:'Filter',destinations:[
    ['CutoffFrequency','Cutoff'],['Resonance','Resonance'],['CutoffFreqKeyFollow','Key follow'],
    ['FilterLfo1Depth','LFO 1 depth'],['FilterLfo2Depth','LFO 2 depth'],['FilterEnvDepth','Envelope depth'],
    ['FilterEnvAttackTime','Attack'],['FilterEnvDecayTime','Decay'],['FilterEnvSustainLevel','Sustain'],['FilterEnvReleaseTime','Release'],
  ]},
  {id:'osc',label:'Oscillators',destinations:[
    ['OscillatorBalance','Balance'],['CrossModulationDepth','Cross modulation'],
    ['Osc1Control1','OSC 1 control 1'],['Osc1Control2','OSC 1 control 2'],
    ['Osc2Range','OSC 2 range'],['Osc2FineWide','OSC 2 fine / wide'],
    ['Osc2Control1','OSC 2 pulse width'],['Osc2Control2','OSC 2 PWM depth'],
  ]},
  {id:'pitch',label:'Pitch',destinations:[
    ['PitchLfo1Depth','LFO 1 depth'],['PitchLfo2Depth','LFO 2 depth'],['PitchEnvelopeDepth','Envelope depth'],
    ['PitchEnvelopeAttackTime','Attack'],['PitchEnvelopeDecayTime','Decay'],['PortamentoTime','Portamento time'],
  ]},
  {id:'amp',label:'Amp',destinations:[
    ['AmpLevel','Level'],['AmpLfo1Depth','LFO 1 depth'],['AmpLfo2Depth','LFO 2 depth'],
    ['AmpEnvAttackTime','Attack'],['AmpEnvDecayTime','Decay'],['AmpEnvSustainLevel','Sustain'],['AmpEnvReleaseTime','Release'],
  ]},
  {id:'effects',label:'Effects',destinations:[
    ['ToneControlBass','Bass'],['ToneControlTreble','Treble'],['MultiEffectsLevel','Chorus level'],
    ['DelayTime','Delay time'],['DelayFeedback','Delay feedback'],['DelayLevel','Delay level'],
  ]},
  {id:'lfo',label:'LFO',destinations:[['Lfo1Rate','LFO 1 rate'],['Lfo1Fade','LFO 1 fade'],['Lfo2Rate','LFO 2 rate']]},
];

type Props = {
  source:'ribbon'|'velocity';onSourceChange:(source:'ribbon'|'velocity')=>void;
  parameters:JPParam[];values:Record<number,number>;oscLabels:string[];part:JPPart;
  enableControl:ReactNode;velocityEnabled:boolean;onParameter:(id:number,value:number)=>void;
};

type AmountProps={param:JPParam;raw:number;id:string;label:string;onParameter:(id:number,value:number)=>void};
function AssignmentAmount({param,raw,id,label,onParameter}:AmountProps){
  const gesture=useRef<{id:number;x:number;y:number;offset:number;axis:'pending'|'horizontal'|'vertical'}|null>(null);
  const fraction=(raw-param.min)/(param.max-param.min)*100;
  const setAt=(input:HTMLInputElement,x:number,offset:number)=>{
    const bounds=input.getBoundingClientRect();
    const inset=12*bounds.width/input.clientWidth;
    const position=Math.max(0,Math.min(1,(x-offset-bounds.left-inset)/(bounds.width-2*inset)));
    onParameter(param.id,Math.round(param.min+position*(param.max-param.min)));
  };
  return <input id={id} type="range" min={param.min-127} max={param.max-127} step={1} value={raw-127}
    aria-label={label} aria-valuetext={raw>127?`+${raw-127}`:String(raw-127)}
    style={{'--jp-amount-start':`${Math.min(50,fraction)}%`,'--jp-amount-end':`${Math.max(50,fraction)}%`} as CSSProperties}
    onChange={event=>{if(!gesture.current)onParameter(param.id,Number(event.currentTarget.value)+127);}}
    onPointerDown={event=>{
      if(event.pointerType!=='touch')return;
      // Native range inputs change on touch-down, before a vertical scroll can take over.
      event.preventDefault();
      if(!event.isPrimary||gesture.current)return;
      const input=event.currentTarget;
      const bounds=input.getBoundingClientRect(),inset=12*bounds.width/input.clientWidth;
      const center=bounds.left+inset+(bounds.width-2*inset)*fraction/100;
      gesture.current={id:event.pointerId,x:event.clientX,y:event.clientY,
        offset:Math.abs(event.clientX-center)<=inset?event.clientX-center:0,axis:'pending'};
      input.focus({preventScroll:true});input.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event=>{
      const current=gesture.current;if(!current||current.id!==event.pointerId)return;
      const dx=Math.abs(event.clientX-current.x),dy=Math.abs(event.clientY-current.y);
      if(current.axis==='pending'&&Math.max(dx,dy)>=6)current.axis=dx>dy?'horizontal':'vertical';
      if(current.axis==='horizontal')setAt(event.currentTarget,event.clientX,current.offset);
    }}
    onPointerUp={event=>{
      const current=gesture.current;if(!current||current.id!==event.pointerId)return;
      if(current.axis!=='vertical')setAt(event.currentTarget,event.clientX,current.offset);
      gesture.current=null;
    }}
    onPointerCancel={event=>{if(gesture.current?.id===event.pointerId)gesture.current=null;}}
    onLostPointerCapture={event=>{if(gesture.current?.id===event.pointerId)gesture.current=null;}}/>;
}

/** Wire amounts are centered on 127, including the two narrower OSC 2 ranges. */
export function JP8000Assignments({source,onSourceChange,parameters,values,oscLabels,part,enableControl,velocityEnabled,onParameter}:Props){
  const [group,setGroup]=useState('filter');
  const [focusedId,setFocusedId]=useState<{id:number;source:string;part:JPPart}|null>(null);
  const id=useId();
  const sourceName=source==='ribbon'?'Ribbon':'Velocity';
  const byKey=new Map(parameters.map(param=>[param.key.replace(/^(Control|Velocity)/,'').replace('FilterEnvSusLevel','FilterEnvSustainLevel'),param]));
  const destinations=groups.flatMap(category=>category.destinations.map(([key,label])=>{
    const param=byKey.get(key);
    if(!param)throw new Error(`Missing ${sourceName} assignment: ${key}`);
    const raw=Math.max(param.min,Math.min(param.max,values[param.id]??param.defaultValue));
    const name=key==='Osc1Control1'?`OSC 1 ${oscLabels[0].toLowerCase()}`:key==='Osc1Control2'?`OSC 1 ${oscLabels[1].toLowerCase()}`:label;
    return {param,raw,name,category};
  }));
  const assigned=destinations.filter(x=>x.raw!==127);
  const visible=destinations.filter(x=>group==='assigned'?(x.raw!==127||(x.param.id===focusedId?.id&&source===focusedId.source&&part===focusedId.part)):x.category.id===group);
  const groupName=group==='assigned'?'Assigned':groups.find(x=>x.id===group)!.label;
  const pickGroup=(next:string)=>{setFocusedId(null);setGroup(next);};

  return <section className="jpAssignments" aria-label="Controller assignments">
    <div className="jpAssignmentHeader">
      <div className="jpSegments" role="group" aria-label="Assignment source">
        <button aria-pressed={source==='ribbon'} onClick={()=>{setFocusedId(null);onSourceChange('ribbon');}}>RIBBON</button>
        <button aria-pressed={source==='velocity'} onClick={()=>{setFocusedId(null);onSourceChange('velocity');}}>VELOCITY</button>
      </div>
      <span className="jpAssignmentPart"><span>{part===2?'Both parts · showing Upper':part===1?'Lower part':'Upper part'}</span>
        {source==='velocity'&&!velocityEnabled&&<span className="jpAssignmentNotice">{part===2?'Upper velocity is off':'Velocity is off'}</span>}
      </span>
      {enableControl}
    </div>
    <div className="jpAssignmentWorkspace">
      <nav className="jpAssignmentGroups" aria-label="Assignment destinations">
        <button className="jpAssignedShortcut" aria-pressed={group==='assigned'} onClick={()=>pickGroup('assigned')}>
          <span>Assigned</span><span className="jpAssignedCount">{assigned.length}</span>
        </button>
        {groups.map(category=><button key={category.id} aria-pressed={group===category.id} onClick={()=>pickGroup(category.id)}>
          <span>{category.label}</span><span className="jpAssignedCount" title="Non-zero amounts">{assigned.filter(x=>x.category.id===category.id).length}</span>
        </button>)}
      </nav>
      <div className="jpAssignmentEditor">
        <div className="jpAssignmentHeading"><h2>{groupName}</h2><span>AMOUNT · 0 = NO CHANGE</span></div>
        <div className="jpAssignmentRows" key={`${source}-${group}-${part}`}>
          {visible.map(({param,raw,name,category})=>{
            const amount=raw-127;
            const label=group==='assigned'?`${category.label} · ${name}`:name;
            const accessible=`${sourceName} ${category.label} ${name} amount`;
            return <div className="jpAssignmentRow" key={param.id} data-control={param.key} data-assigned={amount!==0}
              onFocusCapture={()=>setFocusedId({id:param.id,source,part})} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocusedId(null);}}>
              <label htmlFor={`${id}-${param.id}`}>{label}</label>
              <AssignmentAmount id={`${id}-${param.id}`} param={param} raw={raw} label={accessible} onParameter={onParameter}/>
              <output htmlFor={`${id}-${param.id}`} aria-hidden="true">{amount>0?`+${amount}`:amount}</output>
              <button aria-label={`Zero ${sourceName} ${category.label} ${name}`} disabled={amount===0&&part!==2} onClick={()=>onParameter(param.id,127)}>ZERO</button>
            </div>;
          })}
          {visible.length===0&&<div className="jpAssignmentEmpty"><h3>No assigned amounts</h3><p>Choose a destination group to add {sourceName.toLowerCase()} modulation.</p><button onClick={()=>pickGroup('filter')}>OPEN FILTER</button></div>}
        </div>
      </div>
    </div>
  </section>;
}
