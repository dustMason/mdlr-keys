import type { ReactNode } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import { KnobList, ProductionSection } from "../panelSections";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "../productionPanel.css";
import "./R8Module.css";

const PARAM_BD_LEVEL = 0;
const PARAM_BD_TONE = 1;
const PARAM_BD_DECAY = 2;
const PARAM_SD_LEVEL = 3;
const PARAM_SD_TONE = 4;
const PARAM_SD_SNAPPY = 5;
const PARAM_LT_LEVEL = 6;
const PARAM_LT_TUNE = 7;
const PARAM_MT_LEVEL = 8;
const PARAM_MT_TUNE = 9;
const PARAM_HT_LEVEL = 10;
const PARAM_HT_TUNE = 11;
const PARAM_RIM_LEVEL = 12;
const PARAM_CLAP_LEVEL = 13;
const PARAM_COWBELL_LEVEL = 14;
const PARAM_CY_LEVEL = 15;
const PARAM_CY_TONE = 16;
const PARAM_CY_DECAY = 17;
const PARAM_OH_LEVEL = 18;
const PARAM_OH_DECAY = 19;
const PARAM_CH_LEVEL = 20;
const PARAM_ACCENT = 21;
const PARAM_MASTER = 22;
const PARAM_LT_MODE = 23;
const PARAM_MT_MODE = 24;
const PARAM_HT_MODE = 25;
const PARAM_RIM_MODE = 26;
const PARAM_CLAP_MODE = 27;

export const r8Definition: ModuleDefinition = {
  kind: MODULE_KINDS.r8,
  slug: "r8",
  name: "R8",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 2,
  width: 782,
  minHeight: 432,
  inputs: [
    { id: 0, label: "bd", kind: "gate" },
    { id: 1, label: "sd", kind: "gate" },
    { id: 2, label: "lt/lc", kind: "gate" },
    { id: 3, label: "mt/mc", kind: "gate" },
    { id: 4, label: "ht/hc", kind: "gate" },
    { id: 5, label: "rs/cl", kind: "gate" },
    { id: 6, label: "cp/ma", kind: "gate" },
    { id: 7, label: "cb", kind: "gate" },
    { id: 8, label: "cy", kind: "gate" },
    { id: 9, label: "oh", kind: "gate" },
    { id: 10, label: "ch", kind: "gate" },
    { id: 11, label: "accent", kind: "cv" },
    { id: 12, label: "choke", kind: "gate" },
  ],
  outputs: [
    { id: 0, label: "mix", kind: "audio" },
    { id: 1, label: "bd", kind: "audio" },
    { id: 2, label: "sd", kind: "audio" },
    { id: 3, label: "lt/lc", kind: "audio" },
    { id: 4, label: "mt/mc", kind: "audio" },
    { id: 5, label: "ht/hc", kind: "audio" },
    { id: 6, label: "rs/cl", kind: "audio" },
    { id: 7, label: "cp/ma", kind: "audio" },
    { id: 8, label: "cb", kind: "audio" },
    { id: 9, label: "cy", kind: "audio" },
    { id: 10, label: "oh", kind: "audio" },
    { id: 11, label: "ch", kind: "audio" },
    { id: 12, label: "trig", kind: "gate" },
    { id: 13, label: "accent", kind: "cv" },
  ],
  params: [
    knob(PARAM_BD_LEVEL, "bd_level", "level", 0, 1.2, 0.9),
    knob(PARAM_BD_TONE, "bd_tone", "tone", 0, 1, 0.46),
    knob(PARAM_BD_DECAY, "bd_decay", "decay", 0, 1, 0.72),
    knob(PARAM_SD_LEVEL, "sd_level", "level", 0, 1.2, 0.66),
    knob(PARAM_SD_TONE, "sd_tone", "tone", 0, 1, 0.56),
    knob(PARAM_SD_SNAPPY, "sd_snappy", "snap", 0, 1, 0.68),
    knob(PARAM_LT_LEVEL, "lt_level", "level", 0, 1.2, 0.46),
    knob(PARAM_LT_TUNE, "lt_tune", "tune", 0, 1, 0.42),
    knob(PARAM_MT_LEVEL, "mt_level", "level", 0, 1.2, 0.42),
    knob(PARAM_MT_TUNE, "mt_tune", "tune", 0, 1, 0.5),
    knob(PARAM_HT_LEVEL, "ht_level", "level", 0, 1.2, 0.38),
    knob(PARAM_HT_TUNE, "ht_tune", "tune", 0, 1, 0.58),
    knob(PARAM_RIM_LEVEL, "rim_level", "level", 0, 1.2, 0.4),
    knob(PARAM_CLAP_LEVEL, "clap_level", "level", 0, 1.2, 0.48),
    knob(PARAM_COWBELL_LEVEL, "cowbell_level", "level", 0, 1.2, 0.42),
    knob(PARAM_CY_LEVEL, "cy_level", "level", 0, 1.2, 0.36),
    knob(PARAM_CY_TONE, "cy_tone", "tone", 0, 1, 0.62),
    knob(PARAM_CY_DECAY, "cy_decay", "decay", 0, 1, 0.62),
    knob(PARAM_OH_LEVEL, "oh_level", "level", 0, 1.2, 0.42),
    knob(PARAM_OH_DECAY, "oh_decay", "decay", 0, 1, 0.58),
    knob(PARAM_CH_LEVEL, "ch_level", "level", 0, 1.2, 0.42),
    knob(PARAM_ACCENT, "accent", "accent", 0, 1, 0.72),
    knob(PARAM_MASTER, "master", "master", 0, 1, 0.68),
    switchParam(PARAM_LT_MODE, "lt_mode", "low type", 0),
    switchParam(PARAM_MT_MODE, "mt_mode", "mid type", 0),
    switchParam(PARAM_HT_MODE, "ht_mode", "high type", 0),
    switchParam(PARAM_RIM_MODE, "rim_mode", "rim type", 0),
    switchParam(PARAM_CLAP_MODE, "clap_mode", "clap type", 0),
  ],
  Component: R8Module,
};

function R8Module(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="r8Panel">
        <div className="r8VoiceGrid drumVoiceGrid">
          <VoiceColumn props={props} title="bd" paramIds={[PARAM_BD_LEVEL, PARAM_BD_TONE, PARAM_BD_DECAY]} />
          <VoiceColumn props={props} title="sd" paramIds={[PARAM_SD_LEVEL, PARAM_SD_TONE, PARAM_SD_SNAPPY]} />
          <VoiceColumn
            props={props}
            title="low"
            paramIds={[PARAM_LT_LEVEL, PARAM_LT_TUNE]}
            accessory={
              <SegmentControl
                options={[
                  ["tom", 0],
                  ["conga", 1],
                ]}
                paramId={PARAM_LT_MODE}
                module={module}
                definition={definition}
                onParamChange={onParamChange}
              />
            }
          />
          <VoiceColumn
            props={props}
            title="mid"
            paramIds={[PARAM_MT_LEVEL, PARAM_MT_TUNE]}
            accessory={
              <SegmentControl
                options={[
                  ["tom", 0],
                  ["conga", 1],
                ]}
                paramId={PARAM_MT_MODE}
                module={module}
                definition={definition}
                onParamChange={onParamChange}
              />
            }
          />
          <VoiceColumn
            props={props}
            title="high"
            paramIds={[PARAM_HT_LEVEL, PARAM_HT_TUNE]}
            accessory={
              <SegmentControl
                options={[
                  ["tom", 0],
                  ["conga", 1],
                ]}
                paramId={PARAM_HT_MODE}
                module={module}
                definition={definition}
                onParamChange={onParamChange}
              />
            }
          />
          <VoiceColumn
            props={props}
            title="rim"
            paramIds={[PARAM_RIM_LEVEL]}
            accessory={
              <SegmentControl
                options={[
                  ["rim", 0],
                  ["clave", 1],
                ]}
                paramId={PARAM_RIM_MODE}
                module={module}
                definition={definition}
                onParamChange={onParamChange}
              />
            }
          />
          <VoiceColumn
            props={props}
            title="clap"
            paramIds={[PARAM_CLAP_LEVEL]}
            accessory={
              <SegmentControl
                options={[
                  ["clap", 0],
                  ["mara", 1],
                ]}
                paramId={PARAM_CLAP_MODE}
                module={module}
                definition={definition}
                onParamChange={onParamChange}
              />
            }
          />
          <VoiceColumn props={props} title="cb" paramIds={[PARAM_COWBELL_LEVEL]} />
          <VoiceColumn props={props} title="cy" paramIds={[PARAM_CY_LEVEL, PARAM_CY_TONE, PARAM_CY_DECAY]} />
          <VoiceColumn props={props} title="oh" paramIds={[PARAM_OH_LEVEL, PARAM_OH_DECAY]} />
          <VoiceColumn props={props} title="ch" paramIds={[PARAM_CH_LEVEL]} />
          <VoiceColumn props={props} title="mix" paramIds={[PARAM_ACCENT, PARAM_MASTER]} />
        </div>
      </div>
    </ModuleShell>
  );
}

function VoiceColumn({
  props,
  title,
  paramIds,
  accessory,
}: {
  props: ModuleRenderProps;
  title: string;
  paramIds: number[];
  accessory?: ReactNode;
}) {
  const { module, definition, onParamChange } = props;
  return (
    <ProductionSection title={title}>
      {accessory ? <div className="productionSectionAccessory">{accessory}</div> : null}
      <KnobList
        module={module}
        definition={definition}
        onParamChange={onParamChange}
        paramIds={paramIds}
      />
    </ProductionSection>
  );
}

function SegmentControl({
  options,
  paramId,
  module,
  definition,
  onParamChange,
}: {
  options: Array<[string, number]>;
  paramId: number;
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
}) {
  const parameter = param(paramId, definition);
  const value = Math.round(valueFor(module.params, parameter));

  return (
    <div className="r8Segment">
      <div>
        {options.map(([name, optionValue]) => (
          <button
            key={name}
            type="button"
            className={value === optionValue ? "isActive" : ""}
            onClick={() => onParamChange(module.id, paramId, optionValue)}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function knob(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
): ParamDefinition {
  return {
    id,
    key,
    label,
    min,
    max,
    step: 0.01,
    defaultValue,
  };
}

function switchParam(
  id: number,
  key: string,
  label: string,
  defaultValue: number,
): ParamDefinition {
  return {
    id,
    key,
    label,
    min: 0,
    max: 1,
    step: 1,
    defaultValue,
  };
}

function param(paramId: number, definition: ModuleDefinition): ParamDefinition {
  const found = definition.params.find((candidate) => candidate.id === paramId);
  if (!found) {
    throw new Error(`Missing R8 param ${paramId}`);
  }
  return found;
}

function valueFor(params: Record<number, number>, parameter: ParamDefinition) {
  return params[parameter.id] ?? parameter.defaultValue;
}
