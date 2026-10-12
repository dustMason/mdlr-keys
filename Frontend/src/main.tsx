import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../upstream/src/styles.css';
import {fiveDefinition} from '../upstream/src/modules/five/FiveModule';
import {fm4Definition} from '../upstream/src/modules/fm4/Fm4Module';
import {oneDefinition} from './OnePanel';
import {sixDefinition} from './SixPanel';
import type {ModuleRenderProps} from '../upstream/src/modules/types';
import './panel.css';
import './six-layout.css';
import './panel-fit.css';
import './controls-polish.css';

const definitions=[fiveDefinition,fm4Definition,oneDefinition,sixDefinition];
type State={engine:number;params:Record<number,number>;zoom?:number};
type Message={type:'ready'}|{type:'parameter';engine:number;id:number;value:number};
declare global { interface Window {
  webkit?:{messageHandlers?:{mdlr?:{postMessage:(message:Message)=>void}}};
  mdlrPanel?:{setState:(state:State)=>void};
}}
const native=!!window.webkit?.messageHandlers?.mdlr;
function send(message:Message){window.webkit?.messageHandlers?.mdlr?.postMessage(message);}
const startingEngine=Math.max(0,Math.min(3,Number(new URLSearchParams(location.search).get('engine'))||0));
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
    receive=incoming=>{if(Number.isInteger(incoming.engine)&&incoming.engine>=0&&incoming.engine<4){setState(incoming);}};
    const resize=()=>{const el=scrollRef.current;if(el)setSize({width:el.clientWidth,height:el.clientHeight});};
    const observer=new ResizeObserver(resize);if(scrollRef.current)observer.observe(scrollRef.current);
    resize();send({type:'ready'});
    return()=>observer.disconnect();
  },[]);
  const definition=definitions[state.engine];
  const Component=definition.Component;
  const canvasWidth=Math.max(state.engine===2?720:800,size.width);
  const compact=canvasWidth<(state.engine===2?1000:940);
  const scale=size.width/canvasWidth*(state.zoom??1);
  // All four panels fit horse's 1080×758 / 810×1028 panel at 100%; only smaller windows
  // (or an intentionally enlarged panel) need scrolling. Do not scale touch targets down.
  const minimumHeight=(compact?[980,960,980,900]:[740,720,752,700])[state.engine];
  const panelHeight=Math.max(minimumHeight,(size.height-4)/scale);
  const update=(moduleId:number,id:number,value:number)=>{
    const p=definition.params.find(x=>x.id===id);if(!p||!Number.isFinite(value))return;
    const clamped=Math.max(p.min,Math.min(p.max,value));
    setState(current=>({...current,params:{...current.params,[id]:clamped}}));
    send({type:'parameter',engine:state.engine,id,value:clamped});
  };
  // These four source components only use the module, definition and parameter callback.
  // The adapted rack shell excludes cable routing, collaboration and backend operations.
  const props={module:{id:1,kind:definition.kind,x:0,y:0,params:state.params},definition,onParamChange:update,connectionView:false} as ModuleRenderProps;
  return <main className={native?'nativeHost':'browserPreview'}>
    {!native&&<div className="previewToolbar"><span>Original mdlr panels · visual preview</span><nav aria-label="Engine preview">{definitions.map((d,i)=><button key={d.kind} aria-pressed={i===state.engine} onClick={()=>setState({engine:i,params:{}})}>{d.name}</button>)}</nav><small>Audio runs in the native app.</small></div>}
    <div className="panelScroll" ref={scrollRef}><div className="panelBounds" style={{width:canvasWidth*scale,height:panelHeight*scale}}>
      <div className={`panelCanvas ${compact?"compact":"wide"}`} style={{width:canvasWidth,height:panelHeight,transform:`scale(${scale})`}}><Component {...props}/></div>
    </div></div>
    {feedback&&<output className={`touchReadout ${(feedback.x??0)<window.innerWidth/2?'readoutRight':'readoutLeft'}`}>
      <span className="readoutLabel">{feedback.label}</span><strong>{feedback.value}</strong>
      <span className="readoutMeter" aria-hidden="true"><span style={{width:`${Math.round((feedback.fraction??0)*1000)/10}%`}}/></span>
    </output>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
