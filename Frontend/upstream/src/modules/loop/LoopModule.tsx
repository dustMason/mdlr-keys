import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import {
  loopSampleWithSlot,
  loopSampleWithoutSlot,
  saveLocalLoopSlot,
  uploadLoopSlot,
  type LoopUploadOptions,
} from "../../loop/loopStorage";
import { MODULE_KINDS } from "../kinds";
import type {
  LoopSampleState,
  LoopTextState,
  LoopRuntimeSampleAsset,
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "./LoopModule.css";

const TRACKS = 8;
const CLIPS_PER_TRACK = 4;
const CELLS = TRACKS * CLIPS_PER_TRACK;
const LOOP_TRACK_LABEL_MAX_LENGTH = 32;
const PARAM_RECORD_BASE = 200;
const PARAM_PLAY_BASE = 240;
const PARAM_CLEAR_BASE = 280;
const PARAM_REVERSE_BASE = 320;
const PARAM_STRETCH_BASE = 360;
const PARAM_MONITOR_BASE = 80;
const METER_CELL_LEVEL_BASE = 0;
const METER_RECORDING_BASE = CELLS;
const METER_PLAYING_BASE = CELLS * 2;
const METER_HAS_LOOP_BASE = CELLS * 3;
const METER_PLAY_PHASE_BASE = CELLS * 4;
const METER_RECORD_BARS_BASE = CELLS * 5;
const METER_INPUT_LEFT = CELLS * 6;
const METER_INPUT_RIGHT = CELLS * 6 + 1;

const trackIndexes = Array.from({ length: TRACKS }, (_, index) => index);
const clipIndexes = Array.from({ length: CLIPS_PER_TRACK }, (_, index) => index);
const cellIndexes = Array.from({ length: CELLS }, (_, index) => index);
const LOOP_PLAYBACK_OPTIONS = [
  { value: "fwd-0.5", label: "0.5x", reverse: false, stretch: 0.5 },
  { value: "fwd-1", label: "1x", reverse: false, stretch: 1 },
  { value: "fwd-2", label: "2x", reverse: false, stretch: 2 },
  { value: "rev-0.5", label: "rev 0.5x", reverse: true, stretch: 0.5 },
  { value: "rev-1", label: "rev 1x", reverse: true, stretch: 1 },
  { value: "rev-2", label: "rev 2x", reverse: true, stretch: 2 },
] as const;

const params: ParamDefinition[] = [
  ...cellIndexes.map((cell) =>
    param(PARAM_RECORD_BASE + cell, `record${cell + 1}`, "rec", 0, 1, 0, 1),
  ),
  ...cellIndexes.map((cell) =>
    param(PARAM_PLAY_BASE + cell, `play${cell + 1}`, "play", 0, 1, 0, 1),
  ),
  ...cellIndexes.map((cell) =>
    param(PARAM_CLEAR_BASE + cell, `clear${cell + 1}`, "clear", 0, 1_000_000, 0, 1),
  ),
  ...cellIndexes.map((cell) =>
    param(PARAM_REVERSE_BASE + cell, `reverse${cell + 1}`, "rev", 0, 1, 0, 1),
  ),
  ...cellIndexes.map((cell) =>
    param(PARAM_STRETCH_BASE + cell, `stretch${cell + 1}`, "speed", 0.5, 2, 1, 0.5),
  ),
  ...trackIndexes.map((track) =>
    param(
      PARAM_MONITOR_BASE + track,
      `monitor${track + 1}`,
      "mon",
      0,
      1,
      defaultMonitorValue(track),
      1,
    ),
  ),
];

export const loopDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.loop,
  slug: "loop",
  name: "LOOP",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 2,
  width: 716,
  minHeight: 414,
  inputs: [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "stereo-in",
      connectionGroupLabel: "stereo in",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "stereo-in",
      connectionGroupLabel: "stereo in",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
  ],
  outputs: [
    ...trackIndexes.flatMap((track) => [
      {
        id: trackOutputLeftId(track),
        label: `${track + 1} left`,
        kind: "audio" as const,
        connectionGroup: `track-${track + 1}-out`,
        connectionGroupLabel: `${track + 1}`,
        connectionGroupOrder: track,
        connectionOrder: 0,
        connectionLabel: "L",
      },
      {
        id: trackOutputRightId(track),
        label: `${track + 1} right`,
        kind: "audio" as const,
        connectionGroup: `track-${track + 1}-out`,
        connectionGroupLabel: `${track + 1}`,
        connectionGroupOrder: track,
        connectionOrder: 1,
        connectionLabel: "R",
      },
    ]),
  ],
  params,
  Component: LoopModule,
};

function trackOutputLeftId(track: number) {
  return 4 + track * 2;
}

function trackOutputRightId(track: number) {
  return trackOutputLeftId(track) + 1;
}

function LoopModule(props: ModuleRenderProps) {
  const {
    module,
    mixerMeterData,
    onModuleParamsChange,
    onParamChange,
    onModuleSampleChange,
    onModuleTextChange,
    onLoopExport,
  } = props;
  const [message, setMessage] = useState("");
  const exportingCellsRef = useRef(new Set<number>());
  const pendingExportCellsRef = useRef(new Set<number>());
  const draggedCellRef = useRef<number | undefined>(undefined);
  const armedPlayCellsRef = useRef(new Set<number>());
  const loopSample = module.sample?.kind === "loop" ? module.sample : undefined;
  const loopSampleRef = useRef(loopSample);
  loopSampleRef.current = loopSample;
  const meters = mixerMeterData?.levels;
  const inputLeft = meters?.[METER_INPUT_LEFT] ?? 0;
  const inputRight = meters?.[METER_INPUT_RIGHT] ?? 0;
  const monitorTrack = selectedMonitorTrack(module.params);
  const loopText = module.text?.kind === "loop" ? module.text : undefined;

  useEffect(() => {
    if (!meters) {
      return;
    }

    for (const cell of cellIndexes) {
      const isRecording = (meters[METER_RECORDING_BASE + cell] ?? 0) >= 0.5;
      const hasLoop = (meters[METER_HAS_LOOP_BASE + cell] ?? 0) >= 0.5;
      if (
        !isRecording &&
        hasLoop &&
        pendingExportCellsRef.current.has(cell) &&
        !exportingCellsRef.current.has(cell)
      ) {
        pendingExportCellsRef.current.delete(cell);
        void persistRecordedCell(trackForCell(cell), clipForCell(cell));
      }
    }
  }, [meters]);

  useEffect(() => {
    const activeMonitorTracks = monitorActiveTracks(module.params);
    if (activeMonitorTracks.length <= 1) {
      return;
    }
    const selectedTrack = activeMonitorTracks[0];
    for (const track of trackIndexes) {
      onParamChange(
        module.id,
        PARAM_MONITOR_BASE + track,
        track === selectedTrack ? 1 : 0,
      );
    }
  }, [module.id, module.params, onParamChange]);

  useEffect(() => {
    if (monitorTrack === undefined || !meters) {
      return;
    }
    const trackIsPlaying = clipIndexes.some(
      (clip) => (meters[METER_PLAYING_BASE + cellIndex(monitorTrack, clip)] ?? 0) >= 0.5,
    );
    if (trackIsPlaying) {
      onParamChange(module.id, PARAM_MONITOR_BASE + monitorTrack, 0);
    }
  }, [meters, module.id, monitorTrack, onParamChange]);

  useEffect(() => {
    if (!meters) {
      return;
    }

    for (const armedCell of Array.from(armedPlayCellsRef.current)) {
      const armedIsPlaying =
        (meters[METER_PLAYING_BASE + armedCell] ?? 0) >= 0.5;
      if (!armedIsPlaying) {
        continue;
      }
      const track = trackForCell(armedCell);
      for (const clip of clipIndexes) {
        const cell = cellIndex(track, clip);
        if (cell === armedCell) {
          continue;
        }
        armedPlayCellsRef.current.delete(cell);
        if ((module.params[PARAM_PLAY_BASE + cell] ?? 0) >= 0.5) {
          setCellParam(track, clip, PARAM_PLAY_BASE, 0);
        }
        if ((module.params[PARAM_RECORD_BASE + cell] ?? 0) >= 0.5) {
          setCellParam(track, clip, PARAM_RECORD_BASE, 0);
        }
      }
      armedPlayCellsRef.current.delete(armedCell);
    }
  }, [meters, module.params]);

  function setCellParam(track: number, clip: number, base: number, value: number) {
    onParamChange(module.id, base + cellIndex(track, clip), value);
  }

  function stopOtherTrackCells(track: number, keepClip: number) {
    for (const candidate of clipIndexes) {
      if (candidate === keepClip) {
        continue;
      }
      const cell = cellIndex(track, candidate);
      const isRecording = (meters?.[METER_RECORDING_BASE + cell] ?? 0) >= 0.5;
      if (!isRecording) {
        pendingExportCellsRef.current.delete(cell);
      }
      armedPlayCellsRef.current.delete(cell);
      setCellParam(track, candidate, PARAM_RECORD_BASE, 0);
      setCellParam(track, candidate, PARAM_PLAY_BASE, 0);
    }
  }

  function stopOtherIdleTrackCells(track: number, keepClip: number) {
    for (const candidate of clipIndexes) {
      if (candidate === keepClip) {
        continue;
      }
      const cell = cellIndex(track, candidate);
      const isKnownPending = armedPlayCellsRef.current.has(cell);
      const isPlaying = (meters?.[METER_PLAYING_BASE + cell] ?? 0) >= 0.5;
      const isProbablyPlaying =
        (module.params[PARAM_PLAY_BASE + cell] ?? 0) >= 0.5 && !isKnownPending;
      if (isPlaying || isProbablyPlaying) {
        continue;
      }
      const isRecording = (meters?.[METER_RECORDING_BASE + cell] ?? 0) >= 0.5;
      if (!isRecording) {
        pendingExportCellsRef.current.delete(cell);
      }
      armedPlayCellsRef.current.delete(cell);
      setCellParam(track, candidate, PARAM_RECORD_BASE, 0);
      setCellParam(track, candidate, PARAM_PLAY_BASE, 0);
    }
  }

  function selectMonitorTrack(track: number) {
    for (const candidate of trackIndexes) {
      onParamChange(
        module.id,
        PARAM_MONITOR_BASE + candidate,
        candidate === track ? 1 : 0,
      );
    }
  }

  function toggleMonitor(track: number) {
    if (selectedMonitorTrack(module.params) === track) {
      onParamChange(module.id, PARAM_MONITOR_BASE + track, 0);
      return;
    }
    for (const clip of clipIndexes) {
      armedPlayCellsRef.current.delete(cellIndex(track, clip));
      setCellParam(track, clip, PARAM_PLAY_BASE, 0);
    }
    selectMonitorTrack(track);
  }

  function toggleCell(
    track: number,
    clip: number,
    loop: LoopSampleState["loops"][number] | undefined,
    recording: boolean,
  ) {
    const cell = cellIndex(track, clip);
    const recordActive =
      recording || (module.params[PARAM_RECORD_BASE + cell] ?? 0) >= 0.5;
    if (recordActive) {
      setMessage(`track ${track + 1}.${clip + 1} ending`);
      setCellParam(track, clip, PARAM_RECORD_BASE, 0);
      return;
    }

    if (!loop) {
      stopOtherTrackCells(track, clip);
      pendingExportCellsRef.current.add(cell);
      setMessage(`track ${track + 1}.${clip + 1} armed`);
      setCellParam(track, clip, PARAM_PLAY_BASE, 0);
      selectMonitorTrack(track);
      setCellParam(track, clip, PARAM_RECORD_BASE, 1);
      return;
    }

    const active = (module.params[PARAM_PLAY_BASE + cell] ?? 0) >= 0.5;
    if (!active) {
      stopOtherIdleTrackCells(track, clip);
      armedPlayCellsRef.current.add(cell);
    } else {
      armedPlayCellsRef.current.delete(cell);
    }
    setCellParam(track, clip, PARAM_PLAY_BASE, active ? 0 : 1);
  }

  function clearCell(track: number, clip: number) {
    const cell = cellIndex(track, clip);
    pendingExportCellsRef.current.delete(cell);
    exportingCellsRef.current.delete(cell);
    armedPlayCellsRef.current.delete(cell);
    setCellParam(track, clip, PARAM_RECORD_BASE, 0);
    setCellParam(track, clip, PARAM_PLAY_BASE, 0);
    setCellParam(track, clip, PARAM_CLEAR_BASE, (module.params[PARAM_CLEAR_BASE + cell] ?? 0) + 1);
    onModuleSampleChange(module.id, loopSampleWithoutSlot(loopSample, track, clip));
    setMessage(`track ${track + 1}.${clip + 1} cleared`);
  }

  function setTrackLabel(track: number, label: string) {
    const nextLabels = trackIndexes.map((candidate) =>
      candidate === track
        ? normalizeTrackLabel(label)
        : loopTrackLabel(loopText, candidate),
    );
    while (nextLabels.length > 0 && nextLabels[nextLabels.length - 1] === "") {
      nextLabels.pop();
    }
    onModuleTextChange(
      module.id,
      nextLabels.length > 0
        ? { version: 1, kind: "loop", slotLabels: nextLabels }
        : undefined,
    );
  }

  function moveCell(toTrack: number, toClip: number) {
    const fromCell = draggedCellRef.current;
    draggedCellRef.current = undefined;
    if (fromCell === undefined) {
      return;
    }
    const toCell = cellIndex(toTrack, toClip);
    if (fromCell === toCell) {
      return;
    }
    const fromTrack = trackForCell(fromCell);
    const fromClip = clipForCell(fromCell);
    const source = findLoop(loopSample, fromTrack, fromClip);
    if (!source) {
      return;
    }
    const target = findLoop(loopSample, toTrack, toClip);
    let nextSample = loopSampleWithoutSlot(loopSample, fromTrack, fromClip);
    nextSample = loopSampleWithoutSlot(nextSample, toTrack, toClip);
    nextSample = loopSampleWithSlot(nextSample, {
      ...source,
      slot: toTrack,
      clip: toClip,
    });
    if (target) {
      nextSample = loopSampleWithSlot(nextSample, {
        ...target,
        slot: fromTrack,
        clip: fromClip,
      });
    }
    onModuleSampleChange(module.id, nextSample);
    onModuleParamsChange(module.id, swappedCellParams(module.params, fromCell, toCell, Boolean(target)));
    setMessage(`moved ${fromTrack + 1}.${fromClip + 1} to ${toTrack + 1}.${toClip + 1}`);
  }

  async function persistRecordedCell(track: number, clip: number) {
    const cell = cellIndex(track, clip);
    const options = loopUploadOptions(module, track, clip, loopTrackDisplayLabel(loopText, track));
    exportingCellsRef.current.add(cell);
    setCellParam(track, clip, PARAM_RECORD_BASE, 0);
    setMessage(`saving ${track + 1}.${clip + 1}`);
    try {
      const exported = await onLoopExport(module.id, cell);
      let uploaded: LoopSampleState["loops"][number];
      let savedLocally = false;
      try {
        uploaded = await uploadLoopSlot(exported, options);
      } catch {
        uploaded = await saveLocalLoopSlot(exported, options);
        savedLocally = true;
      }
      const nextSample = loopSampleWithSlot(loopSampleRef.current, uploaded);
      loopSampleRef.current = nextSample;
      onModuleSampleChange(
        module.id,
        nextSample,
        runtimeAssetForRecordedLoop(nextSample, uploaded, exported),
      );
      setMessage(`${track + 1}.${clip + 1} ${savedLocally ? "saved locally" : "saved"}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      exportingCellsRef.current.delete(cell);
    }
  }

  return (
    <ModuleShell {...props}>
      <div className="loopPanel">
        <div className="loopGridHeader" aria-hidden="true">
          <span>mon</span>
          <span>track</span>
          {clipIndexes.map((clip) => (
            <span key={clip}>clip {clip + 1}</span>
          ))}
        </div>
        <div className="loopRows">
          {trackIndexes.map((track) => (
            <section className="loopTrackRow" key={track}>
              <button
                aria-label={`monitor track ${track + 1}`}
                aria-pressed={monitorTrack === track}
                className={["loopTrackMonitor", monitorTrack === track ? "isMonitoring" : ""]
                  .filter(Boolean)
                  .join(" ")}
                type="button"
                onClick={() => toggleMonitor(track)}
              >
                mon
              </button>
              <input
                aria-label={`loop track ${track + 1} label`}
                className="loopTrackLabelInput"
                maxLength={LOOP_TRACK_LABEL_MAX_LENGTH}
                placeholder={`track ${track + 1}`}
                spellCheck={false}
                type="text"
                value={loopTrackLabel(loopText, track)}
                onChange={(event) => setTrackLabel(track, event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              />
              {clipIndexes.map((clip) => {
                const cell = cellIndex(track, clip);
                const loop = findLoop(loopSample, track, clip);
                const recording = (meters?.[METER_RECORDING_BASE + cell] ?? 0) >= 0.5;
                return (
                  <LoopClipCell
                    key={clip}
                    track={track}
                    clip={clip}
                    loop={loop}
                    meter={meters?.[METER_CELL_LEVEL_BASE + cell] ?? 0}
                    recording={recording}
                    recordBars={meters?.[METER_RECORD_BARS_BASE + cell] ?? 0}
                    playing={(meters?.[METER_PLAYING_BASE + cell] ?? 0) >= 0.5}
                    playProgress={meters?.[METER_PLAY_PHASE_BASE + cell] ?? 0}
                    playRequested={(module.params[PARAM_PLAY_BASE + cell] ?? 0) >= 0.5}
                    exporting={exportingCellsRef.current.has(cell)}
                    reverse={(module.params[PARAM_REVERSE_BASE + cell] ?? 0) >= 0.5}
                    stretch={normalizeStretch(module.params[PARAM_STRETCH_BASE + cell] ?? 1)}
                    onActivate={() => toggleCell(track, clip, loop, recording)}
                    onClear={() => clearCell(track, clip)}
                    onDragStart={() => {
                      if (loop) {
                        draggedCellRef.current = cell;
                      }
                    }}
                    onDrop={() => moveCell(track, clip)}
                    onCellParam={(base, value) => setCellParam(track, clip, base, value)}
                  />
                );
              })}
            </section>
          ))}
        </div>
        <div className="loopFooter">
          <div className="loopInputMeter" aria-label="loop input meter">
            <span>in</span>
            <MeterRow label="L" level={inputLeft} />
            <MeterRow label="R" level={inputRight} />
          </div>
          <div className="loopStatus">{message || "8 tracks / 4 clips"}</div>
        </div>
      </div>
    </ModuleShell>
  );
}

function runtimeAssetForRecordedLoop(
  sample: LoopSampleState,
  loop: LoopSampleState["loops"][number],
  exported: Awaited<ReturnType<ModuleRenderProps["onLoopExport"]>>,
): LoopRuntimeSampleAsset {
  return {
    kind: "loop",
    assetId: sample.assetId,
    loops: [
      {
        slot: cellIndex(loop.slot, loop.clip),
        clip: loop.clip,
        objectKey: loop.objectKey,
        bars: exported.bars,
        sampleRate: exported.sampleRate,
        frames: exported.frames,
        left: exported.left,
        right: exported.right,
      },
    ],
  };
}

function MeterRow({ label, level }: { label: string; level: number }) {
  return (
    <div className="loopInputMeterRow">
      <b>{label}</b>
      <i>
        <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, level))})` }} />
      </i>
    </div>
  );
}

function LoopClipCell({
  track,
  clip,
  loop,
  meter,
  recording,
  recordBars,
  playing,
  playProgress,
  playRequested,
  exporting,
  reverse,
  stretch,
  onActivate,
  onClear,
  onDragStart,
  onDrop,
  onCellParam,
}: {
  track: number;
  clip: number;
  loop: LoopSampleState["loops"][number] | undefined;
  meter: number;
  recording: boolean;
  recordBars: number;
  playing: boolean;
  playProgress: number;
  playRequested: boolean;
  exporting: boolean;
  reverse: boolean;
  stretch: 0.5 | 1 | 2;
  onActivate: () => void;
  onClear: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onCellParam: (base: number, value: number) => void;
}) {
  const hasLoop = Boolean(loop);
  const progressStyle = {
    "--loop-play-progress": playing
      ? `${Math.round(clamp01(playProgress) * 1000) / 10}%`
      : "0%",
    "--loop-meter-level": `${Math.min(1, meter) * 100}%`,
  } as CSSProperties;

  return (
    <div
      className={[
        "loopClipCell",
        hasLoop ? "hasLoop" : "",
        hasLoop ? "hasControls" : "",
        recording ? "isRecording" : "",
        playing ? "isPlaying" : "",
        playRequested && !playing ? "isArmed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={hasLoop}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDragStart={onDragStart}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      style={progressStyle}
    >
      <button
        aria-label={`${cellActionLabel(hasLoop, recording, playRequested)} ${track + 1}.${clip + 1}`}
        aria-pressed={recording || playRequested}
        className="loopClipMain"
        type="button"
        onClick={onActivate}
      >
        <span className="loopClipProgress" aria-hidden="true" />
        <span className="loopClipIcon" aria-hidden="true">
          {recording ? "rec" : playing ? "play" : hasLoop ? "play" : "rec"}
        </span>
        <span className="loopClipName">
          {exporting
            ? "saving"
            : recording
              ? `${Math.max(0, recordBars).toFixed(1)} bars`
              : loop
                ? loop.name
                : ""}
        </span>
        <span className="loopClipMeta">
          {loop ? formatLoopBars(loop) : ""}
        </span>
      </button>
      {hasLoop ? (
        <div className="loopClipControls">
          <select
            aria-label={`loop ${track + 1}.${clip + 1} playback`}
            value={loopPlaybackValue(reverse, stretch)}
            onChange={(event) => {
              const option = LOOP_PLAYBACK_OPTIONS.find(
                (candidate) => candidate.value === event.target.value,
              );
              if (!option) {
                return;
              }
              onCellParam(PARAM_REVERSE_BASE, option.reverse ? 1 : 0);
              onCellParam(PARAM_STRETCH_BASE, option.stretch);
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {LOOP_PLAYBACK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            aria-label={`delete loop ${track + 1}.${clip + 1}`}
            className="loopClipDelete"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onClear();
            }}
          >
            x
          </button>
        </div>
      ) : null}
    </div>
  );
}

function loopUploadOptions(
  module: ModuleRenderProps["module"],
  track: number,
  clip: number,
  trackLabel: string,
): LoopUploadOptions {
  const cell = cellIndex(track, clip);
  return {
    name: `${trackLabel} ${clip + 1}`.slice(0, 96),
    track,
    clip,
    reverse: (module.params[PARAM_REVERSE_BASE + cell] ?? 0) >= 0.5,
    stretch: normalizeStretch(module.params[PARAM_STRETCH_BASE + cell] ?? 1),
  };
}

function swappedCellParams(
  params: Record<number, number>,
  fromCell: number,
  toCell: number,
  swap: boolean,
) {
  const next: Record<number, number> = {};
  for (const base of [
    PARAM_RECORD_BASE,
    PARAM_PLAY_BASE,
    PARAM_REVERSE_BASE,
    PARAM_STRETCH_BASE,
  ]) {
    const fromValue = params[base + fromCell] ?? defaultCellParam(base);
    const toValue = params[base + toCell] ?? defaultCellParam(base);
    next[base + toCell] = base === PARAM_RECORD_BASE || base === PARAM_PLAY_BASE ? 0 : fromValue;
    next[base + fromCell] =
      base === PARAM_RECORD_BASE || base === PARAM_PLAY_BASE
        ? 0
        : swap
          ? toValue
          : defaultCellParam(base);
  }
  return next;
}

function defaultCellParam(base: number) {
  if (base === PARAM_STRETCH_BASE) {
    return 1;
  }
  return 0;
}

function normalizeStretch(value: number): 0.5 | 1 | 2 {
  if (value < 0.75) {
    return 0.5;
  }
  if (value > 1.5) {
    return 2;
  }
  return 1;
}

function loopPlaybackValue(reverse: boolean, stretch: 0.5 | 1 | 2) {
  return `${reverse ? "rev" : "fwd"}-${stretch}` as const;
}

function findLoop(
  sample: LoopSampleState | undefined,
  track: number,
  clip: number,
) {
  return sample?.loops.find(
    (candidate) => candidate.slot === track && candidate.clip === clip,
  );
}

function formatLoopBars(loop: LoopSampleState["loops"][number]) {
  const bars = Math.round(loop.bars);
  if (bars > 0) {
    return `${bars} ${bars === 1 ? "bar" : "bars"}`;
  }
  return "free";
}

function loopTrackLabel(text: LoopTextState | undefined, track: number) {
  return text?.slotLabels[track] ?? "";
}

function loopTrackDisplayLabel(text: LoopTextState | undefined, track: number) {
  const label = loopTrackLabel(text, track).trim();
  return label || `track ${track + 1}`;
}

function normalizeTrackLabel(label: string) {
  return label.slice(0, LOOP_TRACK_LABEL_MAX_LENGTH);
}

function cellActionLabel(hasLoop: boolean, recording: boolean, playRequested: boolean) {
  if (recording) {
    return "stop recording loop";
  }
  if (!hasLoop) {
    return "record loop";
  }
  return playRequested ? "stop loop" : "play loop";
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function cellIndex(track: number, clip: number) {
  return track * CLIPS_PER_TRACK + clip;
}

function trackForCell(cell: number) {
  return Math.floor(cell / CLIPS_PER_TRACK);
}

function clipForCell(cell: number) {
  return cell % CLIPS_PER_TRACK;
}

function defaultMonitorValue(track: number) {
  return track === 0 ? 1 : 0;
}

function selectedMonitorTrack(params: ModuleRenderProps["module"]["params"]) {
  return monitorActiveTracks(params)[0];
}

function monitorActiveTracks(params: ModuleRenderProps["module"]["params"]) {
  return trackIndexes.filter(
    (track) =>
      (params[PARAM_MONITOR_BASE + track] ?? defaultMonitorValue(track)) >= 0.5,
  );
}

function param(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
  step: number,
): ParamDefinition {
  return { id, key, label, min, max, defaultValue, step };
}
