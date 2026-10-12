import { useId, useRef } from "react";
import type {
  ChangeEvent as ReactChangeEvent,
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type {
  KnobRenderProps,
  ModuleDefinition,
  ParamDefinition,
} from "../upstream/src/modules/types";

interface ModuleKnobProps extends Omit<KnobRenderProps, "accent"> {
  definition: Pick<ModuleDefinition, "accent" | "knobComponent">;
  accent?: string;
}

export function ModuleKnob({
  definition,
  accent,
  ...props
}: ModuleKnobProps) {
  const KnobComponent = definition.knobComponent ?? Knob;
  return (
    <KnobComponent
      {...props}
      accent={accent ?? definition.accent}
    />
  );
}

export function Knob({
  param,
  value,
  accent,
  className,
  onChange,
}: KnobRenderProps) {
  const control = useKnobControl({ param, value, onChange });

  return (
    <label
      className={["knob", className].filter(Boolean).join(" ")}
      htmlFor={control.inputId}
      onClick={control.handleClick}
    >
      <span className="knobLabel">{param.label}</span>
      <span
        {...control.faceProps}
        className="knobFace"
        style={{
          ...control.faceStyle,
          "--knob-accent": accent,
        } as CSSProperties}
      >
        <span className="knobNeedle" />
      </span>
      <span className="knobValue">{control.display}</span>
      <input
        {...control.inputProps}
        aria-label={param.label}
        className="knobInput"
      />
    </label>
  );
}

let readoutOwner: string | null = null;

export function useKnobControl({
  param,
  value,
  onChange,
}: Pick<KnobRenderProps, "param" | "value" | "onChange">) {
  const inputId = useId();
  const faceRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suppressClickRef = useRef(false);
  const gesture = useRef<{pointer:number;y:number;normalized:number;started:boolean}|null>(null);
  const lastTap = useRef(0);
  function feedback(value:number|null) {
    // With several fingers down, only the control that last reported may clear the readout.
    if(value===null){if(readoutOwner!==inputId)return;readoutOwner=null;}
    else readoutOwner=inputId;
    const rect=faceRef.current?.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent('mdlr-knob-feedback',{detail:value===null?null:{
      label:param.label,value:formatValue(value,param),
      fraction:normalizeParamValue(value,param),
      x:rect?rect.left+rect.width/2:window.innerWidth/2,
    }}));
  }
  function setActive(active:boolean) {
    faceRef.current?.toggleAttribute('data-active',active);
  }
  const displayValue = clampParamValue(value, param);
  const normalized = normalizeParamValue(displayValue, param);
  const degrees = -132 + normalized * 264;
  const display = formatValue(displayValue, param);

  // Relative vertical travel is measured in screen pixels, independent of panel zoom.
  // Pointer-down only grabs the current value; it never changes the sound.
  function handlePointerDown(event: ReactPointerEvent<HTMLSpanElement>) {
    if (event.button !== 0 || gesture.current) return;
    event.preventDefault();
    suppressClickRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({preventScroll:true});
    gesture.current={pointer:event.pointerId,y:event.clientY,normalized,started:false};
    setActive(true);
    feedback(displayValue);
  }
  function handlePointerMove(event: ReactPointerEvent<HTMLSpanElement>) {
    const drag=gesture.current;
    if(!drag || drag.pointer!==event.pointerId)return;
    event.preventDefault();
    const dy=drag.y-event.clientY;
    if(!drag.started && Math.abs(dy)<3)return;
    drag.started=true;
    drag.normalized=clamp01(drag.normalized+dy/(event.shiftKey?2200:220));
    drag.y=event.clientY;
    const next=snapValue(valueFromNormalized(drag.normalized,param),param);
    onChange(next);feedback(next);
  }
  function releasePointer(event: ReactPointerEvent<HTMLSpanElement>) {
    const drag=gesture.current;
    if(!drag || drag.pointer!==event.pointerId)return;
    gesture.current=null;setActive(false);feedback(null);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    // Double-tap (two taps without dragging) returns the control to its default value.
    if(event.type!=='pointerup' || drag.started){lastTap.current=0;return;}
    const now=event.timeStamp;
    if(now-lastTap.current<320){
      lastTap.current=0;
      const reset=clampParamValue(param.defaultValue,param);
      onChange(reset);
      setActive(true);feedback(reset);
      window.setTimeout(()=>{if(!gesture.current){setActive(false);feedback(null);}},650);
    } else lastTap.current=now;
  }
  function handleClick(event: ReactMouseEvent<HTMLLabelElement>) {
    if (!suppressClickRef.current) {
      return;
    }

    suppressClickRef.current = false;
    event.preventDefault();
  }

  return {
    inputId,
    displayValue,
    normalized,
    degrees,
    display,
    handleClick,
    faceStyle: {
      "--knob-deg": `${degrees}deg`,
      "--knob-sweep": `${normalized * 264}deg`,
    } as CSSProperties,
    faceProps: {
      ref: faceRef,
      role: "slider" as const,
      tabIndex: 0,
      "aria-label": param.label,
      "aria-valuemin": param.min,
      "aria-valuemax": param.max,
      "aria-valuenow": displayValue,
      "aria-valuetext": display,
      onKeyDown: (event: import('react').KeyboardEvent<HTMLSpanElement>) => {
        if(!['ArrowUp','ArrowRight','ArrowDown','ArrowLeft','Home','End'].includes(event.key))return;
        event.preventDefault();
        const direction=['ArrowUp','ArrowRight'].includes(event.key)?1:-1;
        let next=event.key==='Home'?param.min:event.key==='End'?param.max:snapValue(valueFromNormalized(clamp01(normalized+direction*(event.shiftKey?0.001:0.01)),param),param);
        if(next===displayValue && !['Home','End'].includes(event.key))next=snapValue(displayValue+direction*param.step,param);
        onChange(next);
      },
      onLostPointerCapture: releasePointer,
      onPointerCancel: releasePointer,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: releasePointer,
    },
    inputProps: {
      ref: inputRef,
      tabIndex: -1,
      "aria-hidden": true as const,
      id: inputId,
      type: "range",
      min: param.min,
      max: param.max,
      step: param.step,
      value: displayValue,
      onChange: (event: ReactChangeEvent<HTMLInputElement>) =>
        onChange(Number(event.target.value)),
    },
  };
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function clampParamValue(value: number, param: ParamDefinition) {
  if (!Number.isFinite(value)) {
    return param.defaultValue;
  }
  return Math.max(param.min, Math.min(param.max, value));
}

function normalizeParamValue(value: number, param: ParamDefinition) {
  const clamped = clampParamValue(value, param);
  if (
    param.scale === "exponential" &&
    param.min > 0 &&
    param.max > param.min
  ) {
    return clamp01(Math.log(clamped / param.min) / Math.log(param.max / param.min));
  }

  return clamp01((clamped - param.min) / (param.max - param.min));
}

function valueFromNormalized(normalized: number, param: ParamDefinition) {
  const clamped = clamp01(normalized);
  if (
    param.scale === "exponential" &&
    param.min > 0 &&
    param.max > param.min
  ) {
    return param.min * Math.pow(param.max / param.min, clamped);
  }

  return param.min + clamped * (param.max - param.min);
}

function snapValue(value: number, param: ParamDefinition) {
  const step = param.step > 0 ? param.step : 0.01;
  const snapped = Math.round((value - param.min) / step) * step + param.min;
  const clamped = Math.max(param.min, Math.min(param.max, snapped));
  const decimals = decimalPlaces(step);
  return Number(clamped.toFixed(Math.min(8, decimals + 2)));
}

function decimalPlaces(value: number) {
  const text = value.toString();
  if (!text.includes(".")) {
    return 0;
  }
  return text.split(".")[1]?.length ?? 0;
}

function formatValue(value: number, param: ParamDefinition) {
  const decimals = Math.min(4,decimalPlaces(param.step));
  return `${value.toFixed(decimals)}${param.unit ?? ""}`;
}
