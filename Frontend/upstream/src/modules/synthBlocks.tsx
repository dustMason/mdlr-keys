import type { ReactNode } from "react";
import {
  KnobList,
  paramById,
  valueForParam,
} from "./panelSections";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "./types";
import "./synthBlocks.css";

type BlockBaseProps = Pick<
  ModuleRenderProps,
  "module" | "definition" | "onParamChange"
> & {
  accent?: string;
  className?: string;
  knobClassName?: string;
  showPreview?: boolean;
};

interface AdsrControlBlockProps extends BlockBaseProps {
  attackParamId?: number;
  decayParamId?: number;
  sustainParamId?: number;
  releaseParamId?: number;
  paramIds?: number[];
}

interface LpfControlBlockProps extends BlockBaseProps {
  cutoffParamId: number;
  resonanceParamId?: number;
  paramIds?: number[];
  slope?: number;
  children?: ReactNode;
}

export function AdsrControlBlock({
  module,
  definition,
  onParamChange,
  attackParamId,
  decayParamId,
  sustainParamId,
  releaseParamId,
  paramIds,
  accent,
  className = "",
  knobClassName = "",
  showPreview = true,
}: AdsrControlBlockProps) {
  const envelope = {
    attack: valueSnapshot(module.params, definition, attackParamId, 0.08),
    decay: valueSnapshot(module.params, definition, decayParamId, 0.34),
    sustain: valueSnapshot(module.params, definition, sustainParamId, 0.58),
    release: valueSnapshot(module.params, definition, releaseParamId, 0.28),
  };
  const knobIds = paramIds ?? compactIds([
    attackParamId,
    decayParamId,
    sustainParamId,
    releaseParamId,
  ]);
  const adsrKnobClassName = ["synthAdsrKnobs", knobClassName]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={[
        "synthControlBlock",
        "synthAdsrControlBlock",
        showPreview ? "" : "synthControlBlockNoPreview",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <KnobList
        module={module}
        definition={definition}
        onParamChange={onParamChange}
        paramIds={knobIds}
        className={adsrKnobClassName}
        accent={accent}
      />
      {showPreview ? (
        <AdsrPreview
          attack={envelope.attack.normalized}
          decay={envelope.decay.normalized}
          sustain={envelope.sustain.normalized}
          release={envelope.release.normalized}
        />
      ) : null}
    </div>
  );
}

export function LpfControlBlock({
  module,
  definition,
  onParamChange,
  cutoffParamId,
  resonanceParamId,
  paramIds,
  slope = 1,
  accent,
  className = "",
  knobClassName = "",
  showPreview = true,
  children,
}: LpfControlBlockProps) {
  const cutoff = valueSnapshot(module.params, definition, cutoffParamId, 0.5);
  const resonance = valueSnapshot(module.params, definition, resonanceParamId, 0);
  const knobIds = paramIds ?? compactIds([cutoffParamId, resonanceParamId]);
  const lpfKnobClassName = ["synthLpfKnobs", knobClassName]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={[
        "synthControlBlock",
        "synthLpfControlBlock",
        showPreview ? "" : "synthControlBlockNoPreview",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <KnobList
        module={module}
        definition={definition}
        onParamChange={onParamChange}
        paramIds={knobIds}
        className={lpfKnobClassName}
        accent={accent}
      />
      {children ? <div className="synthControlAccessory">{children}</div> : null}
      {showPreview ? (
        <LpfCurvePreview
          cutoff={cutoff.normalized}
          resonance={resonance.normalized}
          slope={slope}
        />
      ) : null}
    </div>
  );
}

function AdsrPreview({
  attack,
  decay,
  sustain,
  release,
}: {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}) {
  const baseline = 38;
  const peak = 7;
  const attackX = 8 + eased(attack) * 26;
  const decayX = attackX + 12 + eased(decay) * 24;
  const sustainY = peak + (1 - clamp01(sustain)) * (baseline - peak);
  const releaseStart = Math.max(decayX + 7, 96 - eased(release) * 20);
  const trace = [
    `M 6 ${baseline}`,
    `L ${attackX.toFixed(2)} ${peak}`,
    `L ${decayX.toFixed(2)} ${sustainY.toFixed(2)}`,
    `L ${releaseStart.toFixed(2)} ${sustainY.toFixed(2)}`,
    `L 118 ${baseline}`,
  ].join(" ");

  return (
    <div className="synthControlPreview synthAdsrPreview" aria-hidden="true">
      <svg viewBox="0 0 124 44" preserveAspectRatio="none">
        <line className="synthControlGridLine" x1="6" y1="22" x2="118" y2="22" />
        <line className="synthControlAxis" x1="6" y1={baseline} x2="118" y2={baseline} />
        <path className="synthControlTrace" d={trace} />
      </svg>
    </div>
  );
}

function LpfCurvePreview({
  cutoff,
  resonance,
  slope,
}: {
  cutoff: number;
  resonance: number;
  slope: number;
}) {
  const cutoffX = 0.08 + Math.pow(clamp01(cutoff), 0.68) * 0.84;
  const res = clamp01(resonance);
  const rolloffSlope = 0.74 + Math.max(0.45, slope) * 0.22 + res * 0.1;
  const points = Array.from({ length: 72 }, (_, index) => {
    const x = index / 71;
    const above = Math.max(0, x - cutoffX);
    const normalizedAbove = above / Math.max(0.08, 1 - cutoffX);
    const rolloff = Math.pow(normalizedAbove, rolloffSlope) * 29;
    const peak = Math.exp(-Math.pow((x - cutoffX) / 0.05, 2)) * res * 12;
    const y = clamp(13 + rolloff - peak, 5, 38);
    return `${(6 + x * 112).toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const markerX = 6 + cutoffX * 112;

  return (
    <div className="synthControlPreview synthFilterPreview" aria-hidden="true">
      <svg viewBox="0 0 124 44" preserveAspectRatio="none">
        <line className="synthControlGridLine" x1="6" y1="13" x2="118" y2="13" />
        <line className="synthControlGridLine" x1="6" y1="28" x2="118" y2="28" />
        <line className="synthControlMarker" x1={markerX} y1="6" x2={markerX} y2="38" />
        <polyline className="synthControlTrace" points={points} />
      </svg>
    </div>
  );
}

function valueSnapshot(
  params: Record<number, number>,
  definition: ModuleDefinition,
  paramId: number | undefined,
  fallback: number,
) {
  if (paramId === undefined) {
    return { normalized: clamp01(fallback) };
  }

  const parameter = paramById(paramId, definition);
  const value = valueForParam(params, parameter);
  return {
    normalized: normalizeParamValue(value, parameter),
  };
}

function normalizeParamValue(value: number, param: ParamDefinition) {
  const clamped = clamp(value, param.min, param.max);
  if (
    param.scale === "exponential" &&
    param.min > 0 &&
    param.max > param.min
  ) {
    return clamp01(Math.log(clamped / param.min) / Math.log(param.max / param.min));
  }

  return clamp01((clamped - param.min) / (param.max - param.min));
}

function compactIds(ids: Array<number | undefined>) {
  return ids.filter((id): id is number => id !== undefined);
}

function eased(value: number) {
  return Math.sqrt(clamp01(value));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
