import { useMemo } from "react";
import { ModuleKnob } from "../../components/Knob";
import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { paramById, valueForParam } from "../panelSections";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "./ParametricEqModule.css";

const EQ_BANDS = [
  {
    key: "low",
    label: "low",
    freqParamId: 0,
    gainParamId: 1,
    qParamId: 2,
    defaultFreq: 110,
    defaultQ: 0.75,
  },
  {
    key: "mid",
    label: "mid",
    freqParamId: 3,
    gainParamId: 4,
    qParamId: 5,
    defaultFreq: 1_000,
    defaultQ: 1.0,
  },
  {
    key: "high",
    label: "high",
    freqParamId: 9,
    gainParamId: 10,
    qParamId: 11,
    defaultFreq: 8_400,
    defaultQ: 0.7,
  },
] as const;

const eqParams = EQ_BANDS.flatMap((band) => [
  freqParam(band.freqParamId, `${band.key}_freq`, band.defaultFreq),
  gainParam(band.gainParamId, `${band.key}_gain`),
  qParam(band.qParamId, `${band.key}_q`, band.defaultQ),
]) satisfies ParamDefinition[];

export const parametricEqDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.parametricEq,
  slug: "eq3",
  name: "EQ3",
  accent: "#111111",
  rackWidth: "half",
  rackUnits: 1,
  width: 356,
  minHeight: 292,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "main-in",
      connectionGroupLabel: "in",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "main-in",
      connectionGroupLabel: "in",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
  ],
  outputs: [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "out",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "out",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
  ],
  params: withBypass(eqParams),
  Component: ParametricEqModule,
};

function ParametricEqModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="eq3Panel">
        <EqCurve module={module} definition={definition} />
        <div className="eq3Bands">
          {EQ_BANDS.map((band) => (
            <section className="eq3Band" key={band.key}>
              <h3>{band.label}</h3>
              <div className="eq3BandKnobs">
                {[band.freqParamId, band.gainParamId, band.qParamId].map((paramId) => {
                  const parameter = paramById(paramId, definition);
                  return (
                    <ModuleKnob
                      key={parameter.id}
                      definition={definition}
                      param={parameter}
                      value={valueForParam(module.params, parameter)}
                      onChange={(value) =>
                        onParamChange(module.id, parameter.id, value)
                      }
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </ModuleShell>
  );
}

function EqCurve({
  module,
  definition,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
}) {
  const points = useMemo(() => responsePoints(module.params, definition), [
    module.params,
    definition,
  ]);
  const handles = useMemo(() => bandHandles(module.params, definition), [
    module.params,
    definition,
  ]);

  return (
    <svg
      className="eq3Curve"
      viewBox="0 0 220 48"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line className="eq3CurveZero" x1="0" y1="24" x2="220" y2="24" />
      <polyline className="eq3CurveLine" points={points} />
      {handles.map((handle) => (
        <circle
          key={handle.band}
          className="eq3CurveHandle"
          cx={handle.x}
          cy={handle.y}
          r="3"
        />
      ))}
    </svg>
  );
}

function responsePoints(
  params: ModuleRenderProps["module"]["params"],
  definition: ModuleDefinition,
) {
  return Array.from({ length: 80 }, (_, index) => {
    const x = index / 79;
    const freq = freqAtPosition(x);
    const db = bandDbAt(freq, params, definition);
    const y = dbToY(db);
    return `${(x * 220).toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

function bandHandles(
  params: ModuleRenderProps["module"]["params"],
  definition: ModuleDefinition,
) {
  return EQ_BANDS.map((band) => {
    const freq = valueForParam(params, paramById(band.freqParamId, definition));
    const gain = valueForParam(params, paramById(band.gainParamId, definition));
    return {
      band: band.key,
      x: freqToX(freq) * 220,
      y: dbToY(gain),
    };
  });
}

function bandDbAt(
  freq: number,
  params: ModuleRenderProps["module"]["params"],
  definition: ModuleDefinition,
) {
  let db = 0;
  for (const band of EQ_BANDS) {
    const center = valueForParam(params, paramById(band.freqParamId, definition));
    const gain = valueForParam(params, paramById(band.gainParamId, definition));
    const q = valueForParam(params, paramById(band.qParamId, definition));
    const distance = Math.log(freq / center);
    const width = 0.9 / Math.max(0.2, q);
    db += gain * Math.exp(-0.5 * Math.pow(distance / width, 2));
  }
  return Math.max(-18, Math.min(18, db));
}

function dbToY(db: number) {
  return 24 - (Math.max(-18, Math.min(18, db)) / 18) * 18;
}

function freqToX(freq: number) {
  return Math.max(0, Math.min(1, Math.log(freq / 20) / Math.log(18_000 / 20)));
}

function freqAtPosition(position: number) {
  return 20 * Math.pow(18_000 / 20, Math.max(0, Math.min(1, position)));
}

function freqParam(id: number, key: string, defaultValue: number): ParamDefinition {
  return {
    id,
    key,
    label: "freq",
    min: 20,
    max: 18_000,
    step: 1,
    defaultValue,
    unit: "Hz",
    scale: "exponential",
  };
}

function gainParam(id: number, key: string): ParamDefinition {
  return {
    id,
    key,
    label: "gain",
    min: -18,
    max: 18,
    step: 0.5,
    defaultValue: 0,
    unit: "dB",
  };
}

function qParam(id: number, key: string, defaultValue: number): ParamDefinition {
  return {
    id,
    key,
    label: "q",
    min: 0.2,
    max: 10,
    step: 0.1,
    defaultValue,
  };
}
