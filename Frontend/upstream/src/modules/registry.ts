import { ampDefinition } from "./amp/AmpModule";
import { audioInputDefinition } from "./audioInput/AudioInputModule";
import { bitcrusherDefinition } from "./bitcrusher/BitcrusherModule";
import { mutaDefinition } from "./muta/MutaModule";
import { chordDefinition } from "./chord/ChordModule";
import { chorusDefinition } from "./chorus/ChorusModule";
import { cloudDefinition } from "./cloud/CloudModule";
import { delayDefinition } from "./delay/DelayModule";
import { crispDefinition } from "./crisp/CrispModule";
import { cr78Definition } from "./cr78/Cr78Module";
import { curveDefinition } from "./curve/CurveModule";
import { droneDefinition } from "./drone/DroneModule";
import { dxDefinition } from "./dx/DxModule";
import { euclidDefinition } from "./euclid/EuclidModule";
import { farfisaDefinition } from "./farfisa/FarfisaModule";
import { fm4Definition } from "./fm4/Fm4Module";
import { sixDefinition } from "./six/SixModule";
import { lfoDefinition } from "./lfo/LfoModule";
import { loopDefinition } from "./loop/LoopModule";
import { choirDefinition } from "./choir/ChoirModule";
import { melodicSequencerDefinition } from "./melodicSequencer/MelodicSequencerModule";
import { hitsDefinition } from "./hits/HitsModule";
import { midiDefinition } from "./midi/MidiModule";
import { mixerDefinition } from "./mixer/MixerModule";
import { outputDefinition } from "./output/OutputModule";
import { parametricEqDefinition } from "./parametricEq/ParametricEqModule";
import { verbDefinition } from "./verb/VerbModule";
import { pluckDefinition } from "./pluck/PluckModule";
import { fiveDefinition } from "./five/FiveModule";
import { r8Definition } from "./r8/R8Module";
import { ringModDefinition } from "./ringMod/RingModModule";
import { rollDefinition } from "./roll/RollModule";
import { rhythmSequencerDefinition } from "./rhythmSequencer/RhythmSequencerModule";
import { scopeDefinition } from "./scope/ScopeModule";
import { samplerDefinition } from "./sampler/SamplerModule";
import { oneDefinition } from "./one/OneModule";
import { squeezerDefinition } from "./squeezer/SqueezerModule";
import { stepsDefinition } from "./steps/StepsModule";
import { stoneMistressDefinition } from "./stoneMistress/StoneMistressModule";
import { distDefinition } from "./dist/DistModule";
import { tr606Definition } from "./tr606/Tr606Module";
import type { ModuleDefinition, RackModuleState } from "./types";
import {
  compactSparseParamsForKind,
  sparseDefaultParamValue,
} from "./sparseParams";

export const moduleDefinitions = [
  stepsDefinition,
  melodicSequencerDefinition,
  mutaDefinition,
  euclidDefinition,
  rollDefinition,
  rhythmSequencerDefinition,
  curveDefinition,
  lfoDefinition,
  midiDefinition,
  audioInputDefinition,
  droneDefinition,
  dxDefinition,
  choirDefinition,
  chordDefinition,
  loopDefinition,
  oneDefinition,
  sixDefinition,
  fiveDefinition,
  pluckDefinition,
  fm4Definition,
  farfisaDefinition,
  tr606Definition,
  hitsDefinition,
  samplerDefinition,
  cr78Definition,
  r8Definition,
  ampDefinition,
  distDefinition,
  crispDefinition,
  ringModDefinition,
  bitcrusherDefinition,
  parametricEqDefinition,
  squeezerDefinition,
  stoneMistressDefinition,
  chorusDefinition,
  delayDefinition,
  verbDefinition,
  cloudDefinition,
  mixerDefinition,
  scopeDefinition,
  outputDefinition,
];

export const moduleDefinitionMap = new Map<number, ModuleDefinition>(
  moduleDefinitions.map((definition) => [definition.kind, definition]),
);

export function defaultParams(definition: ModuleDefinition) {
  return compactParamsForDefinition(
    definition,
    Object.fromEntries(
      definition.params.map((param) => [param.id, param.defaultValue]),
    ) as RackModuleState["params"],
  );
}

export function definitionForKind(kind: number) {
  const definition = moduleDefinitionMap.get(kind);
  if (!definition) {
    throw new Error(`Unknown module kind ${kind}`);
  }
  return definition;
}

export function compactParamsForKind(
  kind: number,
  params: RackModuleState["params"],
) {
  const definition = moduleDefinitionMap.get(kind);
  return definition ? compactParamsForDefinition(definition, params) : { ...params };
}
export { sparseDefaultParamValue };

function compactParamsForDefinition(
  definition: ModuleDefinition,
  params: RackModuleState["params"],
) {
  if (!definition.sparseParams) {
    return { ...params };
  }
  return compactSparseParamsForKind(definition.kind, params);
}
