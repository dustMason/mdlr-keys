export interface FactorySamplePad {
  label: string;
  file: string;
}

export interface FactorySampleBank {
  id: string;
  name: string;
  shortName: string;
  sourceName: string;
  sourceUrl: string;
  license: string;
  baseUrl: string;
  pads: FactorySamplePad[];
}

const ORAMICS_RAW = "https://raw.githubusercontent.com/oramics/sampled/master/DM";
const FLUID_RAW = "https://raw.githubusercontent.com/fluid-music/open-drums/main";

export const DEFAULT_FACTORY_SAMPLE_BANK_ID = "lm-2";

export const FACTORY_SAMPLE_BANKS = [
  {
    id: "lm-2",
    name: "LinnDrum LM-2",
    shortName: "LM-2",
    sourceName: "Oramics Sampled",
    sourceUrl: "https://oramics.github.io/sampled/DM/LM-2/",
    license: "Public domain or similar",
    baseUrl: `${ORAMICS_RAW}/LM-2/samples`,
    pads: [
      { label: "BD", file: "kick.wav" },
      { label: "SD", file: "snare-m.wav" },
      { label: "CLP", file: "clap.wav" },
      { label: "RIM", file: "stick-m.wav" },
      { label: "CH", file: "hihat-closed.wav" },
      { label: "OH", file: "hihat-open.wav" },
      { label: "LT", file: "tom-l.wav" },
      { label: "MT", file: "tom-m.wav" },
      { label: "HT", file: "tom-h.wav" },
      { label: "CB", file: "cowb.wav" },
      { label: "CY", file: "crash.wav" },
      { label: "RD", file: "ride.wav" },
    ],
  },
  {
    id: "tr-505",
    name: "Roland TR-505",
    shortName: "TR-505",
    sourceName: "Oramics Sampled",
    sourceUrl: "https://oramics.github.io/sampled/DM/TR-505/",
    license: "Public domain or similar",
    baseUrl: `${ORAMICS_RAW}/TR-505/samples`,
    pads: [
      { label: "BD", file: "tr505-kick.wav" },
      { label: "SD", file: "tr505-snare.wav" },
      { label: "CLP", file: "tr505-clap.wav" },
      { label: "RIM", file: "tr505-rim.wav" },
      { label: "CH", file: "tr505-hihat-closed.wav" },
      { label: "OH", file: "tr505-hihat-open.wav" },
      { label: "LT", file: "tr505-tom-l.wav" },
      { label: "MT", file: "tr505-tom-m.wav" },
      { label: "HT", file: "tr505-tom-h.wav" },
      { label: "CB", file: "tr505-cowb-l.wav" },
      { label: "CY", file: "tr505-crash.wav" },
      { label: "RD", file: "tr505-ride.wav" },
    ],
  },
  {
    id: "tr-707",
    name: "Roland TR-707",
    shortName: "TR-707",
    sourceName: "fluid-music/open-drums",
    sourceUrl: "https://github.com/fluid-music/open-drums/tree/main/tr-707/TR707WAV",
    license: "ISC",
    baseUrl: `${FLUID_RAW}/tr-707/TR707WAV`,
    pads: [
      { label: "BD", file: "BassDrum1.wav" },
      { label: "SD", file: "Snare1.wav" },
      { label: "CLP", file: "HandClap.wav" },
      { label: "RIM", file: "RimShot.wav" },
      { label: "CH", file: "HhC.wav" },
      { label: "OH", file: "HhO.wav" },
      { label: "LT", file: "LowTom.wav" },
      { label: "MT", file: "MedTom.wav" },
      { label: "HT", file: "HiTom.wav" },
      { label: "CB", file: "CowBell.wav" },
      { label: "CY", file: "Crash.wav" },
      { label: "RD", file: "Ride.wav" },
    ],
  },
  {
    id: "tr-808",
    name: "Roland TR-808",
    shortName: "TR-808",
    sourceName: "Oramics Sampled",
    sourceUrl: "https://oramics.github.io/sampled/DM/TR-808/",
    license: "Public domain or similar",
    baseUrl: `${ORAMICS_RAW}/TR-808/samples`,
    pads: [
      { label: "BD", file: "01.BD.808.wav" },
      { label: "SD", file: "01.SD5.808.wav" },
      { label: "CLP", file: "01.CP.808.wav" },
      { label: "RIM", file: "01.RS.808.wav" },
      { label: "CH", file: "01.CH.808.wav" },
      { label: "OH", file: "01.OH.808.wav" },
      { label: "LT", file: "01.LT.808.wav" },
      { label: "MT", file: "01.MT.808.wav" },
      { label: "HT", file: "01.HT.808.wav" },
      { label: "CB", file: "01.CB.808.wav" },
      { label: "CY", file: "01.CY.808.wav" },
      { label: "CLV", file: "01.CL.808.wav" },
    ],
  },
  {
    id: "tr-909-detroit",
    name: "Roland TR-909 Detroit",
    shortName: "TR-909",
    sourceName: "Oramics Sampled",
    sourceUrl: "https://oramics.github.io/sampled/DM/TR-909/Detroit/",
    license: "Public domain or similar",
    baseUrl: `${ORAMICS_RAW}/TR-909/Detroit/samples`,
    pads: [
      { label: "BD", file: "kick.wav" },
      { label: "BDS", file: "kick-short.wav" },
      { label: "SD", file: "snare.wav" },
      { label: "CLP", file: "clap-1.wav" },
      { label: "RIM", file: "rim.wav" },
      { label: "CH", file: "hihat-closed.wav" },
      { label: "OH", file: "hihat-open-1.wav" },
      { label: "LT", file: "tom-l.wav" },
      { label: "HT", file: "tom-h.wav" },
      { label: "CY", file: "cymbal.wav" },
      { label: "RD", file: "ride.wav" },
      { label: "CLP2", file: "clap-2.wav" },
    ],
  },
  {
    id: "cr-78",
    name: "Roland CR-78",
    shortName: "CR-78",
    sourceName: "Oramics Sampled",
    sourceUrl: "https://oramics.github.io/sampled/DM/CR-78/",
    license: "Public domain or similar",
    baseUrl: `${ORAMICS_RAW}/CR-78/samples`,
    pads: [
      { label: "BD", file: "kick.wav" },
      { label: "BDA", file: "kick-accent.wav" },
      { label: "SD", file: "snare.wav" },
      { label: "SDA", file: "snare-accent.wav" },
      { label: "RIM", file: "rim.wav" },
      { label: "CH", file: "hihat.wav" },
      { label: "HIA", file: "hihat-accent.wav" },
      { label: "BNG", file: "bongo-l.wav" },
      { label: "CON", file: "conga-l.wav" },
      { label: "CB", file: "cowbell.wav" },
      { label: "CY", file: "cymbal.wav" },
      { label: "TAM", file: "tamb-short.wav" },
    ],
  },
] as const satisfies readonly FactorySampleBank[];

export function factorySampleBankById(id: string) {
  return FACTORY_SAMPLE_BANKS.find((bank) => bank.id === id);
}

export function padUrl(bank: FactorySampleBank, pad: FactorySamplePad) {
  return `${bank.baseUrl}/${encodeURIComponent(pad.file)}`;
}
