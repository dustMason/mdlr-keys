import { useEffect, useRef } from "react";
import type { ScopeSnapshot } from "../../audio/ModularAudioEngine";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps } from "../types";
import "./ScopeModule.css";

const traceLeft = "#8dffad";
const traceRight = "#42dda0";

export const scopeDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.scope,
  slug: "scope",
  name: "SCOPE",
  accent: traceLeft,
  rackWidth: "half",
  rackUnits: 1,
  width: 356,
  minHeight: 230,
  inputs: [
    {
      id: 0,
      label: "a",
      kind: "audio",
      connectionOrder: 0,
      connectionGroup: "scope-in",
      connectionGroupLabel: "in",
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "b",
      kind: "audio",
      connectionOrder: 1,
      connectionGroup: "scope-in",
      connectionGroupLabel: "in",
      connectionLabel: "R",
    },
  ],
  outputs: [
    {
      id: 0,
      label: "a thru",
      kind: "audio",
      connectionOrder: 0,
      connectionGroup: "scope-out",
      connectionGroupLabel: "thru",
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "b thru",
      kind: "audio",
      connectionOrder: 1,
      connectionGroup: "scope-out",
      connectionGroupLabel: "thru",
      connectionLabel: "R",
    },
  ],
  params: [],
  Component: ScopeModule,
};

function ScopeModule(props: ModuleRenderProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scopeDataRef = useRef<ScopeSnapshot | undefined>(props.scopeData);

  useEffect(() => {
    scopeDataRef.current = props.scopeData;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    drawScope(canvas, props.scopeData?.left, props.scopeData?.right);
  }, [props.scopeData]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const redraw = () => {
      const scopeData = scopeDataRef.current;
      drawScope(canvas, scopeData?.left, scopeData?.right);
    };
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    redraw();
    return () => observer.disconnect();
  }, []);

  return (
    <ModuleShell {...props}>
      <div className="scopePanel">
        <canvas
          ref={canvasRef}
          className="scopeCanvas"
          width={620}
          height={220}
          aria-label="dual waveform scope"
        />
        <div className="scopeLegend">
          <span className="scopeTraceA">A</span>
          <span className="scopeTraceB">B</span>
        </div>
      </div>
    </ModuleShell>
  );
}

function drawScope(
  canvas: HTMLCanvasElement,
  left?: Float32Array,
  right?: Float32Array,
) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const bounds = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, bounds.width || canvas.width / dpr);
  const height = Math.max(1, bounds.height || canvas.height / dpr);
  const backingWidth = Math.max(1, Math.round(width * dpr));
  const backingHeight = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#010604";
  context.fillRect(0, 0, width, height);

  drawGrid(context, width, height);
  if (left && left.length > 1) {
    drawTrace(context, left, width, height, traceLeft, 0.38);
  }
  if (right && right.length > 1) {
    drawTrace(context, right, width, height, traceRight, 0.62);
  }

  context.shadowBlur = 0;
  context.strokeStyle = "rgba(126, 255, 173, 0.22)";
  context.lineWidth = 1;
  context.lineCap = "butt";
  context.lineJoin = "miter";
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();

  if (!left && !right) {
    context.fillStyle = "rgba(141, 255, 173, 0.48)";
    context.font = "10px SFMono-Regular, Consolas, monospace";
    context.textAlign = "center";
    context.fillText("NO SIGNAL", width / 2, height / 2 + 4);
  }
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  context.strokeStyle = "rgba(103, 218, 153, 0.12)";
  context.lineWidth = 1;
  context.lineCap = "butt";
  context.lineJoin = "miter";
  context.beginPath();

  for (let x = 0; x <= width + 0.1; x += width / 12) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let y = 0; y <= height + 0.1; y += height / 6) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }

  context.stroke();

  context.strokeStyle = "rgba(126, 255, 173, 0.25)";
  context.beginPath();
  context.moveTo(width / 2, 0);
  context.lineTo(width / 2, height);
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();
}

function drawTrace(
  context: CanvasRenderingContext2D,
  samples: Float32Array,
  width: number,
  height: number,
  color: string,
  laneCenter: number,
) {
  const centerY = height * laneCenter;
  const scale = Math.max(32, height * 0.56);
  const sliceWidth = width / Math.max(1, samples.length - 1);

  context.strokeStyle = color;
  context.lineWidth = 1.05;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();

  for (let index = 0; index < samples.length; index += 1) {
    const x = index * sliceWidth;
    const y = centerY - Math.max(-1, Math.min(1, samples[index])) * scale;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  context.stroke();
}
