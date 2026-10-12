import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { ModuleKnob } from "../../components/Knob";
import { KnobSections, paramById, valueForParam } from "../panelSections";
import { MODULE_KINDS } from "../kinds";
import type {
  ModuleDefinition,
  ModuleRenderProps,
  ModuleSampleSlice,
  ParamDefinition,
  SamplerRuntimeSampleAsset,
} from "../types";
import {
  DEFAULT_FACTORY_SAMPLE_BANK_ID,
  FACTORY_SAMPLE_BANKS,
  factorySampleBankById,
} from "../../sampler/factorySampleBanks";
import {
  SAMPLER_CHOP_MODES,
  chopSamplerSamples,
  DEFAULT_TRANSIENT_SENSITIVITY,
  loadFactorySampleBank,
  loadOP1SamplerPatch,
  loadSamplerRuntimeAsset,
  loadUploadedSamplerFile,
  loadedSamplerLabel,
  samplerAssetFromLoadedSample,
  samplerSampleWithSlices,
  type SamplerChopMode,
} from "../../sampler/samplerLoader";
import "./SamplerModule.css";

const PADS = 12;
const PARAM_AUDITION_BASE = 100;
const PARAM_TRANSIENT_SENSITIVITY = 3;
const AUDITION_RESET_MS = 45;
const DEFAULT_CHOP_MODE: SamplerChopMode = "beats-1";
const DEFAULT_OP1_URL =
  "https://op1.fun/users/technoprick/patches/patch-drum-18385";
const MIN_WAVE_ZOOM = 1;
const MAX_WAVE_ZOOM = 32;
const WHEEL_ZOOM_SENSITIVITY = 0.0025;

interface WaveViewport {
  zoom: number;
  scroll: number;
}

const params = [
  knob(0, "level", "level", 0, 1.4, 0.78, 0.01),
  knob(1, "pitch", "pitch", -24, 24, 0, 1),
  knob(2, "decay", "decay", 0, 1, 0.92, 0.01),
  knob(
    PARAM_TRANSIENT_SENSITIVITY,
    "sens",
    "sens",
    0,
    1,
    DEFAULT_TRANSIENT_SENSITIVITY,
    0.01,
  ),
] satisfies ParamDefinition[];

export const samplerDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.sampler,
  slug: "samp",
  name: "SAMP",
  accent: "#3f8f98",
  rackWidth: "full",
  rackUnits: 2,
  width: 716,
  minHeight: 380,
  inputs: Array.from({ length: PADS }, (_, index) => ({
    id: index,
    label: `${index + 1}`,
    kind: "gate" as const,
    connectionOrder: index,
  })),
  outputs: [
    { id: 0, label: "mix", kind: "audio" },
    ...Array.from({ length: PADS }, (_, index) => ({
      id: index + 1,
      label: `${index + 1}`,
      kind: "audio" as const,
      connectionOrder: index,
    })),
  ],
  params,
  Component: SamplerModule,
};

function SamplerModule(props: ModuleRenderProps) {
  const {
    module,
    definition,
    onParamChange,
    onRuntimeParamChange,
    onModuleSampleChange,
    tempoBpm,
  } = props;
  const samplerSample =
    module.sample?.kind === "sampler" || module.sample?.kind === "op1-drum"
      ? module.sample
      : undefined;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [bankId, setBankId] = useState(
    samplerSample?.kind === "sampler" && samplerSample.bankId
      ? samplerSample.bankId
      : DEFAULT_FACTORY_SAMPLE_BANK_ID,
  );
  const [op1Url, setOp1Url] = useState(
    samplerSample?.sourceUrl?.includes("op1.fun")
      ? samplerSample.sourceUrl
      : DEFAULT_OP1_URL,
  );
  const [chopMode, setChopMode] = useState<SamplerChopMode>(
    validChopMode(samplerSample?.kind === "sampler" ? samplerSample.chopMode : undefined),
  );
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    samplerSample ? "ready" : "idle",
  );
  const [message, setMessage] = useState(samplerSample?.name ?? "");
  const [previewAsset, setPreviewAsset] =
    useState<SamplerRuntimeSampleAsset | null>(null);
  const [selectedSliceIndex, setSelectedSliceIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [scroll, setScroll] = useState(0);
  const [draggingFile, setDraggingFile] = useState(false);
  const transientSensitivity =
    module.params[PARAM_TRANSIENT_SENSITIVITY] ?? DEFAULT_TRANSIENT_SENSITIVITY;
  const transientSensitivityParam = paramById(
    PARAM_TRANSIENT_SENSITIVITY,
    definition,
  );

  useEffect(() => {
    if (!samplerSample) {
      return;
    }
    if (
      samplerSample.kind === "sampler" &&
      samplerSample.sourceType === "factory" &&
      samplerSample.bankId &&
      samplerSample.bankId !== bankId
    ) {
      setBankId(samplerSample.bankId);
    }
    if (
      samplerSample.sourceUrl.includes("op1.fun") &&
      samplerSample.sourceUrl !== op1Url
    ) {
      setOp1Url(samplerSample.sourceUrl);
    }
    if (samplerSample.kind === "sampler") {
      setChopMode(validChopMode(samplerSample.chopMode));
    }
    setStatus("ready");
    setMessage(samplerSample.name);
  }, [samplerSample?.assetId]);

  useEffect(() => {
    if (!samplerSample || previewAsset?.assetId === samplerSample.assetId) {
      return;
    }
    let cancelled = false;
    setStatus((current) => (current === "error" ? current : "loading"));
    void loadSamplerRuntimeAsset(samplerSample)
      .then((asset) => {
        if (cancelled) {
          return;
        }
        setPreviewAsset(asset);
        setStatus("ready");
        setMessage(samplerSample.name);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [previewAsset?.assetId, samplerSample?.assetId]);

  useEffect(() => {
    if (!samplerSample) {
      setPreviewAsset(null);
      setSelectedSliceIndex(0);
      setStatus("idle");
      setMessage("");
      updateWaveViewport({ zoom: MIN_WAVE_ZOOM, scroll: 0 });
    }
  }, [samplerSample?.assetId]);

  useEffect(() => {
    const sliceCount = samplerSample?.slices.length ?? 0;
    if (sliceCount === 0) {
      setSelectedSliceIndex(0);
    } else if (selectedSliceIndex >= sliceCount) {
      setSelectedSliceIndex(sliceCount - 1);
    }
  }, [samplerSample?.slices.length, selectedSliceIndex]);

  const loadFactoryBank = useCallback(
    async (nextBankId = bankId) => {
      const bank = factorySampleBankById(nextBankId);
      setStatus("loading");
      setMessage(`loading ${bank?.shortName ?? nextBankId}`);
      try {
        const loaded = await loadFactorySampleBank(nextBankId);
        onModuleSampleChange(module.id, loaded.sample, loaded.asset);
        setPreviewAsset(loaded.asset);
        setBankId(loaded.sample.bankId ?? nextBankId);
        setSelectedSliceIndex(0);
        setStatus("ready");
        setMessage(loaded.sample.name);
      } catch (error) {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [bankId, module.id, onModuleSampleChange],
  );

  async function loadOP1Patch() {
    const trimmed = op1Url.trim();
    if (!trimmed) {
      return;
    }
    setStatus("loading");
    setMessage("loading op1.fun");
    try {
      const loaded = await loadOP1SamplerPatch(trimmed);
      onModuleSampleChange(module.id, loaded.sample, loaded.asset);
      setPreviewAsset(loaded.asset);
      setOp1Url(loaded.sample.sourceUrl);
      setSelectedSliceIndex(0);
      setStatus("ready");
      setMessage(loaded.sample.name);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadFile(file: File | undefined) {
    if (!file) {
      return;
    }
    setStatus("loading");
    setMessage(`decoding ${file.name}`);
    try {
      await nextPaintFrame();
      const loaded = await loadUploadedSamplerFile(
        file,
        chopMode,
        tempoBpm,
        transientSensitivity,
      );
      onModuleSampleChange(module.id, loaded.sample, loaded.asset);
      setPreviewAsset(loaded.asset);
      setSelectedSliceIndex(0);
      setStatus("ready");
      setMessage(loaded.sample.name);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function auditionSlice(index: number) {
    if (!samplerSample?.slices[index]) {
      return;
    }
    const paramId = PARAM_AUDITION_BASE + index;
    onRuntimeParamChange(module.id, paramId, 1);
    window.setTimeout(() => {
      onRuntimeParamChange(module.id, paramId, 0);
    }, AUDITION_RESET_MS);
  }

  function commitSlices(
    slices: ModuleSampleSlice[],
    nextChopMode: SamplerChopMode = chopMode,
  ) {
    if (!samplerSample) {
      return;
    }
    const nextSample = samplerSampleWithSlices(samplerSample, slices, nextChopMode);
    const nextAsset = previewAsset
      ? samplerAssetFromLoadedSample(nextSample, previewAsset)
      : undefined;
    if (nextAsset) {
      setPreviewAsset(nextAsset);
    }
    onModuleSampleChange(module.id, nextSample, nextAsset);
  }

  function rechopSample() {
    if (!previewAsset || !samplerSample) {
      return;
    }
    const slices = chopSamplerSamples(
      previewAsset.samples,
      previewAsset.sampleRate,
      chopMode,
      tempoBpm,
      samplerSample.slices,
      transientSensitivity,
    );
    setSelectedSliceIndex(0);
    commitSlices(slices, chopMode);
  }

  function clearSample() {
    onModuleSampleChange(module.id, undefined);
    setPreviewAsset(null);
    setSelectedSliceIndex(0);
    setStatus("idle");
    setMessage("");
    updateWaveViewport({ zoom: MIN_WAVE_ZOOM, scroll: 0 });
  }

  function updateSelectedOutput(output: number) {
    if (!samplerSample) {
      return;
    }
    const slices = samplerSample.slices.map((slice, index) =>
      index === selectedSliceIndex ? { ...slice, output } : slice,
    );
    commitSlices(slices);
  }

  function updateSelectedBoundary(edge: "start" | "end", milliseconds: number) {
    if (!samplerSample || !previewAsset || !Number.isFinite(milliseconds)) {
      return;
    }
    const frame = Math.round((milliseconds / 1000) * previewAsset.sampleRate);
    const slices = moveSliceBoundary(
      samplerSample.slices,
      selectedSliceIndex,
      edge,
      frame,
      previewAsset.frames,
    );
    commitSlices(slices);
  }

  function updateWaveViewport(viewport: WaveViewport) {
    const nextZoom = clamp(viewport.zoom, MIN_WAVE_ZOOM, MAX_WAVE_ZOOM);
    setZoom(nextZoom);
    setScroll(nextZoom <= MIN_WAVE_ZOOM ? 0 : clamp01(viewport.scroll));
  }

  const loadedBank =
    samplerSample?.kind === "sampler" && samplerSample.bankId
      ? factorySampleBankById(samplerSample.bankId)
      : undefined;
  const statusText =
    loadedSamplerLabel(samplerSample) ||
    message ||
    "choose a bank, op1.fun patch, or audio file";
  const selectedSlice = samplerSample?.slices[selectedSliceIndex];
  const selectedStartMs =
    selectedSlice && previewAsset
      ? frameToMilliseconds(selectedSlice.startFrame, previewAsset.sampleRate)
      : 0;
  const selectedEndMs =
    selectedSlice && previewAsset
      ? frameToMilliseconds(selectedSlice.endFrame, previewAsset.sampleRate)
      : 0;
  const selectedDuration =
    selectedSlice && previewAsset
      ? `${((selectedSlice.endFrame - selectedSlice.startFrame) / previewAsset.sampleRate).toFixed(2)}s`
      : "--";

  return (
    <ModuleShell {...props}>
      <div
        className={`samplerPanel ${draggingFile ? "isDraggingFile" : ""} ${
          status === "loading" ? "isLoadingSample" : ""
        }`}
        aria-busy={status === "loading"}
        onDragEnter={(event) => {
          event.preventDefault();
          setDraggingFile(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) {
            setDraggingFile(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDraggingFile(false);
          void loadFile(Array.from(event.dataTransfer.files).find(isAudioFile));
        }}
      >
        <div
          className={`samplerToolbar ${
            samplerSample ? "samplerToolbar-loaded" : "samplerToolbar-empty"
          }`}
        >
          {!samplerSample ? (
            <>
              <div className="samplerBankRow">
                <select
                  aria-label="sample bank"
                  value={bankId}
                  disabled={status === "loading"}
                  onChange={(event) => setBankId(event.target.value)}
                >
                  {FACTORY_SAMPLE_BANKS.map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={status === "loading"}
                  onClick={() => void loadFactoryBank()}
                >
                  bank
                </button>
              </div>
              <div className="samplerLoadRow">
                <input
                  aria-label="op1.fun drum patch URL"
                  type="url"
                  value={op1Url}
                  onChange={(event) => setOp1Url(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      void loadOP1Patch();
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={status === "loading"}
                  onClick={() => void loadOP1Patch()}
                >
                  op1.fun
                </button>
              </div>
              <button
                type="button"
                className="samplerFileButton"
                disabled={status === "loading"}
                onClick={() => fileInputRef.current?.click()}
              >
                file
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="samplerClearButton"
                disabled={status === "loading"}
                onClick={clearSample}
              >
                clear
              </button>
              <div className="samplerChopControls">
                <label className="samplerChopMode">
                  <span>mode</span>
                  <select
                    value={chopMode}
                    disabled={status === "loading"}
                    onChange={(event) =>
                      setChopMode(event.target.value as SamplerChopMode)
                    }
                  >
                    {SAMPLER_CHOP_MODES.map((mode) => (
                      <option key={mode.value} value={mode.value}>
                        {mode.label}
                      </option>
                    ))}
                  </select>
                </label>
                <ModuleKnob
                  definition={definition}
                  param={transientSensitivityParam}
                  value={valueForParam(module.params, transientSensitivityParam)}
                  onChange={(value) =>
                    onParamChange(module.id, PARAM_TRANSIENT_SENSITIVITY, value)
                  }
                  className="samplerSensitivityKnob"
                />
                <button
                  type="button"
                  className="samplerChopButton"
                  disabled={status === "loading" || !previewAsset}
                  onClick={rechopSample}
                >
                  chop
                </button>
              </div>
            </>
          )}
          <input
            ref={fileInputRef}
            className="samplerFileInput"
            type="file"
            accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg"
            onChange={(event) => {
              void loadFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>

        <div className="samplerWavePanel">
          <div className="samplerWaveHeader">
            <div className={`samplerStatus samplerStatus-${status}`}>
              <span>{statusText}</span>
              <span>
                {loadedBank
                  ? `${loadedBank.sourceName} / ${loadedBank.license}`
                  : samplerSample?.kind === "sampler" &&
                      samplerSample.sourceType === "upload"
                    ? "uploaded loop sample"
                    : samplerSample?.kind === "sampler" &&
                        samplerSample.sourceType === "op1.fun"
                      ? "op1.fun drum patch"
                      : message}
              </span>
            </div>
            <label>
              <span>zoom</span>
              <input
                type="range"
                min={1}
                max={32}
                step={0.1}
                value={zoom}
                onChange={(event) =>
                  updateWaveViewport({
                    zoom: Number(event.target.value),
                    scroll,
                  })
                }
              />
            </label>
            <label>
              <span>scroll</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={zoom <= 1 ? 0 : scroll}
                disabled={zoom <= 1}
                onChange={(event) =>
                  updateWaveViewport({
                    zoom,
                    scroll: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <SamplerWaveform
            asset={previewAsset}
            slices={samplerSample?.slices ?? []}
            selectedSliceIndex={selectedSliceIndex}
            zoom={zoom}
            scroll={scroll}
            statusText={status === "loading" ? message : "drop audio file"}
            onSelect={setSelectedSliceIndex}
            onCommitSlices={commitSlices}
            onViewportChange={updateWaveViewport}
          />
        </div>

        <div className="samplerBottom">
          <div className="samplerSliceStrip" aria-label="sample chops">
            {(samplerSample?.slices ?? []).map((slice, index) => (
              <button
                type="button"
                key={slice.index}
                className={index === selectedSliceIndex ? "isSelected" : ""}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setSelectedSliceIndex(index)}
                onDoubleClick={() => auditionSlice(index)}
              >
                <span>{index + 1}</span>
                <small>{(slice.output ?? index % PADS) + 1}</small>
              </button>
            ))}
          </div>
          <div className="samplerSliceEditor">
            <div className="samplerEditorTitle">
              <span>chop {selectedSlice ? selectedSliceIndex + 1 : "--"}</span>
              <strong>{selectedDuration}</strong>
            </div>
            <label>
              <span>out</span>
              <select
                value={selectedSlice?.output ?? selectedSliceIndex % PADS}
                disabled={!selectedSlice}
                onChange={(event) => updateSelectedOutput(Number(event.target.value))}
              >
                {Array.from({ length: PADS }, (_, index) => (
                  <option key={index} value={index}>
                    {index + 1}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>start ms</span>
              <input
                type="number"
                min={0}
                step={1}
                value={selectedStartMs}
                disabled={!selectedSlice}
                onChange={(event) =>
                  updateSelectedBoundary("start", Number(event.target.value))
                }
              />
            </label>
            <label>
              <span>end ms</span>
              <input
                type="number"
                min={0}
                step={1}
                value={selectedEndMs}
                disabled={!selectedSlice}
                onChange={(event) =>
                  updateSelectedBoundary("end", Number(event.target.value))
                }
              />
            </label>
            <button
              type="button"
              disabled={!selectedSlice}
              onClick={() => auditionSlice(selectedSliceIndex)}
            >
              audition
            </button>
          </div>
          <KnobSections
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            className="samplerControls"
            sections={[{ title: "playback", paramIds: [0, 1, 2] }]}
          />
        </div>
        {status === "loading" ? (
          <div className="samplerLoadingOverlay" aria-live="polite">
            <span>{message || "loading sample"}</span>
          </div>
        ) : null}
      </div>
    </ModuleShell>
  );
}

function SamplerWaveform({
  asset,
  slices,
  selectedSliceIndex,
  zoom,
  scroll,
  statusText,
  onSelect,
  onCommitSlices,
  onViewportChange,
}: {
  asset: SamplerRuntimeSampleAsset | null;
  slices: ModuleSampleSlice[];
  selectedSliceIndex: number;
  zoom: number;
  scroll: number;
  statusText: string;
  onSelect: (index: number) => void;
  onCommitSlices: (slices: ModuleSampleSlice[]) => void;
  onViewportChange: (viewport: WaveViewport) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [draftSlices, setDraftSlices] = useState<ModuleSampleSlice[] | null>(
    null,
  );
  const [dragMarkerIndex, setDragMarkerIndex] = useState<number | null>(null);
  const displaySlices = draftSlices ?? slices;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    drawWaveform(
      canvas,
      asset,
      displaySlices,
      selectedSliceIndex,
      zoom,
      scroll,
      statusText,
    );
  }, [asset, displaySlices, selectedSliceIndex, zoom, scroll, statusText]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (!event.metaKey || !asset || asset.frames <= 1) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const rect = canvas.getBoundingClientRect();
      const focusProgress = clamp(
        (event.clientX - rect.left) / Math.max(1, rect.width),
        0,
        1,
      );
      const currentZoom = clamp(zoom, MIN_WAVE_ZOOM, MAX_WAVE_ZOOM);
      const currentScroll = currentZoom <= MIN_WAVE_ZOOM ? 0 : clamp01(scroll);
      const range = visibleFrameRange(asset.frames, currentZoom, currentScroll);
      const visibleFrames = Math.max(1, range.end - range.start);
      const maxStart = Math.max(0, asset.frames - visibleFrames);

      if (
        currentZoom > MIN_WAVE_ZOOM &&
        (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey)
      ) {
        const panDelta = event.shiftKey ? event.deltaY : event.deltaX;
        const deltaFrames = (panDelta / Math.max(1, rect.width)) * visibleFrames;
        const nextStart = clamp(range.start + deltaFrames, 0, maxStart);
        onViewportChange({
          zoom: currentZoom,
          scroll: maxStart <= 0 ? 0 : nextStart / maxStart,
        });
        return;
      }

      const focusFrame = range.start + focusProgress * visibleFrames;
      const nextZoom = clamp(
        currentZoom * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY),
        MIN_WAVE_ZOOM,
        MAX_WAVE_ZOOM,
      );
      const nextVisibleFrames = Math.max(1, Math.round(asset.frames / nextZoom));
      const nextMaxStart = Math.max(0, asset.frames - nextVisibleFrames);
      const nextStart = clamp(
        focusFrame - focusProgress * nextVisibleFrames,
        0,
        nextMaxStart,
      );
      onViewportChange({
        zoom: nextZoom,
        scroll: nextMaxStart <= 0 ? 0 : nextStart / nextMaxStart,
      });
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, [asset, onViewportChange, scroll, zoom]);

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.stopPropagation();
    if (!asset || displaySlices.length === 0) {
      return;
    }
    const frame = eventFrame(event, asset.frames, zoom, scroll);
    const marker = nearestMarker(event, asset.frames, displaySlices, zoom, scroll);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (marker !== null) {
      setDragMarkerIndex(marker);
      setDraftSlices(displaySlices);
      return;
    }
    onSelect(sliceIndexAtFrame(displaySlices, frame));
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!asset || dragMarkerIndex === null || !draftSlices) {
      return;
    }
    event.stopPropagation();
    const frame = eventFrame(event, asset.frames, zoom, scroll);
    setDraftSlices(moveInternalMarker(draftSlices, dragMarkerIndex, frame, asset.frames));
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.stopPropagation();
    if (draftSlices) {
      onCommitSlices(draftSlices);
    }
    setDraftSlices(null);
    setDragMarkerIndex(null);
  }

  return (
    <canvas
      ref={canvasRef}
      className="samplerWaveCanvas"
      width={1200}
      height={220}
      aria-label="sampler waveform and chop markers"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  asset: SamplerRuntimeSampleAsset | null,
  slices: ModuleSampleSlice[],
  selectedSliceIndex: number,
  zoom: number,
  scroll: number,
  statusText: string,
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
  context.fillStyle = "#070c0c";
  context.fillRect(0, 0, width, height);

  drawWaveGrid(context, width, height);
  if (!asset || asset.samples.length === 0) {
    context.fillStyle = "rgba(211, 224, 221, 0.42)";
    context.font = "11px SFMono-Regular, Consolas, monospace";
    context.textAlign = "center";
    context.fillText(statusText.toUpperCase(), width / 2, height / 2 + 4);
    return;
  }

  const range = visibleFrameRange(asset.frames, zoom, scroll);
  const frameToX = (frame: number) =>
    ((frame - range.start) / Math.max(1, range.end - range.start)) * width;
  const selectedSlice = slices[selectedSliceIndex];
  if (selectedSlice) {
    const left = Math.max(0, Math.min(width, frameToX(selectedSlice.startFrame)));
    const right = Math.max(0, Math.min(width, frameToX(selectedSlice.endFrame)));
    context.fillStyle = "rgba(63, 143, 152, 0.18)";
    context.fillRect(left, 0, Math.max(1, right - left), height);
  }

  context.strokeStyle = "rgba(126, 231, 210, 0.92)";
  context.lineWidth = 1;
  context.beginPath();
  const centerY = height / 2;
  const scale = height * 0.45;
  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(range.start + (x / width) * (range.end - range.start));
    const end = Math.max(
      start + 1,
      Math.floor(range.start + ((x + 1) / width) * (range.end - range.start)),
    );
    let min = 0;
    let max = 0;
    for (let frame = start; frame < end; frame += 1) {
      const sample = asset.samples[frame] ?? 0;
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }
    context.moveTo(x + 0.5, centerY - max * scale);
    context.lineTo(x + 0.5, centerY - min * scale);
  }
  context.stroke();

  for (const [index, slice] of slices.entries()) {
    const x = frameToX(slice.startFrame);
    if (x < -2 || x > width + 2) {
      continue;
    }
    const selected = index === selectedSliceIndex;
    context.strokeStyle = selected
      ? "rgba(238, 255, 249, 0.95)"
      : "rgba(63, 143, 152, 0.86)";
    context.lineWidth = selected ? 2 : 1;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
    if (index > 0) {
      context.fillStyle = selected
        ? "rgba(238, 255, 249, 0.95)"
        : "rgba(63, 143, 152, 0.9)";
      context.fillRect(x - 3, 0, 6, 12);
    }
  }
}

function drawWaveGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  context.strokeStyle = "rgba(142, 178, 174, 0.12)";
  context.lineWidth = 1;
  context.beginPath();
  for (let x = 0; x <= width; x += width / 16) {
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += height / 4) {
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
  context.strokeStyle = "rgba(142, 178, 174, 0.25)";
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();
}

function moveInternalMarker(
  slices: ModuleSampleSlice[],
  markerIndex: number,
  frame: number,
  frames: number,
) {
  if (markerIndex <= 0 || markerIndex >= slices.length) {
    return slices;
  }
  const next = slices.map((slice) => ({ ...slice }));
  const previous = next[markerIndex - 1];
  const current = next[markerIndex];
  const minFrame = previous.startFrame + 1;
  const maxFrame = Math.min(current.endFrame - 1, frames - 1);
  const nextFrame = Math.max(minFrame, Math.min(maxFrame, Math.round(frame)));
  previous.endFrame = nextFrame;
  current.startFrame = nextFrame;
  return next;
}

function moveSliceBoundary(
  slices: ModuleSampleSlice[],
  sliceIndex: number,
  edge: "start" | "end",
  frame: number,
  frames: number,
) {
  if (!slices[sliceIndex]) {
    return slices;
  }
  if (edge === "start") {
    return moveInternalMarker(slices, sliceIndex, frame, frames);
  }
  return moveInternalMarker(slices, sliceIndex + 1, frame, frames);
}

function eventFrame(
  event: ReactPointerEvent<HTMLCanvasElement>,
  frames: number,
  zoom: number,
  scroll: number,
) {
  const rect = event.currentTarget.getBoundingClientRect();
  const range = visibleFrameRange(frames, zoom, scroll);
  const progress = (event.clientX - rect.left) / Math.max(1, rect.width);
  return range.start + progress * (range.end - range.start);
}

function nearestMarker(
  event: ReactPointerEvent<HTMLCanvasElement>,
  frames: number,
  slices: ModuleSampleSlice[],
  zoom: number,
  scroll: number,
) {
  const rect = event.currentTarget.getBoundingClientRect();
  const range = visibleFrameRange(frames, zoom, scroll);
  const xForFrame = (frame: number) =>
    rect.left + ((frame - range.start) / Math.max(1, range.end - range.start)) * rect.width;
  let best: { index: number; distance: number } | null = null;
  for (let index = 1; index < slices.length; index += 1) {
    const distance = Math.abs(event.clientX - xForFrame(slices[index].startFrame));
    if (distance <= 10 && (!best || distance < best.distance)) {
      best = { index, distance };
    }
  }
  return best?.index ?? null;
}

function visibleFrameRange(frames: number, zoom: number, scroll: number) {
  const safeZoom = Math.max(1, zoom);
  const visibleFrames = Math.max(1, Math.round(frames / safeZoom));
  const maxStart = Math.max(0, frames - visibleFrames);
  const start = Math.round(maxStart * Math.max(0, Math.min(1, scroll)));
  return { start, end: Math.min(frames, start + visibleFrames) };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}

function nextPaintFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function sliceIndexAtFrame(slices: ModuleSampleSlice[], frame: number) {
  return Math.max(
    0,
    slices.findIndex(
      (slice) => frame >= slice.startFrame && frame < slice.endFrame,
    ),
  );
}

function frameToMilliseconds(frame: number, sampleRate: number) {
  return Math.max(0, Math.round((frame / Math.max(1, sampleRate)) * 1000));
}

function isAudioFile(file: File) {
  return file.type.startsWith("audio/") || /\.(wav|aif|aiff|mp3|m4a|flac|ogg)$/i.test(file.name);
}

function validChopMode(value: string | undefined): SamplerChopMode {
  return SAMPLER_CHOP_MODES.some((mode) => mode.value === value)
    ? (value as SamplerChopMode)
    : DEFAULT_CHOP_MODE;
}

function knob(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
  step: number,
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue };
}
