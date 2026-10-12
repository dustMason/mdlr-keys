import type { ComponentType, MouseEvent, PointerEvent, ReactNode } from "react";
import type {
  ModularAudioEngine,
  MixerMeterSnapshot,
  ScopeSnapshot,
} from "../audio/ModularAudioEngine";

export type SignalKind = "audio" | "cv" | "gate";
export type JackDirection = "input" | "output";

export interface JackDefinition {
  id: number;
  label: string;
  kind: SignalKind;
  connectionOrder?: number;
  connectionGroup?: string;
  connectionGroupLabel?: string;
  connectionGroupOrder?: number;
  connectionLabel?: string;
}

export interface ParamDefinition {
  id: number;
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit?: string;
  scale?: "linear" | "exponential";
}

export interface KnobRenderProps {
  param: ParamDefinition;
  value: number;
  accent: string;
  className?: string;
  onChange: (value: number) => void;
}

export interface RackModuleState {
  id: number;
  kind: number;
  x: number;
  y: number;
  fixed?: boolean;
  collapsed?: boolean;
  label?: string;
  ownerUserId?: string;
  ownerUsername?: string;
  sample?: ModuleSampleState;
  text?: ModuleTextState;
  params: Record<number, number>;
}

export type ModuleSampleState =
  | SamplerSampleState
  | Op1DrumSampleState
  | LoopSampleState;
export type ModuleTextState = ChoirTextState | LoopTextState;

export interface ChoirTextState {
  version: 1;
  kind: "choir";
  phrases: string[];
}

export interface LoopTextState {
  version: 1;
  kind: "loop";
  slotLabels: string[];
}

export interface SamplerSampleState {
  version: 1;
  kind: "sampler";
  assetId: string;
  sourceType: "factory" | "op1.fun" | "upload";
  sourceUrl: string;
  apiUrl: string;
  fileUrl: string;
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
  slices: ModuleSampleSlice[];
  objectKey?: string;
  bankId?: string;
  padLabels?: string[];
  license?: string;
  chopMode?: string;
}

export interface Op1DrumSampleState {
  version: 1;
  kind: "op1-drum";
  assetId: string;
  sourceUrl: string;
  apiUrl: string;
  fileUrl: string;
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
  slices: ModuleSampleSlice[];
}

export interface LoopSampleState {
  version: 1;
  kind: "loop";
  assetId: string;
  loops: LoopSlotState[];
}

export interface LoopSlotState {
  slot: number;
  clip: number;
  objectKey: string;
  name: string;
  sampleRate: number;
  channels: 2;
  frames: number;
  mode: "free" | "bars";
  bars: number;
  reverse: boolean;
  stretch: 0.5 | 1 | 2;
  createdAt: string;
}

export interface ModuleSampleSlice {
  index: number;
  startFrame: number;
  endFrame: number;
  output?: number;
}

export interface CableEndpoint {
  moduleId: number;
  jackId: number;
  direction: JackDirection;
  kind: SignalKind;
}

export interface PatchCable {
  id: string;
  from: CableEndpoint;
  to: CableEndpoint;
}

export interface ModuleRenderProps {
  module: RackModuleState;
  definition: ModuleDefinition;
  connectionView: boolean;
  rackModules?: readonly RackModuleState[];
  patchCables?: readonly PatchCable[];
  definitionsByKind?: ReadonlyMap<number, ModuleDefinition>;
  scopeData?: ScopeSnapshot;
  mixerMeterData?: MixerMeterSnapshot;
  moduleLevel?: number;
  modulePresetOptions?: ModulePresetOption[];
  locked?: boolean;
  lockedReason?: string;
  insertTarget?: boolean;
  dragging?: boolean;
  audioEngine: ModularAudioEngine;
  onParamChange: (moduleId: number, paramId: number, value: number) => void;
  onModuleParamsChange: (
    moduleId: number,
    values: Record<number, number>,
  ) => void;
  onRuntimeParamChange: (
    moduleId: number,
    paramId: number,
    value: number,
  ) => void;
  onModuleSampleChange: (
    moduleId: number,
    sample: ModuleSampleState | undefined,
    runtimeAsset?: ModuleRuntimeSampleAsset,
  ) => void;
  onModuleTextChange: (
    moduleId: number,
    text: ModuleTextState | undefined,
  ) => void;
  onModulePresetSelect: (moduleId: number, presetId: string) => void;
  onModulePresetSave: (moduleId: number) => void;
  onLoopExport: (moduleId: number, slot: number) => Promise<LoopExport>;
  tempoBpm: number;
  onStartCable: (endpoint: CableEndpoint, event: PointerEvent) => void;
  onFinishCable: (endpoint: CableEndpoint, event: PointerEvent) => void;
  onOpenJackMenu: (endpoint: CableEndpoint, event: MouseEvent) => void;
  onBeginModuleDrag: (moduleId: number, event: PointerEvent) => void;
  onModuleCollapseToggle: (moduleId: number) => void;
  onModuleLabelChange: (moduleId: number, label: string) => void;
  onDeleteModule: (moduleId: number) => void;
  children?: ReactNode;
}

export interface ModuleDefinition {
  kind: number;
  slug: string;
  name: string;
  accent: string;
  presets?: ModulePresetDefinition[];
  rackWidth: "full" | "half";
  rackUnits: 1 | 2 | 3 | 4;
  width?: number;
  minHeight?: number;
  bypassParamId?: number;
  knobComponent?: ComponentType<KnobRenderProps>;
  connectionViewChrome?: "default" | "minimal";
  sparseParams?: boolean;
  inputs: JackDefinition[];
  outputs: JackDefinition[];
  params: ParamDefinition[];
  Component: ComponentType<ModuleRenderProps>;
}

export interface ModulePresetPayload {
  version: 1;
  moduleKind: number;
  moduleSlug: string;
  params: Record<string, number>;
}

export interface ModulePresetDefinition {
  id: string;
  name: string;
  payload: ModulePresetPayload;
}

export interface ModulePresetOption extends ModulePresetDefinition {
  source: "user" | "factory";
}

export type ModuleRuntimeSampleAsset =
  | SamplerRuntimeSampleAsset
  | LoopRuntimeSampleAsset;

export interface SamplerRuntimeSampleAsset {
  kind?: "sampler" | "op1-drum";
  assetId: string;
  sampleRate: number;
  frames: number;
  samples: Float32Array;
  slices: ModuleSampleSlice[];
}

export interface LoopRuntimeSampleAsset {
  kind: "loop";
  assetId: string;
  loops: LoopRuntimeSlot[];
}

export interface LoopRuntimeSlot {
  slot: number;
  clip: number;
  objectKey: string;
  bars: number;
  sampleRate: number;
  frames: number;
  left: Float32Array;
  right: Float32Array;
}

export interface LoopExport {
  moduleId: number;
  slot: number;
  bars: number;
  sampleRate: number;
  frames: number;
  left: Float32Array;
  right: Float32Array;
}
