import {useState, type CSSProperties, type ReactNode} from 'react';
import type {ModuleDefinition, ModuleRenderProps, ParamDefinition} from '../upstream/src/modules/types';
import {TouchFader} from './TouchFader';
import {useKnobControl} from './TouchKnob';
import engineMetadata from '../../App/JP8000Controls.json';
import factoryNames from './jp8000-factory-names.json';
import './jp8000.css';
import {JP8000Assignments} from './JP8000Assignments';

export type JPPart = 0 | 1 | 2;
export type JPAction = {type:'jpAction';engine:4;action:'part'|'patch'|'performance'|'panel';value:number};
export type JP8000State = {
  ready:boolean;status:string;lcd:string[];part:JPPart;params:Record<number,number>;
  patch_name?:string|{upper?:string;lower?:string};midi_channels?:number[];
};
export type JPParam=ParamDefinition & {group:string;labels?:string[]};
export const jpParameters:JPParam[]=engineMetadata.params;
export const jpParameterById=new Map(jpParameters.map(p=>[p.id,p]));
const byKey=new Map(jpParameters.map(p=>[p.key,p]));
const p=(key:string)=>{const found=byKey.get(key);if(!found)throw new Error(`Unknown JP parameter ${key}`);return found;};
const display=(param:JPParam,value:number)=>param.labels?.[Math.round(value-param.min)]??String(Math.round(value));
const factoryPatches=factoryNames.filter(x=>x.kind==='patch');
const factoryPerformances=factoryNames.filter(x=>x.kind==='performance');
const closedMenuLabels:Record<string,string[]>={
  ChorusType:['SUPER SLOW','SUPER MID','SUPER FAST','SUPER CLR','FLANGE SLOW','FLANGE DEEP','FLANGE FAST','DEEP PHASE','JET PHASE','TWISTING','FREEZE 1','FREEZE 2'],
  DelayType:['PAN L → R','PAN R → L','PAN SHORT','MONO SHORT','MONO LONG'],
};
const oscLabels=[['DETUNE','MIX'],['OFFSET','LFO 1 DEPTH'],['CUTOFF FREQ','RESONANCE'],
  ['HARMONICS','FEEDBACK'],['PULSE WIDTH','PWM DEPTH'],['SHAPE','LFO 1 DEPTH'],['SHAPE','LFO 1 DEPTH']];

export const jp8000Definition:ModuleDefinition={
  kind:4,slug:'jp8000',name:'JP-8000',accent:'#f7a466',rackWidth:'full',rackUnits:4,
  inputs:[],outputs:[],params:jpParameters,presets:[],Component:JPModule,
};
function JPModule(props:ModuleRenderProps){
  return <JP8000Panel params={props.module.params} onParameter={(id,value)=>props.onParamChange(props.module.id,id,value)} onAction={()=>{}}/>;
}
type Props={native?:boolean;state?:JP8000State;params:Record<number,number>;onParameter:(id:number,value:number)=>void;onAction:(message:JPAction)=>void};
type ControlProps={param:JPParam;value:number;onChange:(value:number)=>void;label?:string};

function Dial({param,value,onChange,label}:ControlProps){
  const named={...param,label:label??param.label};
  const control=useKnobControl({param:named,value,onChange,displayFormatter:next=>display(param,next)});
  return <div className="jpDial" data-control={param.key}>
    <span className="jpControlLabel">{label??param.label}</span>
    <span {...control.faceProps} className="jpDialFace"
      data-param-id={param.id} style={{'--jp-angle':`${control.degrees}deg`} as CSSProperties}>
      <svg className="jpDialTicks" viewBox="0 0 60 60" aria-hidden="true">
        {[-132,-88,-44,0,44,88,132].map(angle=><path key={angle} d="M30 2V5" transform={`rotate(${angle} 30 30)`}/>)}
      </svg><span className="jpDialRotor" aria-hidden="true"/>
    </span>
    <output className="jpValue" aria-hidden="true">{display(param,value)}</output>
  </div>;
}
function Fader({param,value,onChange,label}:ControlProps){
  return <div className="jpFaderWrap" data-control={param.key}>
    <TouchFader param={{...param,label:label??param.label}} value={value} onChange={onChange}
      theme="six" label={label??param.label} className="jpFader" displayFormatter={next=>display(param,next)}/>
    <output className="jpValue" aria-hidden="true">{display(param,value)}</output>
  </div>;
}
function Section({title,className='',children}: {title:string;className?:string;children:ReactNode}){
  return <section className={`jpSection ${className}`} aria-label={title}><h2>{title}</h2>{children}</section>;
}

export function JP8000Panel({native=false,state,params,onParameter,onAction}:Props){
  const [view,setView]=useState<'sound'|'perform'|'assign'|'panel'>('sound');
  const [assignment,setAssignment]=useState<'ribbon'|'velocity'>('ribbon');
  const ready=state?.ready===true, part=state?.part??0;
  const statusText=ready?(state?.status||'Ready'):(native?(state?.status||'Starting JP-8000...'):'Visual preview · audio in the native app.');
  const expandedStatus=!ready||/\b(error|failed|failure|unavailable|missing)\b/i.test(statusText);
  const values={...params,...state?.params};
  const value=(key:string)=>values[p(key).id]??p(key).defaultValue;
  const change=(key:string,next:number)=>{if(ready)onParameter(p(key).id,Math.round(next));};
  const action=(name:JPAction['action'],next:number)=>{if(ready)onAction({type:'jpAction',engine:4,action:name,value:next});};
  const control=(key:string,label?:string):ControlProps=>({param:p(key),value:value(key),label,onChange:next=>change(key,next)});
  const dial=(key:string,label?:string)=><Dial key={key} {...control(key,label)}/>;
  const fader=(key:string,label?:string)=><Fader key={key} {...control(key,label)}/>;
  const menu=(key:string,label?:string)=><label className={`jpMenu ${closedMenuLabels[key]?'jpShortMenu':''}`} key={key}>
    <span className="jpControlLabel">{label??p(key).label}</span>
    <select aria-label={label??p(key).label} title={display(p(key),value(key))} value={value(key)} onChange={e=>change(key,Number(e.target.value))}>
      {Array.from({length:p(key).max-p(key).min+1},(_,i)=>i+p(key).min).map(v=><option key={v} value={v}>{display(p(key),v)}</option>)}
    </select>{closedMenuLabels[key]&&<span className="jpClosedMenuLabel" aria-hidden="true">{closedMenuLabels[key][value(key)]??display(p(key),value(key))}</span>}</label>;
  const toggle=(key:string,label?:string)=><button key={key} className="jpSwitch" aria-pressed={value(key)!==0}
    onClick={()=>change(key,value(key)===0?1:0)}><span className="jpLed" aria-hidden="true"/>{label??p(key).label}</button>;
  const buttons=(key:string,labels?:string[])=><div className="jpSegments" role="group" aria-label={p(key).label}>
    {(labels??p(key).labels??[]).map((label,i)=><button key={i} aria-pressed={value(key)===i+p(key).min}
      onClick={()=>change(key,i+p(key).min)}>{label}</button>)}</div>;
  const osc=oscLabels[Math.max(0,Math.min(6,Math.round(value('Osc1Waveform'))))];
  const patchName=typeof state?.patch_name==='string'?state.patch_name:
    part===1?state?.patch_name?.lower:state?.patch_name?.upper;
  const assignmentParams=jpParameters.filter(x=>x.group===(assignment==='ribbon'?'Ribbon Assign':'Velocity Assign'));

  return <div className="jpPanel" data-ready={ready}>
    <header className="jpHeader">
      <div className="jpLCD" role="status" aria-label="JP-8000 firmware display">
        <span>{state?.lcd?.[0]||'JP-8000'}</span>
        <span>{state?.lcd?.[1]||(native?'STARTING...':'VISUAL PREVIEW')}</span>
      </div>
      <div className="jpIdentity"><h1>JP-8000</h1></div>
      <div className="jpPartSelect"><span className="jpControlLabel">PANEL SELECT</span>
        <div className="jpSegments" role="group" aria-label="Panel edit part">
          {(['UPPER','LOWER','BOTH'] as const).map((name,i)=><button key={name} disabled={!ready} aria-pressed={part===i} onClick={()=>action('part',i)}>{name}</button>)}
        </div>
      </div>
    </header>
    <div className="jpPresetBar">
      <label className="jpMenu jpPreset"><span className="jpControlLabel">FACTORY PERFORMANCE</span>
        <select aria-label="Factory performance" disabled={!ready} value="" onChange={e=>action('performance',Number(e.target.value))}>
          <option value="" disabled>{state?.lcd?.[0]?.includes('PERFORM')?state.lcd[1]?.trim()||'Choose a performance':'Choose a performance'}</option>{factoryPerformances.map(x=><option value={x.index} key={x.index}>{x.label} · {x.name}</option>)}
        </select></label>
      <label className="jpMenu jpPreset"><span className="jpControlLabel">{part===2?'PATCH · BOTH PARTS':`PATCH · ${part===0?'UPPER':'LOWER'}`}</span>
        <select aria-label="Factory patch" disabled={!ready} value="" onChange={e=>action('patch',Number(e.target.value))}>
          <option value="" disabled>{patchName||'Choose a patch'}</option>{factoryPatches.map(x=><option value={x.index} key={x.index}>{x.label} · {x.name}</option>)}
        </select></label>
      <fieldset className="jpKeyMode" disabled={!ready}><legend className="jpControlLabel">KEY MODE</legend>{buttons('KeyMode')}</fieldset>
    </div>
    <nav className={`jpViews ${expandedStatus?'jpViewsExpanded':''}`} aria-label="JP-8000 control views">
      {([['sound','Sound'],['perform','Performance'],['assign','Assignments'],['panel','Panel']] as const).map(([id,label])=><button key={id} aria-current={view===id?'page':undefined} onClick={()=>setView(id)}>{label}</button>)}
      {expandedStatus&&<span className="jpStatus" role="status">{statusText}</span>}
    </nav>
    <fieldset className="jpControls" disabled={!ready}><div inert={!ready}>
    {view==='sound'&&<div className="jpSoundGrid">
      <Section title="LFO 1" className="jpLfo">
        {menu('Lfo1Waveform','WAVEFORM')}
        <div className="jpKnobs">{dial('Lfo1Rate','RATE')}{dial('Lfo1Fade','FADE')}</div>
        {menu('LFO1Sync','TEMPO SYNC')}
      </Section>
      <Section title="OSC COMMON" className="jpOscCommon">
        <div className="jpOscModulation">{dial('OscillatorBalance','BALANCE')}{dial('CrossModulationDepth','X-MOD')}{dial('OscLfo1Depth','LFO 1 DEPTH')}{toggle('RingModulatorSwitch','RING')}</div>
        <div className="jpPitchEnvelope"><div className="jpPitchControls">{menu('Lfo1AndEnvelopeDestination','LFO / ENV DEST')}{dial('PitchEnvelopeDepth','ENV DEPTH')}</div><div className="jpFaders">{fader('PitchEnvelopeAttackTime','A')}{fader('PitchEnvelopeDecayTime','D')}</div></div>
      </Section>
      <Section title="OSC 1" className="jpOscOne">
        {menu('Osc1Waveform','WAVEFORM')}
        <div className="jpFaders jpOscFaders">{fader('Osc1Control1',osc[0])}{fader('Osc1Control2',osc[1])}</div>
      </Section>
      <Section title="OSC 2" className="jpOscTwo">
        <div className="jpInline">{menu('Osc2Waveform','WAVEFORM')}{toggle('Osc2SyncSwitch','SYNC')}</div>
        <div className="jpOscTwoBody"><div className="jpKnobColumn">{dial('Osc2Range','RANGE')}{dial('Osc2FineWide','FINE / WIDE')}</div>
          <div className="jpFaders">{fader('Osc2Control1','PULSE WIDTH')}{fader('Osc2Control2','PWM DEPTH')}</div>
        </div>
      </Section>
      <Section title="FILTER" className="jpFilter">
        <div className="jpFilterTop"><div className="jpFilterSwitches">{buttons('FilterType')}{buttons('CutoffSlope',['12 dB','24 dB'])}</div>
          {dial('CutoffFrequencyKeyFollow','KEY FOLLOW')}{dial('FilterLfo1Depth','LFO 1 DEPTH')}{dial('FilterEnvelopeDepth','ENV DEPTH')}
        </div>
        <div className="jpFaders jpFilterFaders">{fader('CutoffFrequency','CUTOFF')}{fader('Resonance','RESONANCE')}<span className="jpFaderDivider"/>
          {fader('FilterEnvelopeAttackTime','A')}{fader('FilterEnvelopeDecayTime','D')}{fader('FilterEnvelopeSustainLevel','S')}{fader('FilterEnvelopeReleaseTime','R')}</div>
      </Section>
      <Section title="AMP" className="jpAmp">
        <div className="jpAmpTop">{dial('AmpLfo1Depth',value('AutoPanManualPanSwitch')===2?'PAN':'LFO 1 DEPTH')}{menu('AutoPanManualPanSwitch','AUTO / MANUAL')}{dial('AmpLevel','LEVEL')}</div>
        <div className="jpFaders">{fader('AmpEnvelopeAttackTime','A')}{fader('AmpEnvelopeDecayTime','D')}{fader('AmpEnvelopeSustainLevel','S')}{fader('AmpEnvelopeReleaseTime','R')}</div>
      </Section>
      <Section title="EFFECTS" className="jpEffects">
        <div className="jpKnobs">{dial('ToneControlBass','BASS')}{dial('ToneControlTreble','TREBLE')}{dial('ChorusLevel','CHORUS')}</div>
        {menu('ChorusType','CHORUS TYPE')}
        <div className="jpKnobs">{dial('DelayTime','TIME')}{dial('DelayFeedback','FEEDBACK')}{dial('DelayLevel','DELAY')}</div>
        {menu('DelayType','DELAY TYPE')}
      </Section>
    </div>}
    {view==='perform'&&<div className="jpPerformanceGrid">
      <Section title="ARPEGGIATOR / RPS" className="jpArpeggio">
        <div className="jpPerformanceTop"><div className="jpKnobs">{dial('Tempo','TEMPO')}<div className="jpToggleColumn">{toggle('ArpSwitch','ON / OFF')}{toggle('ArpHold','HOLD')}</div></div>{menu('MidiSync','CLOCK SOURCE')}</div>
        {menu('ArpMode','MODE')}{menu('ArpRange','OCTAVE RANGE')}{menu('ArpBeatPattern','BEAT PATTERN')}{menu('ArpDestination','DESTINATION')}
      </Section>
      <Section title="KEYBOARD" className="jpKeyboardSettings">
        <div className="jpPerformanceTop"><div className="jpSwitchRow">{toggle('PortamentoSwitch','PORTAMENTO')}{toggle('MonoSwitch','MONO')}{toggle('LegatoSwitch','LEGATO')}</div>
        <div className="jpKnobs">{dial('PortamentoTime','PORTA TIME')}{dial('PartDetune','PART DETUNE')}</div></div>
        <div className="jpMenuPair">{menu('OscillatorShift','OSC SHIFT')}{menu('PartTranspose','TRANSPOSE')}</div>
        <div className="jpMenuPair">{menu('BendRangeUp','BEND UP')}{menu('BendRangeDown','BEND DOWN')}</div>
        {menu('voiceAssignKeyboard','VOICE ALLOCATION')}{menu('SplitPoint','SPLIT POINT')}
      </Section>
      <Section title="LFO 2 / MODULATION" className="jpLfoTwo">
        <div className="jpPerformanceTop"><div className="jpKnobs">{dial('Lfo2Rate','RATE')}{dial('PitchLfo2Depth','PITCH DEPTH')}</div>
        <div className="jpKnobs">{dial('FilterLfo2Depth','FILTER DEPTH')}{dial('AmpLfo2Depth','AMP DEPTH')}</div></div>
        {menu('Lfo2DepthSelect','DEPTH SELECT')}{menu('ChorusSyncRate','CHORUS SYNC')}{menu('DelaySync','DELAY SYNC')}
      </Section>
      <Section title="MIDI / OUTPUT" className="jpMidi">
        <div className="jpPerformanceTop">{menu('MidiChannel','PART MIDI CHANNEL')}{menu('RemoteControlChannel','REMOTE CONTROL CHANNEL')}
        </div>{menu('OutputAssign','OUTPUT ASSIGN')}{dial('MasterTune','MASTER TUNE')}
      </Section>
    </div>}
    {view==='assign'&&<JP8000Assignments source={assignment} onSourceChange={setAssignment}
      parameters={assignmentParams} values={values} oscLabels={osc} part={part}
      enableControl={assignment==='velocity'?toggle('VelocitySwitch','VELOCITY'):toggle('MorphBendAssign','MORPH BEND')}
      velocityEnabled={value('VelocitySwitch')!==0} onParameter={(id,next)=>{if(ready)onParameter(id,next);}}/>}
    {view==='panel'&&<div className="jpHardwarePanel">
      <Section title="DISPLAY / PATCH SELECTION">
        <div className="jpPanelNavigation">
          {[[67,'SHIFT / EXIT'],[72,'PERFORM / PATCH']].map(([id,label])=><button key={id} onClick={()=>action('panel',Number(id))}>{label}</button>)}
        </div>
        <div className="jpPanelEditRow"><div className="jpSegments" role="group" aria-label="Display value">
          {[[88,'VALUE −'],[80,'VALUE +']].map(([id,label])=><button key={id} onClick={()=>action('panel',Number(id))}>{label}</button>)}
        </div><button className="jpStoreButton" onClick={()=>action('panel',75)}>WRITE</button></div>
        <div className="jpNumberButtons">{[89,81,73,90,82,74,91,83].map((id,i)=><button key={id} aria-label={`Panel selection ${i+1}`} onClick={()=>action('panel',id)}>{i+1}</button>)}</div>
      </Section>
      <Section title="MOTION CONTROL"><div className="jpPanelNavigation">
        {[[138,'MOTION 1'],[137,'MOTION 2']].map(([id,label])=><button key={id} onClick={()=>action('panel',Number(id))}>{label}</button>)}
      </div><div className="jpPanelEditRow jpMotionActions">
        <button onClick={()=>action('panel',131)}>ARP HOLD</button><button className="jpStoreButton" onClick={()=>action('panel',130)}>RECORD</button>
      </div></Section>
      <Section title="INDIVIDUAL TRIGGER"><div className="jpTriggerSettings">{toggle('IndividualTriggerSwitch','ON / OFF')}
        {menu('IndividualTriggerDestination','DESTINATION')}{menu('IndividualTriggerSourceChannel','SOURCE CHANNEL')}{menu('IndividualTriggerSourceNote','SOURCE NOTE')}</div></Section>
    </div>}
    </div></fieldset>
  </div>;
}
