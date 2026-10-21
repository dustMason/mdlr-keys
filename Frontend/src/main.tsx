import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../upstream/src/styles.css';
import {fiveDefinition} from '../upstream/src/modules/five/FiveModule';
import {fm4Definition} from '../upstream/src/modules/fm4/Fm4Module';
import {oneDefinition} from './OnePanel';
import {sixDefinition} from './SixPanel';
import {jp8000Definition, JP8000Panel, type JP8000State, type JPAction} from './JP8000Panel';
import {monologueDefinition} from './MonologuePanel';
import type {ModuleRenderProps} from '../upstream/src/modules/types';
import './panel.css';
import './six-layout.css';
import './panel-fit.css';
import './controls-polish.css';

const definitions=[fiveDefinition,fm4Definition,oneDefinition,sixDefinition,jp8000Definition,monologueDefinition];
type State={engine:number;params:Record<number,number>;zoom?:number;jp?:JP8000State};
type Message={type:'ready'}|{type:'parameter';engine:number;id:number;value:number}|JPAction;
declare global { interface Window {
  webkit?:{messageHandlers?:{mdlr?:{postMessage:(message:Message)=>void}}};
  mdlrPanel?:{setState:(state:State)=>void};
}}
const native=!!window.webkit?.messageHandlers?.mdlr;
function send(message:Message){window.webkit?.messageHandlers?.mdlr?.postMessage(message);}
const startingEngine=Math.max(0,Math.min(definitions.length-1,Math.floor(Number(new URLSearchParams(location.search).get('engine'))||0)));
const initial:State={engine:startingEngine,params:{},zoom:1};
let receive=(state:State)=>{Object.assign(initial,state);};
window.mdlrPanel={setState:state=>receive(state)};

function App(){
  const [state,setState]=useState<State>(initial);
  const [feedback,setFeedback]=useState<{label:string;value:string;fraction?:number;x?:number}|null>(null);
  useEffect(()=>setFeedback(null),[state.engine]);
  useEffect(()=>{
    const changed=(event:Event)=>setFeedback((event as CustomEvent).detail);
    window.addEventListener('mdlr-knob-feedback',changed);
    return()=>window.removeEventListener('mdlr-knob-feedback',changed);
  },[]);
  const scrollRef=useRef<HTMLDivElement>(null);
  const [size,setSize]=useState({width:window.innerWidth,height:window.innerHeight});
  useEffect(()=>{
    receive=incoming=>{if(Number.isInteger(incoming.engine)&&incoming.engine>=0&&incoming.engine<definitions.length){setState(incoming);}};
    const resize=()=>{const el=scrollRef.current;if(el)setSize({width:el.clientWidth,height:el.clientHeight});};
    const observer=new ResizeObserver(resize);if(scrollRef.current)observer.observe(scrollRef.current);
    resize();send({type:'ready'});
    return()=>observer.disconnect();
  },[]);
  const definition=definitions[state.engine];
  const Component=definition.Component;
  const canvasWidth=state.engine>=4?size.width:Math.max(state.engine===2?720:780,size.width);
  const compact=canvasWidth<(state.engine>=4?900:state.engine===2?1000:940);
  const scale=state.engine>=4?Math.max(1,state.zoom??1):size.width/canvasWidth*(state.zoom??1);
  // Original panels and the JP panel fit the inset iPad panel (1056×746 / 786×1016) at 100%; only smaller windows
  // (or an intentionally enlarged panel) need scrolling. Do not scale touch targets down.
  const minimumHeight=(compact?[980,960,980,900,980,1012]:[740,720,740,700,730,730])[state.engine];
  const panelHeight=Math.max(minimumHeight,(size.height-4)/scale);
  const update=(moduleId:number,id:number,value:number)=>{
    const p=definition.params.find(x=>x.id===id);if(!p||!Number.isFinite(value))return;
    const clamped=Math.max(p.min,Math.min(p.max,value));
    setState(current=>({...current,params:{...current.params,[id]:clamped},
      ...(current.engine===4&&current.jp?{jp:{...current.jp,params:{...current.jp.params,[id]:clamped}}}:{})}));
    send({type:'parameter',engine:state.engine,id,value:clamped});
  };
  // The four original source components only use the module, definition and parameter callback.
  // The adapted rack shell excludes cable routing, collaboration and backend operations.
  const props={module:{id:1,kind:definition.kind,x:0,y:0,params:state.params},definition,onParamChange:update,connectionView:false} as ModuleRenderProps;
  return <main className={native?'nativeHost':'browserPreview'}>
    {!native&&<div className="previewToolbar"><span>Original mdlr panels · visual preview</span><nav aria-label="Engine preview">{definitions.map((d,i)=><button key={d.kind} aria-pressed={i===state.engine} onClick={()=>setState({engine:i,params:{}})}>{d.name}</button>)}</nav><small>Audio runs in the native app.</small></div>}
    <div className="panelScroll" ref={scrollRef}><div className="panelBounds" style={{width:canvasWidth*scale,height:panelHeight*scale}}>
      <div className={`panelCanvas ${compact?"compact":"wide"}`} style={{width:canvasWidth,height:panelHeight,transform:`scale(${scale})`}}>{state.engine===4?<JP8000Panel native={native} state={state.jp} params={state.params} onParameter={(id,value)=>update(1,id,value)} onAction={send}/>:<Component {...props}/>}</div>
    </div></div>
    {feedback&&<output className={`touchReadout ${(feedback.x??0)<window.innerWidth/2?'readoutRight':'readoutLeft'}`}>
      <span className="readoutLabel">{feedback.label}</span><strong>{feedback.value}</strong>
      <span className="readoutMeter" aria-hidden="true"><span style={{width:`${Math.round((feedback.fraction??0)*1000)/10}%`}}/></span>
    </output>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
