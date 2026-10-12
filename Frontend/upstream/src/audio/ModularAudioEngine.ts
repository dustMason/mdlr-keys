import type {
  LoopExport,
  ModuleRuntimeSampleAsset,
  ModuleTextState,
  PatchCable,
  RackModuleState,
} from "../modules/types";
import { definitionForKind } from "../modules/registry";

const AUDIO_ENGINE_ASSET_VERSION = "loop-send-return-v1";

interface GraphModuleMessage {
  id: number;
  kind: number;
  audioOutputs: number[];
  params: GraphParamMessage[];
  text?: GraphModuleTextMessage;
  samplerAsset?: GraphSamplerAssetMessage;
}

interface GraphModuleTextMessage {
  kind: "choir";
  phrases: string[];
}

interface GraphSamplerAssetMessage {
  kind?: "sampler" | "op1-drum" | "loop";
  assetId: string;
  sampleRate?: number;
  frames?: number;
  samples?: Float32Array;
  slices?: {
    index: number;
    startFrame: number;
    endFrame: number;
    output?: number;
  }[];
  loops?: {
    slot: number;
    objectKey: string;
    bars: number;
    sampleRate: number;
    frames: number;
    left: Float32Array;
    right: Float32Array;
  }[];
}

interface GraphParamMessage {
  id: number;
  type: "float";
  value: number;
}

interface RuntimeFloatParam {
  moduleId: number;
  moduleKind: number;
  paramId: number;
  value: number;
}

interface GraphCableMessage {
  fromModule: number;
  fromJack: number;
  toModule: number;
  toJack: number;
}

interface GraphSnapshot {
  modules: GraphModuleMessage[];
  cables: GraphCableMessage[];
  tempoBpm: number;
}

export interface AudioEngineStats {
  contextState: AudioContextState | "none";
  workletReady: boolean;
  audioInputActive: boolean;
  audioInputDeviceLabel: string;
  sampleRate: number;
  baseLatencyMs: number;
  outputLatencyMs: number;
  graphVersion: number;
  graphModules: number;
  graphCables: number;
  graphParams: number;
  blocksPerSecond: number;
  renderedFrames: number;
  peak: number;
  processAvgMs: number;
  processMaxMs: number;
  renderAvgMs: number;
  renderMaxMs: number;
  renderBudgetMs: number;
  lateBlocks: number;
  callbackGapMaxMs: number;
  silentBlocks: number;
  graphSyncs: number;
  graphSyncMs: number;
  graphSyncMaxMs: number;
  lastRenderStatsAtMs: number;
  lastError: string | null;
}

export interface ScopeSnapshot {
  moduleId: number;
  left: Float32Array;
  right: Float32Array;
}

export interface MixerMeterSnapshot {
  moduleId: number;
  levels: Float32Array;
}

export interface ModuleLevelSnapshot {
  moduleId: number;
  level: number;
}

export interface TransportStepSnapshot {
  step: number;
  absoluteStep: number;
  position: number;
}

export const emptyAudioEngineStats: AudioEngineStats = {
  contextState: "none",
  workletReady: false,
  audioInputActive: false,
  audioInputDeviceLabel: "",
  sampleRate: 0,
  baseLatencyMs: 0,
  outputLatencyMs: 0,
  graphVersion: 0,
  graphModules: 0,
  graphCables: 0,
  graphParams: 0,
  blocksPerSecond: 0,
  renderedFrames: 0,
  peak: 0,
  processAvgMs: 0,
  processMaxMs: 0,
  renderAvgMs: 0,
  renderMaxMs: 0,
  renderBudgetMs: 0,
  lateBlocks: 0,
  callbackGapMaxMs: 0,
  silentBlocks: 0,
  graphSyncs: 0,
  graphSyncMs: 0,
  graphSyncMaxMs: 0,
  lastRenderStatsAtMs: 0,
  lastError: null,
};

export class ModularAudioEngine {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private inputStream: MediaStream | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputDeviceId = "";
  private inputDeviceLabel = "";
  private snapshot: GraphSnapshot | null = null;
  private stats: AudioEngineStats = emptyAudioEngineStats;
  private statsListener: ((stats: AudioEngineStats) => void) | null = null;
  private scopeListener: ((snapshots: ScopeSnapshot[]) => void) | null = null;
  private mixerMeterListener: ((meters: MixerMeterSnapshot[]) => void) | null = null;
  private moduleLevelListener:
    | ((levels: ModuleLevelSnapshot[]) => void)
    | null = null;
  private transportStepListener:
    | ((snapshot: TransportStepSnapshot) => void)
    | null = null;
  private loopExportRequests = new Map<
    string,
    {
      resolve: (exported: LoopExport) => void;
      reject: (error: Error) => void;
    }
  >();
  private runtimeFloatParams = new Map<string, RuntimeFloatParam>();
  private pendingFloatParams = new Map<string, Omit<RuntimeFloatParam, "moduleKind">>();
  private pendingFloatParamFlush = false;
  private postedFloatParams = new Map<string, number>();
  private postedTextSignatures = new Map<number, string>();
  private postedTempoBpm: number | null = null;
  private postedGraphSignature = "";
  private started = false;
  private exportRequestSequence = 0;

  async start({ resetTransport = false }: { resetTransport?: boolean } = {}) {
    if (this.context && this.node) {
      if (resetTransport) {
        this.resetTransport();
      }
      await this.context.resume();
      this.started = true;
      this.updateContextStats();
      this.armTransportStep();
      return;
    }

    const context = new AudioContext({ latencyHint: "interactive" });
    const assetVersion = `${AUDIO_ENGINE_ASSET_VERSION}-${Date.now().toString(36)}`;
    const [wasmBytes] = await Promise.all([
      fetch(`/modular_engine.wasm?v=${assetVersion}`).then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load WASM engine: ${response.status}`);
        }
        return response.arrayBuffer();
      }),
      context.audioWorklet.addModule(`/modular-worklet.js?v=${assetVersion}`),
    ]);

    const node = new AudioWorkletNode(context, "modular-engine", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 4,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
      processorOptions: {
        wasmBytes,
      },
    });

    node.port.onmessage = (event) => {
      if (event.data.type === "error") {
        console.error("Audio worklet error", event.data.message);
        this.updateStats({ lastError: event.data.message });
      } else if (event.data.type === "ready") {
        this.updateStats({ workletReady: true });
      } else if (event.data.type === "graphStats") {
        this.updateStats({
          graphVersion: event.data.graphVersion,
          graphModules: event.data.graphModules,
          graphCables: event.data.graphCables,
          graphSyncMs: finiteNumber(event.data.graphSyncMs),
          graphSyncMaxMs: finiteNumber(event.data.graphSyncMaxMs),
        });
      } else if (event.data.type === "renderStats") {
        this.updateStats({
          blocksPerSecond: event.data.blocksPerSecond,
          renderedFrames: event.data.renderedFrames,
          peak: event.data.peak,
          graphVersion: event.data.graphVersion,
          graphModules: event.data.graphModules,
          graphCables: event.data.graphCables,
          processAvgMs: finiteNumber(event.data.processAvgMs),
          processMaxMs: finiteNumber(event.data.processMaxMs),
          renderAvgMs: finiteNumber(event.data.renderAvgMs),
          renderMaxMs: finiteNumber(event.data.renderMaxMs),
          renderBudgetMs: finiteNumber(event.data.renderBudgetMs),
          lateBlocks: finiteNumber(event.data.lateBlocks),
          callbackGapMaxMs: finiteNumber(event.data.callbackGapMaxMs),
          silentBlocks: finiteNumber(event.data.silentBlocks),
          graphSyncs: finiteNumber(event.data.graphSyncs),
          graphSyncMs: finiteNumber(event.data.graphSyncMs),
          graphSyncMaxMs: finiteNumber(event.data.graphSyncMaxMs),
          lastRenderStatsAtMs: performance.now(),
        });
      } else if (event.data.type === "scopeData") {
        this.scopeListener?.(event.data.snapshots);
      } else if (event.data.type === "mixerMeters") {
        this.mixerMeterListener?.(event.data.meters);
      } else if (event.data.type === "moduleLevels") {
        this.moduleLevelListener?.(event.data.levels);
      } else if (event.data.type === "transportStep") {
        this.transportStepListener?.({
          step: event.data.step,
          absoluteStep: event.data.absoluteStep,
          position: event.data.position,
        });
      } else if (event.data.type === "loopExport") {
        this.resolveLoopExport(event.data);
      } else if (event.data.type === "loopExportError") {
        this.rejectLoopExport(event.data.requestId, event.data.message);
      }
    };

    node.connect(context.destination);
    context.onstatechange = () => this.updateContextStats();
    this.context = context;
    this.node = node;
    this.started = true;
    this.updateContextStats();

    if (this.snapshot) {
      this.postGraph(this.snapshot);
    }

    if (resetTransport) {
      this.resetTransport();
    }

    await context.resume();
    this.updateContextStats();
    this.armTransportStep();
  }

  async stop({ resetTransport = false }: { resetTransport?: boolean } = {}) {
    if (!this.context) {
      this.started = false;
      this.updateContextStats();
      return;
    }

    if (resetTransport) {
      this.resetTransport();
    }
    await this.context.suspend();
    this.started = false;
    this.updateContextStats();
  }

  isStarted() {
    return this.started;
  }

  async listAudioInputDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return [] as MediaDeviceInfo[];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput");
  }

  async enableAudioInput(deviceId = "") {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Audio input is not supported in this browser.");
    }

    await this.start();
    if (this.inputStream && this.inputDeviceId === deviceId) {
      return;
    }

    this.disconnectAudioInput();
    const audio: MediaTrackConstraints = {
      channelCount: { ideal: 4 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    (audio as MediaTrackConstraints & { latency?: { ideal: number } }).latency = {
      ideal: 0,
    };
    if (deviceId) {
      audio.deviceId = { exact: deviceId };
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (!this.context || !this.node) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      throw new Error("Audio engine is not ready.");
    }

    const source = this.context.createMediaStreamSource(stream);
    source.connect(this.node);
    this.inputStream = stream;
    this.inputSource = source;
    this.inputDeviceId = deviceId;
    this.inputDeviceLabel = stream.getAudioTracks()[0]?.label ?? "";
    this.updateStats({
      audioInputActive: true,
      audioInputDeviceLabel: this.inputDeviceLabel,
    });
  }

  disableAudioInput() {
    this.disconnectAudioInput();
    this.updateStats({
      audioInputActive: false,
      audioInputDeviceLabel: "",
    });
  }

  isAudioInputActive() {
    return this.inputStream !== null;
  }

  getAudioInputDeviceId() {
    return this.inputDeviceId;
  }

  syncRack(
    modules: RackModuleState[],
    cables: PatchCable[],
    tempoBpm: number,
    sampleAssets: Map<string, ModuleRuntimeSampleAsset> = new Map(),
  ) {
    const modulesById = new Map(modules.map((module) => [module.id, module]));
    const validCables = cables.filter((cable) =>
      cableEndpointMatchesDefinition(cable.from, modulesById) &&
      cableEndpointMatchesDefinition(cable.to, modulesById),
    );
    const snapshot: GraphSnapshot = {
      tempoBpm,
      modules: modules.map((module) => {
        const samplerAsset = module.sample
          ? sampleAssets.get(module.sample.assetId)
          : undefined;
        const definition = definitionForKind(module.kind);
        const paramIds = new Set(definition.params.map((param) => param.id));
        return {
          id: module.id,
          kind: module.kind,
          audioOutputs: definition.outputs
            .filter((output) => output.kind === "audio")
            .map((output) => output.id),
          params: Object.entries(module.params)
            .filter(([paramId]) => paramIds.has(Number(paramId)))
            .map(([paramId, value]) => ({
              id: Number(paramId),
              type: "float" as const,
              value,
            })),
          samplerAsset: samplerAsset
            ? samplerAsset.kind === "loop"
              ? {
                  kind: "loop" as const,
                  assetId: samplerAsset.assetId,
                  loops: samplerAsset.loops.map((loop) => ({
                    slot: loop.slot,
                    objectKey: loop.objectKey,
                    bars: loop.bars,
                    sampleRate: loop.sampleRate,
                    frames: loop.frames,
                    left: loop.left,
                    right: loop.right,
                  })),
                }
              : {
                  kind: samplerAsset.kind ?? ("sampler" as const),
                  assetId: samplerAsset.assetId,
                  sampleRate: samplerAsset.sampleRate,
                  frames: samplerAsset.frames,
                  samples: samplerAsset.samples,
                  slices: samplerAsset.slices,
                }
            : undefined,
        };
      }),
      cables: validCables.map((cable) => ({
        fromModule: cable.from.moduleId,
        fromJack: cable.from.jackId,
        toModule: cable.to.moduleId,
        toJack: cable.to.jackId,
      })),
    };

    this.pruneRuntimeFloatParams(snapshot);
    this.updateStats({
      graphModules: snapshot.modules.length,
      graphCables: snapshot.cables.length,
      graphParams: snapshot.modules.reduce(
        (count, module) => count + module.params.length,
        0,
      ),
    });
    const signature = graphStructureSignature(snapshot);
    this.snapshot = snapshot;
    if (signature === this.postedGraphSignature) {
      this.syncTempo(snapshot.tempoBpm);
      this.syncSnapshotFloatParams(snapshot);
      this.syncSnapshotSamplerAssets(snapshot);
      this.syncSnapshotModuleTexts(snapshot);
      return;
    }
    this.postGraph(snapshot, signature);
  }

  setStatsListener(listener: ((stats: AudioEngineStats) => void) | null) {
    this.statsListener = listener;
    listener?.(this.stats);
  }

  setScopeListener(listener: ((snapshots: ScopeSnapshot[]) => void) | null) {
    this.scopeListener = listener;
  }

  setMixerMeterListener(listener: ((meters: MixerMeterSnapshot[]) => void) | null) {
    this.mixerMeterListener = listener;
  }

  setModuleLevelListener(
    listener: ((levels: ModuleLevelSnapshot[]) => void) | null,
  ) {
    this.moduleLevelListener = listener;
  }

  setTransportStepListener(
    listener: ((snapshot: TransportStepSnapshot) => void) | null,
  ) {
    this.transportStepListener = listener;
  }

  armTransportStep() {
    this.node?.port.postMessage({
      type: "armTransportStep",
    });
  }

  resetTransport() {
    this.node?.port.postMessage({
      type: "resetTransport",
    });
  }

  setFloatParam(moduleId: number, paramId: number, value: number) {
    if (!Number.isFinite(value)) {
      return;
    }
    this.rememberPostedFloatParam(moduleId, paramId, value);
    this.postFloatParam(moduleId, paramId, value);
  }

  setRuntimeFloatParam(
    moduleId: number,
    moduleKind: number,
    paramId: number,
    value: number,
  ) {
    if (!Number.isFinite(value)) {
      return;
    }
    this.runtimeFloatParams.set(runtimeFloatParamKey(moduleId, paramId), {
      moduleId,
      moduleKind,
      paramId,
      value,
    });
    this.postFloatParam(moduleId, paramId, value);
  }

  setModuleText(moduleId: number, text: ModuleTextState | undefined) {
    const message = graphModuleTextMessage(text);
    this.postModuleTextMessage(moduleId, message);
  }

  private postFloatParam(moduleId: number, paramId: number, value: number) {
    if (!this.node || !Number.isFinite(value)) {
      return;
    }
    this.pendingFloatParams.set(runtimeFloatParamKey(moduleId, paramId), {
      moduleId,
      paramId,
      value,
    });
    if (this.pendingFloatParamFlush) {
      return;
    }
    this.pendingFloatParamFlush = true;
    queueMicrotask(() => this.flushFloatParams());
  }

  private flushFloatParams() {
    this.pendingFloatParamFlush = false;
    if (!this.node || this.pendingFloatParams.size === 0) {
      this.pendingFloatParams.clear();
      return;
    }

    const params = Array.from(this.pendingFloatParams.values());
    this.pendingFloatParams.clear();
    if (params.length === 1) {
      const [param] = params;
      this.node.port.postMessage({
        type: "setFloatParam",
        moduleId: param.moduleId,
        paramId: param.paramId,
        value: param.value,
      });
      return;
    }

    this.node.port.postMessage({
      type: "setFloatParams",
      params,
    });
  }

  setTempo(tempoBpm: number) {
    if (!this.node || !Number.isFinite(tempoBpm)) {
      return;
    }
    this.node.port.postMessage({
      type: "setTempo",
      bpm: tempoBpm,
    });
    this.postedTempoBpm = tempoBpm;
  }

  requestLoopExport(moduleId: number, slot: number) {
    if (!this.node) {
      return Promise.reject(
        new Error("Start audio once before exporting from LOOP."),
      );
    }

    const requestId = `loop-${Date.now().toString(36)}-${(
      this.exportRequestSequence += 1
    ).toString(36)}`;
    return new Promise<LoopExport>((resolve, reject) => {
      this.loopExportRequests.set(requestId, { resolve, reject });
      this.node?.port.postMessage({
        type: "requestLoopExport",
        requestId,
        moduleId,
        slot,
      });
    });
  }

  private postGraph(snapshot: GraphSnapshot, signature = graphStructureSignature(snapshot)) {
    this.flushFloatParams();
    if (!this.node) {
      return;
    }
    this.node.port.postMessage({
      type: "syncGraph",
      tempoBpm: snapshot.tempoBpm,
      modules: snapshot.modules,
      cables: snapshot.cables,
    });
    this.postedGraphSignature = signature;
    this.postedTempoBpm = snapshot.tempoBpm;
    this.rememberSnapshotFloatParams(snapshot);
    this.rememberSnapshotModuleTexts(snapshot);
    this.postRuntimeFloatParams();
  }

  private syncTempo(tempoBpm: number) {
    if (Object.is(this.postedTempoBpm, tempoBpm)) {
      return;
    }
    this.setTempo(tempoBpm);
  }

  private syncSnapshotFloatParams(snapshot: GraphSnapshot) {
    if (!this.node) {
      return;
    }

    const nextKeys = new Set<string>();
    for (const module of snapshot.modules) {
      for (const param of module.params) {
        const key = runtimeFloatParamKey(module.id, param.id);
        nextKeys.add(key);
        if (Object.is(this.postedFloatParams.get(key), param.value)) {
          continue;
        }
        this.rememberPostedFloatParam(module.id, param.id, param.value);
        this.postFloatParam(module.id, param.id, param.value);
      }
    }

    for (const key of Array.from(this.postedFloatParams.keys())) {
      if (!nextKeys.has(key)) {
        this.postedFloatParams.delete(key);
      }
    }
  }

  private syncSnapshotSamplerAssets(snapshot: GraphSnapshot) {
    if (!this.node) {
      return;
    }
    this.node.port.postMessage({
      type: "syncSamplerAssets",
      modules: snapshot.modules,
    });
  }

  private syncSnapshotModuleTexts(snapshot: GraphSnapshot) {
    if (!this.node) {
      return;
    }

    const nextModuleIds = new Set<number>();
    for (const module of snapshot.modules) {
      nextModuleIds.add(module.id);
      const signature = graphModuleTextSignature(module.text);
      if (this.postedTextSignatures.get(module.id) === signature) {
        continue;
      }
      this.postModuleText(module);
      this.postedTextSignatures.set(module.id, signature);
    }

    for (const moduleId of Array.from(this.postedTextSignatures.keys())) {
      if (!nextModuleIds.has(moduleId)) {
        this.postedTextSignatures.delete(moduleId);
      }
    }
  }

  private rememberSnapshotFloatParams(snapshot: GraphSnapshot) {
    this.postedFloatParams = new Map();
    for (const module of snapshot.modules) {
      for (const param of module.params) {
        this.rememberPostedFloatParam(module.id, param.id, param.value);
      }
    }
  }

  private rememberSnapshotModuleTexts(snapshot: GraphSnapshot) {
    this.postedTextSignatures = new Map();
    for (const module of snapshot.modules) {
      this.postedTextSignatures.set(
        module.id,
        graphModuleTextSignature(module.text),
      );
    }
  }

  private postModuleText(module: GraphModuleMessage) {
    this.postModuleTextMessage(module.id, module.text);
  }

  private postModuleTextMessage(
    moduleId: number,
    text: GraphModuleTextMessage | undefined,
  ) {
    if (!this.node || !text) {
      return;
    }
    this.node.port.postMessage({
      type: "setModuleText",
      moduleId,
      text,
    });
  }

  private rememberPostedFloatParam(
    moduleId: number,
    paramId: number,
    value: number,
  ) {
    this.postedFloatParams.set(runtimeFloatParamKey(moduleId, paramId), value);
  }

  private postRuntimeFloatParams() {
    for (const param of this.runtimeFloatParams.values()) {
      this.postFloatParam(param.moduleId, param.paramId, param.value);
    }
  }

  private pruneRuntimeFloatParams(snapshot: GraphSnapshot) {
    const activeKindsByModule = new Map(
      snapshot.modules.map((module) => [module.id, module.kind]),
    );
    for (const [key, param] of this.runtimeFloatParams) {
      if (activeKindsByModule.get(param.moduleId) !== param.moduleKind) {
        this.runtimeFloatParams.delete(key);
      }
    }
  }

  private updateContextStats() {
    if (!this.context) {
      this.updateStats({
        contextState: "none",
        sampleRate: 0,
        baseLatencyMs: 0,
        outputLatencyMs: 0,
      });
      return;
    }

    this.updateStats({
      contextState: this.context.state,
      sampleRate: this.context.sampleRate,
      baseLatencyMs: this.context.baseLatency * 1000,
      outputLatencyMs: (this.context.outputLatency ?? 0) * 1000,
    });
  }

  private updateStats(next: Partial<AudioEngineStats>) {
    this.stats = { ...this.stats, ...next };
    this.statsListener?.(this.stats);
  }

  private disconnectAudioInput() {
    try {
      this.inputSource?.disconnect();
    } catch {
      // The source may already be disconnected if the context was torn down.
    }
    for (const track of this.inputStream?.getTracks() ?? []) {
      track.stop();
    }
    this.inputStream = null;
    this.inputSource = null;
    this.inputDeviceId = "";
    this.inputDeviceLabel = "";
  }

  private resolveLoopExport(message: LoopExport & { requestId: string }) {
    const pending = this.loopExportRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    this.loopExportRequests.delete(message.requestId);
    pending.resolve({
      moduleId: message.moduleId,
      slot: message.slot,
      bars: message.bars,
      frames: message.frames,
      sampleRate: message.sampleRate,
      left: message.left,
      right: message.right,
    });
  }

  private rejectLoopExport(requestId: string, message: string) {
    const pending = this.loopExportRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.loopExportRequests.delete(requestId);
    pending.reject(new Error(message));
  }
}

function runtimeFloatParamKey(moduleId: number, paramId: number) {
  return `${moduleId}:${paramId}`;
}

function graphStructureSignature(snapshot: GraphSnapshot) {
  return JSON.stringify({
    modules: snapshot.modules.map((module) => ({
      id: module.id,
      kind: module.kind,
      audioOutputs: module.audioOutputs,
    })),
    cables: snapshot.cables.map((cable) => [
      cable.fromModule,
      cable.fromJack,
      cable.toModule,
      cable.toJack,
    ]),
  });
}

function graphModuleTextSignature(text: GraphModuleTextMessage | undefined) {
  if (!text) {
    return "";
  }
  return JSON.stringify({
    kind: text.kind,
    phrases: text.phrases,
  });
}

function graphModuleTextMessage(
  text: ModuleTextState | undefined,
): GraphModuleTextMessage | undefined {
  if (text?.kind !== "choir") {
    return undefined;
  }
  return {
    kind: "choir",
    phrases: text.phrases,
  };
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cableEndpointMatchesDefinition(
  endpoint: PatchCable["from"],
  modulesById: Map<number, RackModuleState>,
) {
  const module = modulesById.get(endpoint.moduleId);
  if (!module) {
    return false;
  }
  const definition = definitionForKind(module.kind);
  const jacks = endpoint.direction === "input" ? definition.inputs : definition.outputs;
  return jacks.some((jack) => jack.id === endpoint.jackId && jack.kind === endpoint.kind);
}
