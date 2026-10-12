import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import { KnobSections, ProductionSection } from "../panelSections";
import type {
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "./ChoirModule.css";

const PARAM_TUNE = 0;
const PARAM_PHRASE = 1;
const PARAM_DYNAMICS = 2;
const PARAM_BRIGHTNESS = 3;
const PARAM_VIBRATO = 4;
const PARAM_INTENSITY = 5;
const PARAM_CONSONANTS = 6;
const PARAM_TIME_SPREAD = 7;
const PARAM_EXCITER = 8;
const PARAM_STEREO_WIDTH = 9;
const PARAM_ATTACK_RATE = 10;
const PARAM_RELEASE_RATE = 11;
const PARAM_LEVEL = 12;
const PARAM_VOWEL_DELAY = 13;
const PARAM_ACCENT = 14;
const PARAM_ADVANCE = 15;
const PARAM_VOICE_PART = 16;
const PARAM_VOICE_COUNT = 17;
const PHRASE_PRESETS = [
  "A",
  "a e i o u",
  "la le li lo lu",
  "ma me mi mo mu",
  "na ne ni no nu",
  "da de di do du",
  "ta te ti to tu",
  "ka ke ki ko ku",
  "sa se si so su",
  "fa fe fi fo fu",
  "A E i O u",
  "mA nA lA tA sA",
  "ha he hi ho hu",
  "ra re ri ro ru",
  "za ze zi zo zu",
  "va ve vi vo vu",
  "wa we wi wo wu",
  "ja je ji jo ju",
  "ba da ga ba da",
  "pa ta ka pa ta",
  "la la la la",
  "lu lu lu lu",
  "lo lo lo lo",
  "li li li li",
  "ma ma ma ma",
  "na na na na",
  "da da da da",
  "ta ta ta ta",
  "ka ka ka ka",
  "sa sa sa sa",
  "hA hE hi hO hu",
  "lA lE li lO lu",
  "mA mE mi mO mu",
  "nA nE ni nO nu",
  "dA dE di dO du",
  "tA tE ti tO tu",
  "sA sE si sO su",
  "fA fE fi fO fu",
  "vA vE vi vO vu",
  "zA zE zi zO zu",
  "la mA na lA",
  "ta ka la ma",
  "ha la ha la",
  "da la da la",
  "sa la sa la",
  "fa la fa la",
  "va la va la",
  "ra la ra la",
  "a i a i",
  "o u o u",
  "A O A O",
  "E i E i",
  "u O u O",
  "{ @ { @",
  "2 3 2 3",
  "9 & 9 &",
  "m l n A",
  "n l m O",
  "mA lA nA rA",
  "lO rO wO hO",
  "ha hA ha hA",
  "ho hO ho hO",
  "he hE he hE",
  "hi i hi i",
  "hello",
  "hello you",
  "happy birthday to you",
  "we love the night",
  "blue star",
  "blue dream",
  "good night",
  "sing for me",
  "we are the dream",
  "you are the star",
  "love love love",
  "the blue night",
  "i love you",
  "we sing",
  "star of the night",
  "dream of blue",
  "la da ta ka",
  "la ta da ka",
  "ma na la ra",
  "ra na ma la",
  "ha wa ya la",
  "ya la wa ha",
  "ba ba da da",
  "ga ga da da",
  "pa pa ta ta",
  "ka ka ta ta",
  "sa sa fa fa",
  "va va za za",
  "lo lu la li",
  "mi mo mu ma",
  "ne no nu na",
  "te to tu ta",
  "a la a la",
  "e le e le",
  "i li i li",
  "o lo o lo",
  "u lu u lu",
  "A lA A lA",
  "E lE E lE",
  "O lO O lO",
  "U lU U lU",
  "V lV V lV",
  "ba la da la",
  "pa la ta la",
  "ga la ka la",
  "za la sa la",
  "va la fa la",
  "ha la wa la",
  "dEj tu ju",
  "hE loU",
  "blu stAr",
  "drim naIt",
  "h{ pi",
  "b3T dEj",
  "wi lVv",
  "D@ naIt",
  "sIN fOr mi",
  "mA nA tA sA",
  "rA wA jA hA",
  "S@ S@ S@",
  "tS@ dZ@ tS@",
  "T@ D@ T@",
  "f@ v@ z@",
  "h@ l@ r@",
] as const;
const PHRASE_SLOTS = PHRASE_PRESETS.length;

const params = [
  knob(PARAM_TUNE, "tune", "tune", -36, 36, 0, 1),
  knob(PARAM_PHRASE, "phrase", "phrase", 0, PHRASE_SLOTS - 1, 0, 1),
  knob(PARAM_VOICE_PART, "voice_part", "part", 0, 3, 0, 1),
  knob(PARAM_VOICE_COUNT, "voice_count", "voices", 1, 8, 8, 1),
  knob(PARAM_DYNAMICS, "dynamics", "dyn", 0, 1, 1, 0.01),
  knob(PARAM_BRIGHTNESS, "brightness", "bright", 0, 1, 1, 0.01),
  knob(PARAM_VIBRATO, "vibrato", "vib", 0, 1, 0.4, 0.01),
  knob(PARAM_INTENSITY, "intensity", "intense", 0, 1, 0.5, 0.01),
  knob(PARAM_CONSONANTS, "consonants", "cons", 0, 1, 0.5, 0.01),
  knob(PARAM_TIME_SPREAD, "time_spread", "time", 0, 100, 50, 1, "ms"),
  knob(PARAM_EXCITER, "exciter", "excite", 0, 1, 0.5, 0.01),
  knob(PARAM_STEREO_WIDTH, "stereo_width", "width", 0, 1, 0.7, 0.01),
  knob(PARAM_ATTACK_RATE, "attack_rate", "attack", 0, 1, 0.75, 0.01),
  knob(PARAM_RELEASE_RATE, "release_rate", "release", 0, 1, 0.5, 0.01),
  knob(PARAM_LEVEL, "level", "level", 0, 1, 0.8, 0.01),
  knob(PARAM_VOWEL_DELAY, "vowel_delay", "delay", 0, 250, 0, 1, "ms"),
  knob(PARAM_ACCENT, "accent", "accent", 0, 1, 0, 1),
  knob(PARAM_ADVANCE, "advance", "advance", 0, 1, 1, 1),
] satisfies ParamDefinition[];

export const choirDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.choir,
  slug: "choir",
  name: "CHOIR",
  accent: "#3f9ea8",
  rackWidth: "full",
  rackUnits: 2,
  width: 376,
  minHeight: 414,
  inputs: [
    {
      id: 0,
      label: "pitch",
      kind: "cv",
      connectionGroup: "voice",
      connectionGroupLabel: "voice",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "V/O",
    },
    {
      id: 1,
      label: "gate",
      kind: "gate",
      connectionGroup: "voice",
      connectionGroupLabel: "voice",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "gate",
    },
    { id: 2, label: "phrase", kind: "cv", connectionOrder: 2 },
    { id: 3, label: "dyn", kind: "cv", connectionOrder: 3 },
    { id: 4, label: "level", kind: "cv", connectionOrder: 4 },
  ],
  outputs: [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "main",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "main",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
    { id: 2, label: "env", kind: "cv", connectionOrder: 2 },
    { id: 3, label: "gate", kind: "gate", connectionOrder: 3 },
  ],
  params,
  Component: ChoirModule,
};

function ChoirModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const phraseIndex = phraseSlot(module.params[PARAM_PHRASE] ?? 0);

  return (
    <ModuleShell {...props}>
      <div className="choirPanel">
        <ProductionSection title="phrase" className="choirWordsSection">
          <label className="choirPhraseSelect">
            <span>{phraseIndex.toString().padStart(3, "0")}</span>
            <select
              aria-label="Choir phrase"
              value={phraseIndex}
              onChange={(event) =>
                onParamChange(
                  module.id,
                  PARAM_PHRASE,
                  Number(event.currentTarget.value),
                )
              }
            >
              {PHRASE_PRESETS.map((preset, index) => (
                <option key={`${index}-${preset}`} value={index}>
                  {index.toString().padStart(3, "0")} {preset}
                </option>
              ))}
            </select>
          </label>
        </ProductionSection>
        <KnobSections
          module={module}
          definition={definition}
          onParamChange={onParamChange}
          sections={[
            {
              title: "voice",
              paramIds: [
                PARAM_TUNE,
                PARAM_VOICE_PART,
                PARAM_VOICE_COUNT,
                PARAM_DYNAMICS,
                PARAM_BRIGHTNESS,
              ],
            },
            {
              title: "pronounce",
              paramIds: [
                PARAM_CONSONANTS,
                PARAM_TIME_SPREAD,
                PARAM_VOWEL_DELAY,
                PARAM_ACCENT,
                PARAM_ADVANCE,
              ],
            },
            {
              title: "amp",
              paramIds: [
                PARAM_EXCITER,
                PARAM_STEREO_WIDTH,
                PARAM_VIBRATO,
                PARAM_INTENSITY,
                PARAM_ATTACK_RATE,
                PARAM_RELEASE_RATE,
                PARAM_LEVEL,
              ],
            },
          ]}
        />
      </div>
    </ModuleShell>
  );
}

function phraseSlot(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(PHRASE_SLOTS - 1, Math.round(value)));
}

function knob(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
  step: number,
  unit?: string,
  scale?: ParamDefinition["scale"],
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue, unit, scale };
}
