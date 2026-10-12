import { useEffect, useState } from "react";
import type { AudioEngineStats } from "../audio/ModularAudioEngine";

interface PerfOverlayProps {
  open: boolean;
  audioStats: AudioEngineStats;
  moduleCount: number;
  cableCount: number;
  paramCount: number;
  rackSize: { width: number; height: number };
  connectionView: boolean;
  onToggle: () => void;
}

interface UiPerfStats {
  fps: number;
  frameMs: number;
  frameMaxMs: number;
  longFrames: number;
  heapMb: number | null;
}

const emptyUiStats: UiPerfStats = {
  fps: 0,
  frameMs: 0,
  frameMaxMs: 0,
  longFrames: 0,
  heapMb: null,
};

export function PerfOverlay({
  open,
  audioStats,
  moduleCount,
  cableCount,
  paramCount,
  rackSize,
  connectionView,
  onToggle,
}: PerfOverlayProps) {
  const uiStats = useUiPerfStats(open);

  return (
    <div className="perfDock">
      <button
        className={`perfToggle ${open ? "isActive" : ""}`}
        type="button"
        onClick={onToggle}
      >
        perf
      </button>

      {open ? (
        <aside className="perfOverlay" aria-label="performance debug overlay">
          <div className="perfGrid">
            <Metric label="fps" value={formatNumber(uiStats.fps, 0)} />
            <Metric label="frame" value={`${formatNumber(uiStats.frameMs, 1)}ms`} />
            <Metric label="fmax" value={`${formatNumber(uiStats.frameMaxMs, 1)}ms`} />
            <Metric label="long" value={String(uiStats.longFrames)} />
            <Metric label="heap" value={formatHeap(uiStats.heapMb)} />
            <Metric label="audio" value={audioStats.contextState} />
            <Metric label="worklet" value={audioStats.workletReady ? "ready" : "idle"} />
            <Metric label="sr" value={formatSampleRate(audioStats.sampleRate)} />
            <Metric label="base" value={`${formatNumber(audioStats.baseLatencyMs, 1)}ms`} />
            <Metric label="out" value={`${formatNumber(audioStats.outputLatencyMs, 1)}ms`} />
            <Metric label="blocks" value={`${audioStats.blocksPerSecond}/s`} />
            <Metric label="budget" value={`${formatNumber(audioStats.renderBudgetMs, 2)}ms`} />
            <Metric label="load" value={formatLoad(audioStats.processAvgMs, audioStats.renderBudgetMs)} />
            <Metric label="proc" value={`${formatNumber(audioStats.processAvgMs, 2)}ms`} />
            <Metric label="pmax" value={`${formatNumber(audioStats.processMaxMs, 2)}ms`} />
            <Metric label="wasm" value={`${formatNumber(audioStats.renderAvgMs, 2)}ms`} />
            <Metric label="wmax" value={`${formatNumber(audioStats.renderMaxMs, 2)}ms`} />
            <Metric label="late" value={String(audioStats.lateBlocks)} />
            <Metric label="gap" value={`${formatNumber(audioStats.callbackGapMaxMs, 2)}ms`} />
            <Metric label="zero" value={String(audioStats.silentBlocks)} />
            <Metric label="sync" value={`${formatNumber(audioStats.graphSyncMs, 1)}ms`} />
            <Metric label="smax" value={`${formatNumber(audioStats.graphSyncMaxMs, 1)}ms`} />
            <Metric label="age" value={`${formatNumber(renderStatsAgeMs(audioStats), 0)}ms`} />
            <Metric label="peak" value={formatPeak(audioStats.peak)} />
            <Metric label="mods" value={String(moduleCount)} />
            <Metric label="cables" value={String(cableCount)} />
            <Metric label="params" value={String(paramCount)} />
            <Metric label="graph" value={`#${audioStats.graphVersion}`} />
            <Metric label="view" value={connectionView ? "patch" : "ctrl"} />
            <Metric label="rack" value={`${rackSize.width}x${rackSize.height}`} />
          </div>
          {audioStats.lastError ? (
            <div className="perfError">{audioStats.lastError}</div>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="perfMetric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function useUiPerfStats(active: boolean) {
  const [stats, setStats] = useState(emptyUiStats);

  useEffect(() => {
    if (!active) {
      return;
    }

    let animationFrame = 0;
    let lastFrame = performance.now();
    let lastPublish = lastFrame;
    let frameCount = 0;
    let frameMsTotal = 0;
    let frameMaxMs = 0;
    let longFrames = 0;

    const tick = (now: number) => {
      const frameMs = now - lastFrame;
      lastFrame = now;
      frameCount += 1;
      frameMsTotal += frameMs;
      frameMaxMs = Math.max(frameMaxMs, frameMs);
      if (frameMs > 50) {
        longFrames += 1;
      }

      if (now - lastPublish >= 500) {
        const elapsedSeconds = (now - lastPublish) / 1000;
        setStats({
          fps: frameCount / elapsedSeconds,
          frameMs: frameMsTotal / Math.max(1, frameCount),
          frameMaxMs,
          longFrames,
          heapMb: readHeapMb(),
        });
        lastPublish = now;
        frameCount = 0;
        frameMsTotal = 0;
        frameMaxMs = 0;
        longFrames = 0;
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [active]);

  return stats;
}

function readHeapMb() {
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize: number };
    }
  ).memory;
  return memory ? memory.usedJSHeapSize / 1024 / 1024 : null;
}

function formatNumber(value: number, decimals: number) {
  return Number.isFinite(value) ? value.toFixed(decimals) : "0";
}

function formatHeap(value: number | null) {
  return value === null ? "n/a" : `${formatNumber(value, 0)}mb`;
}

function formatSampleRate(value: number) {
  return value > 0 ? `${Math.round(value / 1000)}k` : "n/a";
}

function formatPeak(peak: number) {
  if (peak <= 0.00001) {
    return "-inf";
  }
  return `${formatNumber(20 * Math.log10(peak), 1)}db`;
}

function formatLoad(processAvgMs: number, budgetMs: number) {
  if (!Number.isFinite(processAvgMs) || !Number.isFinite(budgetMs) || budgetMs <= 0) {
    return "n/a";
  }
  return `${formatNumber((processAvgMs / budgetMs) * 100, 0)}%`;
}

function renderStatsAgeMs(audioStats: AudioEngineStats) {
  if (!audioStats.lastRenderStatsAtMs) {
    return 0;
  }
  return Math.max(0, performance.now() - audioStats.lastRenderStatsAtMs);
}
