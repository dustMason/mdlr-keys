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
} from "../modules/types";

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

export function useKnobControl({
  param,
  value,
  onChange,
}: Pick<KnobRenderProps, "param" | "value" | "onChange">) {
  const inputId = useId();
  const faceRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suppressClickRef = useRef(false);
  const displayValue = clampParamValue(value, param);
  const normalized = normalizeParamValue(displayValue, param);
  const degrees = -132 + normalized * 264;
  const display = formatValue(displayValue, param);

  function updateFromPointer(clientX: number) {
    const face = faceRef.current;
    if (!face) {
      return;
    }

    const bounds = face.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }

    const nextNormalized = clamp01((clientX - bounds.left) / bounds.width);
    const nextValue = snapValue(valueFromNormalized(nextNormalized, param), param);

    if (nextValue !== value) {
      onChange(nextValue);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLSpanElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    suppressClickRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    inputRef.current?.focus({ preventScroll: true });
    updateFromPointer(event.clientX);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLSpanElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }

    event.preventDefault();
    updateFromPointer(event.clientX);
  }

  function releasePointer(event: ReactPointerEvent<HTMLSpanElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
      onPointerCancel: releasePointer,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: releasePointer,
    },
    inputProps: {
      ref: inputRef,
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
  const decimals = param.step < 0.01 ? 2 : param.step < 1 ? 1 : 0;
  return `${value.toFixed(decimals)}${param.unit ?? ""}`;
}
