import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type { ModuleDefinition, ModuleRenderProps } from "../types";
import "../productionPanel.css";
import "./Tr606Module.css";

const PARAM_KICK = 0;
const PARAM_SNARE = 1;
const PARAM_HATS = 2;
const PARAM_CYMBAL = 3;
const PARAM_TONE = 4;
const PARAM_DECAY = 5;
const PARAM_ACCENT = 6;
const PARAM_DRIVE = 7;
const PARAM_LEVEL = 8;
const PARAM_TOM = 9;

export const tr606Definition: ModuleDefinition = {
  kind: MODULE_KINDS.tr606,
  slug: "r6",
  name: "R6",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 438,
  minHeight: 272,
  inputs: [
    { id: 0, label: "bd", kind: "gate" },
    { id: 1, label: "sd", kind: "gate" },
    { id: 2, label: "lt", kind: "gate" },
    { id: 3, label: "hh", kind: "gate" },
    { id: 4, label: "oh", kind: "gate" },
    { id: 5, label: "cy", kind: "gate" },
    { id: 6, label: "accent", kind: "cv" },
    { id: 7, label: "choke", kind: "gate" },
  ],
  outputs: [
    { id: 0, label: "mix", kind: "audio" },
    { id: 1, label: "trig", kind: "gate" },
    { id: 2, label: "body", kind: "audio" },
    { id: 3, label: "metal", kind: "audio" },
  ],
  params: [
    {
      id: PARAM_KICK,
      key: "kick",
      label: "kick",
      min: 0,
      max: 1.2,
      step: 0.01,
      defaultValue: 0.9,
    },
    {
      id: PARAM_SNARE,
      key: "snare",
      label: "snare",
      min: 0,
      max: 1.2,
      step: 0.01,
      defaultValue: 0.72,
    },
    {
      id: PARAM_TOM,
      key: "tom",
      label: "l.h.tom",
      min: 0,
      max: 1.2,
      step: 0.01,
      defaultValue: 0.55,
    },
    {
      id: PARAM_HATS,
      key: "hats",
      label: "hats",
      min: 0,
      max: 1.2,
      step: 0.01,
      defaultValue: 0.58,
    },
    {
      id: PARAM_CYMBAL,
      key: "cymbal",
      label: "cym",
      min: 0,
      max: 1.2,
      step: 0.01,
      defaultValue: 0.42,
    },
    {
      id: PARAM_TONE,
      key: "tone",
      label: "tone",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.62,
    },
    {
      id: PARAM_DECAY,
      key: "decay",
      label: "decay",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.54,
    },
    {
      id: PARAM_ACCENT,
      key: "accent",
      label: "accent",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.74,
    },
    {
      id: PARAM_DRIVE,
      key: "drive",
      label: "drive",
      min: 0,
      max: 1.5,
      step: 0.01,
      defaultValue: 0.42,
    },
    {
      id: PARAM_LEVEL,
      key: "level",
      label: "level",
      min: 0,
      max: 1,
      step: 0.01,
      defaultValue: 0.62,
    },
  ],
  Component: Tr606Module,
};

function Tr606Module(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="tr606Panel">
        <KnobSections
          module={module}
          definition={definition}
          onParamChange={onParamChange}
          className="tr606Voices drumVoiceGrid"
          sections={[
            { title: "bd", paramIds: [PARAM_KICK] },
            { title: "sd", paramIds: [PARAM_SNARE] },
            { title: "l.h.tom", paramIds: [PARAM_TOM] },
            { title: "hh", paramIds: [PARAM_HATS, PARAM_DECAY] },
            { title: "cy", paramIds: [PARAM_CYMBAL, PARAM_TONE] },
            { title: "mix", paramIds: [PARAM_ACCENT, PARAM_DRIVE, PARAM_LEVEL] },
          ]}
        />
      </div>
    </ModuleShell>
  );
}
