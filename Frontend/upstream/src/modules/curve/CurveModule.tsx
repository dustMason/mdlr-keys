import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "./CurveModule.css";

const CURVES = 4;
const STEPS = 64;
const PARAM_LENGTH = 0;
const PARAM_POINT_BASE = 1;
const lengths = [16, 32, 64] as const;
const curveNames = ["A", "B", "C", "D"] as const;
const curveColors = ["#111111", "#444444", "#777777", "#999999"] as const;
const VIEWBOX_WIDTH = 640;
const VIEWBOX_HEIGHT = 118;

const params = [
  param(PARAM_LENGTH, "length", "len", 16, 16, 64, 16),
  ...Array.from({ length: CURVES }, (_, curve) =>
    Array.from({ length: STEPS }, (_, step) =>
      param(
        pointParamId(curve, step),
        `curve${curve + 1}_step${step + 1}`,
        `${curveNames[curve]}${step + 1}`,
        defaultCurveValue(curve, step),
        0,
        1,
        0.001,
      ),
    ),
  ).flat(),
] satisfies ParamDefinition[];

export const curveDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.curve,
  slug: "curve",
  name: "CURVE",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 604,
  minHeight: 206,
  inputs: [],
  outputs: curveNames.map((name, index) => ({
    id: index,
    label: name,
    kind: "cv" as const,
    connectionOrder: index,
  })),
  params,
  Component: CurveModule,
};

function CurveModule(props: ModuleRenderProps) {
  const { module, onModuleParamsChange } = props;
  const [activeCurve, setActiveCurve] = useState(0);
  const [draftPoints, setDraftPointsState] = useState<number[] | null>(null);
  const draftPointsRef = useRef<number[] | null>(null);
  const drawingPointerRef = useRef<number | null>(null);
  const lastDrawRef = useRef<CurvePoint | null>(null);
  const length = lengthValue(module.params[PARAM_LENGTH]);
  const storedCurves = useMemo(
    () =>
      Array.from({ length: CURVES }, (_, curve) =>
        curvePoints(module.params, curve),
      ),
    [module.params],
  );
  const displayedCurves = storedCurves.map((points, curve) =>
    curve === activeCurve && draftPoints ? draftPoints : points,
  );

  function setDraftPoints(points: number[] | null) {
    draftPointsRef.current = points;
    setDraftPointsState(points);
  }

  function setLength(nextLength: number) {
    const normalizedLength = lengthValue(nextLength);
    if (normalizedLength === length) {
      return;
    }

    const values: Record<number, number> = { [PARAM_LENGTH]: normalizedLength };
    for (let curve = 0; curve < CURVES; curve += 1) {
      const resampled = resampleCurve(storedCurves[curve], length, normalizedLength);
      for (let step = 0; step < normalizedLength; step += 1) {
        values[pointParamId(curve, step)] = resampled[step];
      }
    }
    setDraftPoints(null);
    onModuleParamsChange(module.id, values);
  }

  function beginDraw(event: PointerEvent<SVGSVGElement>) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingPointerRef.current = event.pointerId;
    const points = [...storedCurves[activeCurve]];
    const point = pointerCurvePoint(event, event.currentTarget, length);
    paintPoint(points, point);
    lastDrawRef.current = point;
    setDraftPoints(points);
  }

  function continueDraw(event: PointerEvent<SVGSVGElement>) {
    if (drawingPointerRef.current !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const point = pointerCurvePoint(event, event.currentTarget, length);
    const points = [...(draftPointsRef.current ?? storedCurves[activeCurve])];
    paintLine(points, lastDrawRef.current, point);
    lastDrawRef.current = point;
    setDraftPoints(points);
  }

  function commitDraw(event: PointerEvent<SVGSVGElement>) {
    if (drawingPointerRef.current !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    drawingPointerRef.current = null;
    lastDrawRef.current = null;
    const points = draftPointsRef.current;
    setDraftPoints(null);
    if (!points) {
      return;
    }

    const values: Record<number, number> = {};
    const stored = storedCurves[activeCurve];
    for (let step = 0; step < length; step += 1) {
      const value = roundValue(points[step]);
      if (!Object.is(value, stored[step])) {
        values[pointParamId(activeCurve, step)] = value;
      }
    }
    onModuleParamsChange(module.id, values);
  }

  return (
    <ModuleShell {...props}>
      <div className="curvePanel">
        <div className="curveControls">
          <div className="curveSegments" aria-label="curve length">
            {lengths.map((option) => (
              <button
                key={option}
                className={option === length ? "isActive" : ""}
                type="button"
                onClick={() => setLength(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="curveTabs" aria-label="active curve">
            {curveNames.map((name, index) => (
              <button
                key={name}
                className={index === activeCurve ? "isActive" : ""}
                style={{ "--curve-color": curveColors[index] } as CSSProperties}
                type="button"
                onClick={() => {
                  setDraftPoints(null);
                  setActiveCurve(index);
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <svg
          className="curveEditor"
          viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
          role="img"
          aria-label={`${curveNames[activeCurve]} CV curve`}
          onPointerDown={beginDraw}
          onPointerMove={continueDraw}
          onPointerUp={commitDraw}
          onPointerCancel={commitDraw}
        >
          <rect x="0" y="0" width={VIEWBOX_WIDTH} height={VIEWBOX_HEIGHT} />
          {[0.25, 0.5, 0.75].map((value) => (
            <line
              key={value}
              className="curveGrid curveGridHorizontal"
              x1="0"
              x2={VIEWBOX_WIDTH}
              y1={VIEWBOX_HEIGHT * value}
              y2={VIEWBOX_HEIGHT * value}
            />
          ))}
          {Array.from({ length: length + 1 }, (_, index) => (
            <line
              key={index}
              className={[
                "curveGrid",
                index % 4 === 0 ? "curveGridBeat" : "",
              ].join(" ")}
              x1={(index / length) * VIEWBOX_WIDTH}
              x2={(index / length) * VIEWBOX_WIDTH}
              y1="0"
              y2={VIEWBOX_HEIGHT}
            />
          ))}
          {displayedCurves.map((points, curve) => (
            <path
              key={curve}
              className={[
                "curveTrace",
                curve === activeCurve ? "isActive" : "",
              ].join(" ")}
              d={curvePath(points, length)}
              style={{ "--curve-color": curveColors[curve] } as CSSProperties}
            />
          ))}
        </svg>
      </div>
    </ModuleShell>
  );
}

interface CurvePoint {
  step: number;
  value: number;
}

function pointerCurvePoint(
  event: PointerEvent<SVGSVGElement>,
  element: SVGSVGElement,
  length: number,
): CurvePoint {
  const rect = element.getBoundingClientRect();
  const x = clamp01((event.clientX - rect.left) / rect.width);
  const y = clamp01((event.clientY - rect.top) / rect.height);
  return {
    step: Math.max(0, Math.min(length - 1, Math.round(x * (length - 1)))),
    value: roundValue(1 - y),
  };
}

function paintPoint(points: number[], point: CurvePoint) {
  points[point.step] = point.value;
}

function paintLine(
  points: number[],
  previous: CurvePoint | null,
  next: CurvePoint,
) {
  if (!previous || previous.step === next.step) {
    paintPoint(points, next);
    return;
  }

  const start = Math.min(previous.step, next.step);
  const end = Math.max(previous.step, next.step);
  for (let step = start; step <= end; step += 1) {
    const t = (step - previous.step) / (next.step - previous.step);
    points[step] = roundValue(previous.value + (next.value - previous.value) * t);
  }
}

function curvePoints(params: Record<number, number>, curve: number) {
  return Array.from({ length: STEPS }, (_, step) =>
    clamp01(params[pointParamId(curve, step)] ?? defaultCurveValue(curve, step)),
  );
}

function resampleCurve(points: number[], fromLength: number, toLength: number) {
  return Array.from({ length: toLength }, (_, step) => {
    if (toLength <= 1 || fromLength <= 1) {
      return roundValue(points[0] ?? 0);
    }
    const source = (step / (toLength - 1)) * (fromLength - 1);
    const left = Math.floor(source);
    const right = Math.min(fromLength - 1, left + 1);
    const t = source - left;
    return roundValue((points[left] ?? 0) + ((points[right] ?? 0) - (points[left] ?? 0)) * t);
  });
}

function curvePath(points: number[], length: number) {
  return points
    .slice(0, length)
    .map((value, index) => {
      const x = length <= 1 ? 0 : (index / (length - 1)) * VIEWBOX_WIDTH;
      const y = (1 - clamp01(value)) * VIEWBOX_HEIGHT;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function pointParamId(curve: number, step: number) {
  return PARAM_POINT_BASE + curve * STEPS + step;
}

function lengthValue(value: number | undefined) {
  if ((value ?? 16) < 24) {
    return 16;
  }
  if ((value ?? 16) < 48) {
    return 32;
  }
  return 64;
}

function defaultCurveValue(curve: number, step: number) {
  const phase = step / STEPS;
  switch (curve) {
    case 1:
      return roundValue(phase);
    case 2:
      return roundValue(1 - phase);
    case 3:
      return phase < 0.5 ? 0.25 : 0.75;
    default:
      return roundValue(0.5 + Math.sin(Math.PI * 2 * phase) * 0.38);
  }
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function roundValue(value: number) {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function param(
  id: number,
  key: string,
  label: string,
  defaultValue: number,
  min: number,
  max: number,
  step: number,
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue };
}
