import {useState, type CSSProperties, type ReactNode} from 'react';
import type {ModuleDefinition, ModuleRenderProps, ParamDefinition} from '../upstream/src/modules/types';
import {useKnobControl} from './TouchKnob';
import metadata from '../../App/MonologueControls.json';
import './monologue.css';

type MonoParam = ParamDefinition & {group:string; labels?:string[]};
export const monologueParameters:MonoParam[] = metadata.params;
const byKey = new Map(monologueParameters.map(param=>[param.key,param]));
function parameter(key:string):MonoParam {
  const found=byKey.get(key);
  if(!found)throw new Error('Unknown monologue parameter '+key);
  return found;
}
function display(param:MonoParam,value:number):string {
  if(param.labels)return param.labels[Math.round(value-param.min)]??'—';
  if(param.key==='bpm')return value.toFixed(1)+' BPM';
  if(param.key==='programLevelDb')return (value>0?'+':'')+value.toFixed(1)+' dB';
  if(param.key==='fineTune'||param.key==='tune1'||param.key==='tune2'||param.id>=48)
    return (value>0?'+':'')+Math.round(value)+' ct';
  return (value>0&&param.min<0?'+':'')+Math.round(value*100)+'%';
}
export const monologueDefinition:ModuleDefinition = {
  kind:5,slug:'monologue',name:'MONOLOGUE',accent:'#c52e29',rackWidth:'full',rackUnits:4,
  inputs:[],outputs:[],params:monologueParameters,presets:[],Component:MonologuePanel,
};
type ControlProps={param:MonoParam;value:number;onChange:(value:number)=>void;label?:string};

function Dial({param,value,onChange,label}:ControlProps){
  const control=useKnobControl({param,value,onChange,displayFormatter:next=>display(param,next)});
  return <div className="monoDial" data-control={param.key}>
    <span className="monoControlLabel">{label??param.label}</span>
    <span {...control.faceProps} className="monoDialFace" data-param-id={param.id}
      style={{'--mono-angle':control.degrees+'deg'} as CSSProperties}>
      <svg className="monoDialTicks" viewBox="0 0 80 80" aria-hidden="true">
        {[-132,-88,-44,0,44,88,132].map(angle=><path key={angle} d="M40 3V8" transform={'rotate('+angle+' 40 40)'}/>)}
      </svg>
      <span className="monoDialRotor" aria-hidden="true"/>
    </span>
    <output className="monoValue" aria-hidden="true">{display(param,value)}</output>
  </div>;
}
function Wave({name}:{name:string}){
  const paths:Record<string,string>={
    Saw:'M2 14L12 3V17L22 6',
    Triangle:'M2 14L7 4L17 16L22 6',
    Square:'M2 15V5H12V15H22V5',
    Noise:'M2 11L4 5L6 14L8 8L10 17L12 2L14 12L16 7L18 16L20 3L22 10',
  };
  return <svg viewBox="0 0 24 20" aria-hidden="true"><path d={paths[name]}/></svg>;
}
function Section({title,children,className=''}:{title:string;children:ReactNode;className?:string}){
  return <section className={'monoSection '+className} aria-label={title}><h2>{title}</h2>{children}</section>;
}
function TuningFader({param,value,onChange,label}:ControlProps){
  const control=useKnobControl({param,value,onChange,displayFormatter:next=>display(param,next)});
  return <div className={'monoTuneLane '+(label?.includes('♯')?'monoSharp':'')} data-control={param.key}>
    <span className="monoTuneNote">{label}</span>
    <span {...control.faceProps} className="monoTuneFader" aria-orientation="vertical"
      data-param-id={param.id} style={{'--mono-tuning':control.normalized*100+'%'} as CSSProperties}>
      <span className="monoTuneTicks" aria-hidden="true"/>
      <span className="monoTuneTrack" aria-hidden="true"><span className="monoTuneCap"/></span>
    </span>
    <output className="monoValue" aria-hidden="true">{value>0?'+':''}{Math.round(value)}</output>
  </div>;
}
export function MonologuePanel({module,onParamChange}:ModuleRenderProps){
  const [view,setView]=useState<'sound'|'tuning'>('sound');
  const [lastKey,setLastKey]=useState('cutoff');
  const value=(key:string)=>module.params[parameter(key).id]??parameter(key).defaultValue;
  const change=(key:string,next:number)=>{
    setLastKey(key);
    onParamChange(module.id,parameter(key).id,next);
  };
  const control=(key:string,label?:string):ControlProps=>({
    param:parameter(key),value:value(key),label,onChange:next=>change(key,next),
  });
  const dial=(key:string,label?:string)=><Dial key={key} {...control(key,label)}/>;
  const dials=(children:ReactNode)=><div className="monoDials">{children}</div>;
  const segments=(key:string,label?:string,waves=false)=><div className={'monoSwitchRow '+(label?'':'monoWaveRow')} key={key}>
    {label&&<span className="monoSwitchLabel">{label}</span>}
    <div className="monoSegments" role="group" aria-label={parameter(key).label} data-param-id={parameter(key).id}>
      {parameter(key).labels?.map((label,index)=><button type="button" key={label}
        aria-pressed={Math.round(value(key))===index+parameter(key).min}
        onClick={()=>change(key,index+parameter(key).min)}>
        {waves&&<Wave name={label}/>}<span>{label}</span>
      </button>)}
    </div>
  </div>;
  const toggle=(key:string,label:string)=><button type="button" className="monoToggle" key={key} data-param-id={parameter(key).id}
    aria-pressed={value(key)!==0} onClick={()=>change(key,value(key)===0?1:0)}>
    <span className="monoLed" aria-hidden="true"/><span>{label}</span><span className="monoToggleState">{value(key)?'On':'Off'}</span>
  </button>;
  const last=parameter(lastKey);
  return <div className="monoPanel">
    <header className="monoHeader">
      <div className="monoDisplay" aria-label="Last edited parameter">
        <span>{last.label}</span><strong>{display(last,value(lastKey))}</strong>
      </div>
      <h1>monologue</h1>
      <nav className="monoViews" aria-label="Monologue control views">
        <button type="button" aria-current={view==='sound'?'page':undefined} onClick={()=>setView('sound')}>Sound</button>
        <button type="button" aria-current={view==='tuning'?'page':undefined} onClick={()=>setView('tuning')}>Tuning</button>
      </nav>
    </header>
    {view==='sound'?<div className="monoSoundGrid">
      <Section title="VCO 1">
        <div className="monoSelectors">{segments('wave1',undefined,true)}</div>
        {dials(<>{dial('shape1','Shape')}{dial('level1','Level')}</>)}
      </Section>
      <Section title="VCO 2">
        <div className="monoSelectors">{segments('wave2',undefined,true)}{segments('octave2','Octave')}</div>
        {dials(<>{dial('shape2','Shape')}{dial('tune2','Pitch')}{dial('level2','Level')}</>)}
        {segments('syncRing','Mod')}
      </Section>
      <Section title="Filter & drive">
        <div className="monoSignalPath" aria-hidden="true"><span>Mix</span><i/><span>Filter</span><i/><span>Amp</span><i/><span>Drive</span></div>
        {dials(<>{dial('cutoff')}{dial('resonance')}{dial('drive')}</>)}
      </Section>
      <Section title="Envelope">
        <div className="monoSelectors">{segments('egType','Type')}{segments('egTarget','Target')}</div>
        {dials(<>{dial('attack')}{dial('decay')}{dial('egInt','Depth')}</>)}
      </Section>
      <Section title="LFO">
        <div className="monoSelectors">{segments('lfoWave',undefined,true)}{segments('lfoMode','Mode')}</div>
        {dials(<>{dial('rate','Rate')}{dial('lfoInt','Depth')}</>)}
        {segments('lfoTarget','Target')}
      </Section>
      <Section title="Play">
        <div className="monoSelectors" aria-hidden="true"/>
        {dials(<>{dial('glide')}{dial('fineTune','Tune')}{dial('level','Level')}</>)}
      </Section>
    </div>:<div className="monoTuningPage">
      <section className="monoMicrotuning" aria-label="Microtuning">
        <div className="monoTuningHeading"><div><h2>Microtuning</h2><span>Pitch class offsets · cents</span></div>
          <button type="button" className="monoReset" onClick={()=>{for(let i=0;i<12;i++)change('tuning_'+i,0);}}>Equal temperament</button>
        </div>
        <div className="monoTuningGrid">
          {['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'].map((note,i)=>
            <TuningFader key={note} {...control('tuning_'+i,note)}/>)}
        </div>
      </section>
      <div className="monoAdvancedGrid">
        <Section title="Pitch & level">
          {segments('octave1','VCO 1')}
          {dials(<>{dial('tune1','VCO 1 pitch')}{dial('fineTune','Fine tune')}{dial('programLevelDb','Level trim')}</>)}
        </Section>
        <Section title="Expression">
          {toggle('egLegato','Envelope legato')}
          {dials(<>{dial('cutoffKeytrack','Key track')}{dial('cutoffVelocity','Filter vel')}{dial('ampVelocity','Amp vel')}</>)}
        </Section>
        <Section title="LFO & glide" className="monoTiming">
          <div className="monoTimingSwitches">
            {toggle('lfoKeySync','Sync slow LFO')}{toggle('lfoBpmSync','Tempo sync')}{toggle('glideLegato','Legato glide')}
          </div>
          {dial('bpm','Tempo')}
        </Section>
      </div>
    </div>}
  </div>;
}
