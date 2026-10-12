import type { CSSProperties } from "react";
import { ModuleKnob, useKnobControl } from "../../components/Knob";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type {
  KnobRenderProps,
  ModuleDefinition,
  ModuleRenderProps,
} from "../types";
import "./assets/theme.css";
import "./OutputModule.css";
import knobImage from "./knob.webp";

export const outputDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.output,
  slug: "output",
  name: "OUT",
  accent: "#111827",
  rackWidth: "half",
  rackUnits: 1,
  minHeight: 218,
  knobComponent: OutputKnob,
  inputs: [
    { id: 0, label: "left", kind: "audio" },
    { id: 1, label: "right", kind: "audio" },
  ],
  outputs: [],
  params: [
    {
      id: 0,
      key: "volume",
      label: "vol",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.75,
    },
  ],
  Component: OutputModule,
};

function OutputModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const meterLevels = props.mixerMeterData?.levels;
  return (
    <ModuleShell {...props}>
      <div className="outputPanel">
        <div className="moduleDisplay outputDisplay">
          <VuMeter label="L" level={meterValue(meterLevels, 0)} />
          <VuMeter label="R" level={meterValue(meterLevels, 1)} />
        </div>
        <div className="knobGrid knobGridSingle outputKnobs">
          {definition.params.map((param) => (
            <ModuleKnob
              key={param.id}
              definition={definition}
              param={param}
              value={module.params[param.id] ?? param.defaultValue}
              onChange={(value) => onParamChange(module.id, param.id, value)}
            />
          ))}
        </div>
      </div>
    </ModuleShell>
  );
}

function OutputKnob({
  param,
  value,
  className,
  onChange,
}: KnobRenderProps) {
  const control = useKnobControl({ param, value, onChange });
  return (
    <label
      className={["knob outputImageKnob", className].filter(Boolean).join(" ")}
      htmlFor={control.inputId}
      onClick={control.handleClick}
    >
      <span className="knobLabel">{param.label}</span>
      <span
        {...control.faceProps}
        className="knobFace outputImageKnobFace"
        style={{
          ...control.faceStyle,
          backgroundImage: `url(${knobImage})`,
        } as CSSProperties}
      >
        <span className="outputImageKnobIndicator" />
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

function VuMeter({ label, level }: { label: string; level: number }) {
  const clamped = Math.min(1, Math.max(0, level));
  return (
    <div
      className="outputVu"
      style={{ "--vu-deg": `${-42 + clamped * 84}deg` } as CSSProperties}
    >
      <i className="outputVuNeedle" />
      <strong>{label}</strong>
    </div>
  );
}

function meterValue(levels: Float32Array | undefined, index: number) {
  return Math.min(1, Math.max(0, levels?.[index] ?? 0));
}
