const LOOP_TRACKS = 8;
const LOOP_CLIPS_PER_TRACK = 4;
const LOOP_CELLS = LOOP_TRACKS * LOOP_CLIPS_PER_TRACK;
const LOOP_METER_COUNT = LOOP_CELLS * 6 + 2;
const MIXER_METER_COUNT = 28;
const METER_BUFFER_COUNT = Math.max(LOOP_METER_COUNT, MIXER_METER_COUNT);

class ModularEngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.exports = null;
    this.memory = null;
    this.engine = 0;
    this.leftPointer = 0;
    this.rightPointer = 0;
    this.bufferFrames = 128;
    this.ready = false;
    this.scopeSamples = 4096;
    this.scopeLeftPointer = 0;
    this.scopeRightPointer = 0;
    this.scopeModuleIds = [];
    this.mixerMeterCount = METER_BUFFER_COUNT;
    this.mixerMeterPointer = 0;
    this.meterModuleIds = [];
    this.moduleMeterSpecs = [];
    this.hasMixerMeters = false;
    this.hasModuleMeters = false;
    this.hasSamplerLoading = false;
    this.hasSamplerSliceOutput = false;
    this.hasLoopLoading = false;
    this.hasLoopExport = false;
    this.hasAudioInput = false;
    this.hasModuleText = false;
    this.pendingModuleTexts = new Map();
    this.audioInputChannels = 4;
    this.audioInputPointers = [];
    this.loadedSamplerAssets = new Map();
    this.loadedLoopSlots = new Map();
    this.scopeFrames = 0;
    this.scopeFrameInterval = 0;
    this.graphVersion = 0;
    this.graphModules = 0;
    this.graphCables = 0;
    this.renderedFrames = 0;
    this.statsFrames = 0;
    this.statsBlocks = 0;
    this.statsPeak = 0;
    this.statsProcessTotalMs = 0;
    this.statsProcessMaxMs = 0;
    this.statsRenderTotalMs = 0;
    this.statsRenderMaxMs = 0;
    this.statsRenderBudgetMs = 0;
    this.statsLateBlocks = 0;
    this.statsCallbackGapMaxMs = 0;
    this.statsSilentBlocks = 0;
    this.statsGraphSyncs = 0;
    this.statsGraphSyncLastMs = 0;
    this.statsGraphSyncMaxMs = 0;
    this.lastProcessWallMs = 0;
    this.hasHighResolutionTimer =
      typeof globalThis.performance?.now === "function";
    this.hasTransportPosition = false;
    this.hasTransportReset = false;
    this.lastTransportStep = -1;
    this.lastTransportTripletStep = -1;

    try {
      const wasmBytes = options.processorOptions.wasmBytes;
      const wasmModule = new WebAssembly.Module(wasmBytes);
      const instance = new WebAssembly.Instance(wasmModule, {});
      this.exports = instance.exports;
      this.memory = this.exports.memory;
      this.hasMixerMeters =
        typeof this.exports.modular_engine_mixer_meters === "function";
      this.hasModuleMeters =
        typeof this.exports.modular_engine_take_output_peak === "function";
      this.hasSamplerLoading =
        typeof this.exports.modular_engine_load_sampler_mono === "function" &&
        typeof this.exports.modular_engine_clear_sampler === "function" &&
        typeof this.exports.modular_engine_set_sampler_slice === "function";
      this.hasSamplerSliceOutput =
        typeof this.exports.modular_engine_set_sampler_slice_output ===
        "function";
      this.hasLoopLoading =
        typeof this.exports.modular_engine_load_loop_stereo === "function" &&
        typeof this.exports.modular_engine_clear_loop_slot === "function";
      this.hasLoopExport =
        typeof this.exports.modular_engine_loop_slot_frames === "function" &&
        typeof this.exports.modular_engine_write_loop_slot === "function";
      this.hasAudioInput =
        typeof this.exports.modular_engine_set_audio_input_channel === "function";
      this.hasModuleText =
        typeof this.exports.modular_engine_set_choir_phrase === "function" &&
        typeof this.exports.modular_engine_alloc_bytes === "function" &&
        typeof this.exports.modular_engine_free_bytes === "function";
      this.hasTransportPosition =
        typeof this.exports.modular_engine_transport_sixteenth_position ===
        "function";
      this.hasTransportReset =
        typeof this.exports.modular_engine_reset_transport === "function";
      this.engine = this.exports.modular_engine_new(sampleRate);
      this.leftPointer = this.exports.modular_engine_alloc_buffer(this.bufferFrames);
      this.rightPointer = this.exports.modular_engine_alloc_buffer(this.bufferFrames);
      this.scopeLeftPointer = this.exports.modular_engine_alloc_buffer(this.scopeSamples);
      this.scopeRightPointer = this.exports.modular_engine_alloc_buffer(this.scopeSamples);
      if (this.hasMixerMeters) {
        this.mixerMeterPointer = this.exports.modular_engine_alloc_buffer(
          this.mixerMeterCount,
        );
      }
      if (this.hasAudioInput) {
        this.audioInputPointers = Array.from(
          { length: this.audioInputChannels },
          () => this.exports.modular_engine_alloc_buffer(this.bufferFrames),
        );
      }
      this.scopeFrameInterval = Math.max(128, Math.floor(sampleRate / 20));
      const audioInputReady =
        !this.hasAudioInput || this.audioInputPointers.every((pointer) => pointer);
      this.ready = Boolean(
        this.engine &&
          this.leftPointer &&
          this.rightPointer &&
          this.scopeLeftPointer &&
          this.scopeRightPointer &&
          audioInputReady &&
          (this.mixerMeterPointer || !this.hasMixerMeters),
      );
      this.port.postMessage({ type: "ready" });
    } catch (error) {
      this.port.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.port.onmessage = (event) => {
      if (!this.ready || !this.exports) {
        return;
      }

      const message = event.data;
      if (message.type === "syncGraph") {
        this.syncGraph(message);
      } else if (message.type === "syncSamplerAssets") {
        this.syncSamplerAssets(message.modules ?? []);
      } else if (message.type === "setFloatParam") {
        this.exports.modular_engine_set_float_param(
          this.engine,
          message.moduleId,
          message.paramId,
          message.value,
        );
      } else if (message.type === "setFloatParams") {
        for (const param of message.params ?? []) {
          this.exports.modular_engine_set_float_param(
            this.engine,
            param.moduleId,
            param.paramId,
            param.value,
          );
        }
      } else if (message.type === "setTempo") {
        this.exports.modular_engine_set_tempo_bpm(this.engine, message.bpm);
      } else if (message.type === "resetTransport") {
        this.resetTransport();
      } else if (message.type === "armTransportStep") {
        this.lastTransportStep = -1;
        this.lastTransportTripletStep = -1;
      } else if (message.type === "setModuleText") {
        this.setModuleText(message.moduleId, message.text);
      } else if (message.type === "requestLoopExport") {
        this.postLoopExport(message);
      }
    };
  }

  syncGraph(message) {
    const syncStartMs = this.nowMs();
    let committed = false;

    try {
      this.exports.modular_engine_set_tempo_bpm(this.engine, message.tempoBpm);
      this.exports.modular_engine_begin_graph(this.engine);

      for (const module of message.modules) {
        const didAdd = this.exports.modular_engine_add_module(
          this.engine,
          module.id,
          module.kind,
        );
        if (!didAdd) {
          this.port.postMessage({
            type: "error",
            message: `Failed to add module ${module.id}`,
          });
          return;
        }

        for (const param of module.params) {
          if (param.type !== "float") {
            continue;
          }
          this.exports.modular_engine_set_draft_float_param(
            this.engine,
            module.id,
            param.id,
            param.value,
          );
        }
      }

      for (const cable of message.cables) {
        const didConnect = this.exports.modular_engine_connect_draft(
          this.engine,
          cable.fromModule,
          cable.fromJack,
          cable.toModule,
          cable.toJack,
        );
        if (!didConnect) {
          this.port.postMessage({
            type: "error",
            message: `Failed to connect ${cable.fromModule}:${cable.fromJack} -> ${cable.toModule}:${cable.toJack}`,
          });
          return;
        }
      }

      const didCommit = this.exports.modular_engine_commit_graph(this.engine);
      if (!didCommit) {
        this.port.postMessage({
          type: "error",
          message: "Patch graph rejected; keeping the previous audio graph",
        });
        return;
      }

      this.syncSamplerAssets(message.modules);
      this.syncModuleTexts(message.modules);

      this.graphVersion += 1;
      this.graphModules = message.modules.length;
      this.graphCables = message.cables.length;
      this.scopeModuleIds = message.modules
        .filter((module) => module.kind === 15)
        .map((module) => module.id);
      this.meterModuleIds = this.hasMixerMeters
        ? message.modules
            .filter(
              (module) =>
                module.kind === 12 ||
                module.kind === 5 ||
                module.kind === 20 ||
                module.kind === 28 ||
                module.kind === 33 ||
                module.kind === 52 ||
                module.kind === 83,
            )
            .map((module) => module.id)
        : [];
      this.moduleMeterSpecs = this.hasModuleMeters
        ? message.modules
            .map((module) => ({
              moduleId: module.id,
              audioOutputs: module.audioOutputs ?? [],
            }))
            .filter((module) => module.audioOutputs.length > 0)
        : [];
      committed = true;
    } finally {
      const graphSyncMs = this.recordGraphSync(syncStartMs);
      if (committed) {
        this.port.postMessage({
          type: "graphStats",
          graphVersion: this.graphVersion,
          graphModules: this.graphModules,
          graphCables: this.graphCables,
          graphSyncMs,
          graphSyncMaxMs: this.statsGraphSyncMaxMs,
        });
      }
    }
  }

  syncSamplerAssets(modules) {
    if ((!this.hasSamplerLoading && !this.hasLoopLoading) || !this.memory) {
      return;
    }

    const activeModuleIds = new Set(modules.map((module) => module.id));
    for (const moduleId of Array.from(this.loadedSamplerAssets.keys())) {
      if (!activeModuleIds.has(moduleId)) {
        this.loadedSamplerAssets.delete(moduleId);
        this.clearLoadedLoopSlots(moduleId);
      }
    }

    for (const module of modules) {
      const asset = module.samplerAsset;
      if (!asset) {
        if (this.loadedSamplerAssets.has(module.id)) {
          if (this.hasSamplerLoading) {
            this.exports.modular_engine_clear_sampler(this.engine, module.id);
          }
          if (this.hasLoopLoading) {
            for (let slot = 0; slot < LOOP_CELLS; slot += 1) {
              this.exports.modular_engine_clear_loop_slot(this.engine, module.id, slot);
            }
          }
          this.loadedSamplerAssets.delete(module.id);
          this.clearLoadedLoopSlots(module.id);
        }
        continue;
      }

      if (this.loadedSamplerAssets.get(module.id) === asset.assetId) {
        continue;
      }

      if (asset.kind === "loop") {
        this.loadLoopAsset(module.id, asset);
      } else {
        this.loadSamplerAsset(module.id, asset);
      }
    }
  }

  syncModuleTexts(modules) {
    if (!this.hasModuleText || !this.memory) {
      return;
    }

    const activeModuleIds = new Set(modules.map((module) => module.id));
    for (const moduleId of Array.from(this.pendingModuleTexts.keys())) {
      if (!activeModuleIds.has(moduleId)) {
        this.pendingModuleTexts.delete(moduleId);
      }
    }

    for (const module of modules) {
      const text = this.pendingModuleTexts.get(module.id) ?? module.text;
      if (text?.kind !== "choir") {
        continue;
      }
      if (this.applyModuleText(module.id, text)) {
        this.pendingModuleTexts.delete(module.id);
      }
    }
  }

  setModuleText(moduleId, text) {
    if (!this.hasModuleText || !this.memory || text?.kind !== "choir") {
      return;
    }
    this.pendingModuleTexts.set(moduleId, text);
    if (this.applyModuleText(moduleId, text)) {
      this.pendingModuleTexts.delete(moduleId);
    }
  }

  applyModuleText(moduleId, text) {
    const phrases = Array.isArray(text.phrases) ? text.phrases : [];
    let didSetAll = true;
    for (let index = 0; index < 128; index += 1) {
      didSetAll =
        this.setChoirPhrase(moduleId, index, phrases[index] ?? "") &&
        didSetAll;
    }
    return didSetAll;
  }

  setChoirPhrase(moduleId, phraseIndex, phrase) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(String(phrase).slice(0, 280));
    const pointer = this.exports.modular_engine_alloc_bytes(bytes.length);
    if (!pointer) {
      this.port.postMessage({
        type: "error",
        message: `Failed to allocate text buffer for module ${moduleId}`,
      });
      return false;
    }

    try {
      new Uint8Array(this.memory.buffer, pointer, bytes.length).set(bytes);
      return Boolean(
        this.exports.modular_engine_set_choir_phrase(
          this.engine,
          moduleId,
          phraseIndex,
          pointer,
          bytes.length,
        ),
      );
    } finally {
      this.exports.modular_engine_free_bytes(pointer, bytes.length);
    }
  }

  loadSamplerAsset(moduleId, asset) {
    if (!this.hasSamplerLoading) {
      return;
    }
    const samples = asset.samples;
    const frames = Math.min(asset.frames, samples?.length ?? 0);
    if (!samples || frames <= 0) {
      return;
    }

    const pointer = this.exports.modular_engine_alloc_buffer(frames);
    if (!pointer) {
      this.port.postMessage({
        type: "error",
        message: `Failed to allocate sampler buffer for module ${moduleId}`,
      });
      return;
    }

    try {
      new Float32Array(this.memory.buffer, pointer, frames).set(
        samples.subarray(0, frames),
      );
      const didLoad = this.exports.modular_engine_load_sampler_mono(
        this.engine,
        moduleId,
        pointer,
        frames,
        asset.sampleRate,
      );
      if (!didLoad) {
        this.port.postMessage({
          type: "error",
          message: `Failed to load sampler asset for module ${moduleId}`,
        });
        return;
      }

      for (const slice of asset.slices ?? []) {
        this.exports.modular_engine_set_sampler_slice(
          this.engine,
          moduleId,
          slice.index,
          slice.startFrame,
          slice.endFrame,
        );
        if (this.hasSamplerSliceOutput && Number.isFinite(slice.output)) {
          this.exports.modular_engine_set_sampler_slice_output(
            this.engine,
            moduleId,
            slice.index,
            slice.output,
          );
        }
      }
      this.loadedSamplerAssets.set(moduleId, asset.assetId);
    } finally {
      this.exports.modular_engine_free_buffer(pointer, frames);
    }
  }

  loadLoopAsset(moduleId, asset) {
    if (!this.hasLoopLoading) {
      return;
    }

    let loadedAny = false;
    const loops = asset.loops ?? [];
    const presentSlots = new Set();
    for (const loop of loops) {
      const frames = Math.min(
        loop.frames,
        loop.left?.length ?? 0,
        loop.right?.length ?? 0,
      );
      const slot = Math.max(0, Math.min(LOOP_CELLS - 1, Math.round(loop.slot ?? 0)));
      const slotKey = this.loopSlotKey(moduleId, slot);
      const bars = Math.max(0, Math.min(128, Math.round(loop.bars ?? 0)));
      const signature = `${loop.objectKey ?? ""}:${loop.sampleRate ?? 0}:${frames}:${bars}`;
      presentSlots.add(slot);
      if (!loop.left || !loop.right || frames <= 0) {
        this.exports.modular_engine_clear_loop_slot(this.engine, moduleId, slot);
        this.loadedLoopSlots.delete(slotKey);
        continue;
      }

      if (this.loadedLoopSlots.get(slotKey) === signature) {
        loadedAny = true;
        continue;
      }

      const leftPointer = this.exports.modular_engine_alloc_buffer(frames);
      const rightPointer = this.exports.modular_engine_alloc_buffer(frames);
      if (!leftPointer || !rightPointer) {
        this.port.postMessage({
          type: "error",
          message: `Failed to allocate LOOP buffer for module ${moduleId}`,
        });
        if (leftPointer) {
          this.exports.modular_engine_free_buffer(leftPointer, frames);
        }
        if (rightPointer) {
          this.exports.modular_engine_free_buffer(rightPointer, frames);
        }
        continue;
      }

      try {
        new Float32Array(this.memory.buffer, leftPointer, frames).set(
          loop.left.subarray(0, frames),
        );
        new Float32Array(this.memory.buffer, rightPointer, frames).set(
          loop.right.subarray(0, frames),
        );
        const didLoad = this.exports.modular_engine_load_loop_stereo(
          this.engine,
          moduleId,
          slot,
          leftPointer,
          rightPointer,
          frames,
          loop.sampleRate,
          bars,
        );
        loadedAny = loadedAny || didLoad;
        if (didLoad) {
          this.loadedLoopSlots.set(slotKey, signature);
        }
        if (!didLoad) {
          this.port.postMessage({
            type: "error",
            message: `Failed to load LOOP slot ${slot + 1} for module ${moduleId}`,
          });
        }
      } finally {
        this.exports.modular_engine_free_buffer(leftPointer, frames);
        this.exports.modular_engine_free_buffer(rightPointer, frames);
      }
    }

    for (let slot = 0; slot < LOOP_CELLS; slot += 1) {
      if (!presentSlots.has(slot)) {
        this.exports.modular_engine_clear_loop_slot(this.engine, moduleId, slot);
        this.loadedLoopSlots.delete(this.loopSlotKey(moduleId, slot));
      }
    }
    if (loadedAny || loops.length === 0) {
      this.loadedSamplerAssets.set(moduleId, asset.assetId);
    }
  }

  loopSlotKey(moduleId, slot) {
    return `${moduleId}:${slot}`;
  }

  clearLoadedLoopSlots(moduleId) {
    const prefix = `${moduleId}:`;
    for (const key of Array.from(this.loadedLoopSlots.keys())) {
      if (key.startsWith(prefix)) {
        this.loadedLoopSlots.delete(key);
      }
    }
  }

  pushAudioInputs(inputs, frames) {
    if (!this.hasAudioInput || !this.memory) {
      return;
    }

    const source = inputs?.[0] ?? [];
    for (let channel = 0; channel < this.audioInputChannels; channel += 1) {
      const pointer = this.audioInputPointers[channel];
      if (!pointer) {
        continue;
      }

      const view = new Float32Array(this.memory.buffer, pointer, frames);
      const samples = source[channel];
      view.fill(0);
      if (samples && samples.length > 0) {
        view.set(samples.subarray(0, Math.min(samples.length, frames)));
      }
      this.exports.modular_engine_set_audio_input_channel(
        this.engine,
        channel,
        pointer,
        frames,
      );
    }
  }

  process(inputs, outputs) {
    const processStartMs = this.nowMs();
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }

    const left = output[0];
    const right = output[1] ?? output[0];
    const frames = left.length;
    this.recordCallbackTiming(processStartMs, frames);

    if (!this.ready || !this.exports || !this.memory) {
      left.fill(0);
      if (right !== left) {
        right.fill(0);
      }
      this.statsSilentBlocks += 1;
      this.recordProcessTiming(processStartMs, 0);
      return true;
    }

    if (frames > this.bufferFrames) {
      left.fill(0);
      if (right !== left) {
        right.fill(0);
      }
      this.statsSilentBlocks += 1;
      this.recordProcessTiming(processStartMs, 0);
      return true;
    }

    this.pushAudioInputs(inputs, frames);
    const renderStartMs = this.nowMs();
    this.exports.modular_engine_render(
      this.engine,
      this.leftPointer,
      this.rightPointer,
      frames,
    );
    const renderMs = this.elapsedMs(renderStartMs);

    const leftView = new Float32Array(this.memory.buffer, this.leftPointer, frames);
    const rightView = new Float32Array(this.memory.buffer, this.rightPointer, frames);
    left.set(leftView);
    if (right !== left) {
      right.set(rightView);
    }

    let peak = 0;
    for (let index = 0; index < frames; index += 1) {
      peak = Math.max(peak, Math.abs(leftView[index]), Math.abs(rightView[index]));
    }
    this.statsPeak = Math.max(this.statsPeak, peak);
    this.statsFrames += frames;
    this.renderedFrames += frames;
    this.statsBlocks += 1;
    this.scopeFrames += frames;
    this.postTransportStep();

    if (
      (this.scopeModuleIds.length > 0 ||
        this.meterModuleIds.length > 0 ||
        this.moduleMeterSpecs.length > 0) &&
      this.scopeFrames >= this.scopeFrameInterval
    ) {
      this.postScopeSnapshots();
      this.postMixerMeters();
      this.postModuleMeters();
      this.scopeFrames = 0;
    }

    this.recordProcessTiming(processStartMs, renderMs);

    if (this.statsFrames >= sampleRate) {
      const statsBlocks = Math.max(1, this.statsBlocks);
      this.port.postMessage({
        type: "renderStats",
        blocksPerSecond: this.statsBlocks,
        renderedFrames: this.renderedFrames,
        peak: this.statsPeak,
        graphVersion: this.graphVersion,
        graphModules: this.graphModules,
        graphCables: this.graphCables,
        processAvgMs: this.statsProcessTotalMs / statsBlocks,
        processMaxMs: this.statsProcessMaxMs,
        renderAvgMs: this.statsRenderTotalMs / statsBlocks,
        renderMaxMs: this.statsRenderMaxMs,
        renderBudgetMs: this.statsRenderBudgetMs,
        lateBlocks: this.statsLateBlocks,
        callbackGapMaxMs: this.statsCallbackGapMaxMs,
        silentBlocks: this.statsSilentBlocks,
        graphSyncs: this.statsGraphSyncs,
        graphSyncMs: this.statsGraphSyncLastMs,
        graphSyncMaxMs: this.statsGraphSyncMaxMs,
      });
      this.statsFrames = 0;
      this.statsBlocks = 0;
      this.statsPeak = 0;
      this.statsProcessTotalMs = 0;
      this.statsProcessMaxMs = 0;
      this.statsRenderTotalMs = 0;
      this.statsRenderMaxMs = 0;
      this.statsLateBlocks = 0;
      this.statsCallbackGapMaxMs = 0;
      this.statsSilentBlocks = 0;
      this.statsGraphSyncs = 0;
      this.statsGraphSyncMaxMs = this.statsGraphSyncLastMs;
    }

    return true;
  }

  nowMs() {
    if (typeof globalThis.performance?.now === "function") {
      return globalThis.performance.now();
    }
    return typeof Date.now === "function" ? Date.now() : 0;
  }

  elapsedMs(startMs) {
    const nowMs = this.nowMs();
    return startMs > 0 && nowMs > 0 ? Math.max(0, nowMs - startMs) : 0;
  }

  recordCallbackTiming(nowMs, frames) {
    if (nowMs <= 0 || frames <= 0) {
      return;
    }

    const expectedMs = (frames / sampleRate) * 1000;
    this.statsRenderBudgetMs = expectedMs;
    if (this.lastProcessWallMs > 0) {
      const overMs = Math.max(0, nowMs - this.lastProcessWallMs - expectedMs);
      this.statsCallbackGapMaxMs = Math.max(this.statsCallbackGapMaxMs, overMs);
      const lateThresholdMs = this.hasHighResolutionTimer
        ? 0.75
        : Math.max(12.0, expectedMs * 4.0);
      if (overMs > lateThresholdMs) {
        this.statsLateBlocks += 1;
      }
    }
    this.lastProcessWallMs = nowMs;
  }

  recordProcessTiming(startMs, renderMs) {
    const processMs = this.elapsedMs(startMs);
    this.statsProcessTotalMs += processMs;
    this.statsProcessMaxMs = Math.max(this.statsProcessMaxMs, processMs);
    this.statsRenderTotalMs += renderMs;
    this.statsRenderMaxMs = Math.max(this.statsRenderMaxMs, renderMs);
  }

  recordGraphSync(startMs) {
    const graphSyncMs = this.elapsedMs(startMs);
    this.statsGraphSyncs += 1;
    this.statsGraphSyncLastMs = graphSyncMs;
    this.statsGraphSyncMaxMs = Math.max(this.statsGraphSyncMaxMs, graphSyncMs);
    return graphSyncMs;
  }

  postScopeSnapshots() {
    const snapshots = [];
    for (const moduleId of this.scopeModuleIds) {
      const count = this.exports.modular_engine_scope_snapshot(
        this.engine,
        moduleId,
        this.scopeLeftPointer,
        this.scopeRightPointer,
        this.scopeSamples,
      );

      if (count === 0) {
        continue;
      }

      const leftView = new Float32Array(
        this.memory.buffer,
        this.scopeLeftPointer,
        count,
      );
      const rightView = new Float32Array(
        this.memory.buffer,
        this.scopeRightPointer,
        count,
      );
      const left = new Float32Array(count);
      const right = new Float32Array(count);
      left.set(leftView);
      right.set(rightView);
      snapshots.push({ moduleId, left, right });
    }

    if (snapshots.length > 0) {
      this.port.postMessage({ type: "scopeData", snapshots });
    }
  }

  postMixerMeters() {
    if (!this.hasMixerMeters || !this.mixerMeterPointer) {
      return;
    }

    const meters = [];
    for (const moduleId of this.meterModuleIds) {
      const count = this.exports.modular_engine_mixer_meters(
        this.engine,
        moduleId,
        this.mixerMeterPointer,
        this.mixerMeterCount,
      );

      if (count === 0) {
        continue;
      }

      const levelsView = new Float32Array(
        this.memory.buffer,
        this.mixerMeterPointer,
        count,
      );
      const levels = new Float32Array(count);
      levels.set(levelsView);
      meters.push({ moduleId, levels });
    }

    if (meters.length > 0) {
      this.port.postMessage({ type: "mixerMeters", meters });
    }
  }

  postModuleMeters() {
    if (!this.hasModuleMeters || this.moduleMeterSpecs.length === 0) {
      return;
    }

    const levels = [];
    for (const module of this.moduleMeterSpecs) {
      let level = 0;
      for (const outputJack of module.audioOutputs) {
        const peak = this.exports.modular_engine_take_output_peak(
          this.engine,
          module.moduleId,
          outputJack,
        );
        if (Number.isFinite(peak)) {
          level = Math.max(level, peak);
        }
      }
      levels.push({ moduleId: module.moduleId, level });
    }

    if (levels.length > 0) {
      this.port.postMessage({ type: "moduleLevels", levels });
    }
  }

  postTransportStep() {
    if (!this.hasTransportPosition) {
      return;
    }

    const position = this.exports.modular_engine_transport_sixteenth_position(
      this.engine,
    );
    if (!Number.isFinite(position)) {
      return;
    }

    const absoluteStep = Math.max(0, Math.floor(position + 1.0e-9));
    const tripletAbsoluteStep = Math.max(0, Math.floor(position * 0.75 + 1.0e-9));
    const step = absoluteStep % 16;
    const tripletStep = tripletAbsoluteStep % 12;
    if (
      step === this.lastTransportStep &&
      tripletStep === this.lastTransportTripletStep
    ) {
      return;
    }

    this.lastTransportStep = step;
    this.lastTransportTripletStep = tripletStep;
    this.port.postMessage({
      type: "transportStep",
      step,
      absoluteStep,
      position,
    });
  }

  resetTransport() {
    if (this.hasTransportReset) {
      this.exports.modular_engine_reset_transport(this.engine);
    }
    this.lastTransportStep = -1;
    this.lastTransportTripletStep = -1;
    this.postTransportStep();
  }

  postLoopExport(message) {
    const requestId = message.requestId;
    const moduleId = message.moduleId;
    const slot = Math.max(0, Math.min(LOOP_CELLS - 1, Math.round(message.slot ?? 0)));
    if (!this.hasLoopExport || !this.memory) {
      this.port.postMessage({
        type: "loopExportError",
        requestId,
        message: "LOOP export is not available in this audio engine build",
      });
      return;
    }

    const frames = this.exports.modular_engine_loop_slot_frames(
      this.engine,
      moduleId,
      slot,
    );
    const bars =
      typeof this.exports.modular_engine_loop_slot_bars === "function"
        ? this.exports.modular_engine_loop_slot_bars(this.engine, moduleId, slot)
        : 0;
    if (!Number.isFinite(frames) || frames <= 0) {
      this.port.postMessage({
        type: "loopExportError",
        requestId,
        message: `LOOP slot ${slot + 1} is empty`,
      });
      return;
    }

    const leftPointer = this.exports.modular_engine_alloc_buffer(frames);
    const rightPointer = this.exports.modular_engine_alloc_buffer(frames);
    if (!leftPointer || !rightPointer) {
      this.port.postMessage({
        type: "loopExportError",
        requestId,
        message: "Failed to allocate LOOP export buffers",
      });
      if (leftPointer) {
        this.exports.modular_engine_free_buffer(leftPointer, frames);
      }
      if (rightPointer) {
        this.exports.modular_engine_free_buffer(rightPointer, frames);
      }
      return;
    }

    let left;
    let right;
    try {
      const count = this.exports.modular_engine_write_loop_slot(
        this.engine,
        moduleId,
        slot,
        leftPointer,
        rightPointer,
        frames,
      );
      const leftView = new Float32Array(this.memory.buffer, leftPointer, count);
      const rightView = new Float32Array(this.memory.buffer, rightPointer, count);
      left = new Float32Array(count);
      right = new Float32Array(count);
      left.set(leftView);
      right.set(rightView);
    } finally {
      this.exports.modular_engine_free_buffer(leftPointer, frames);
      this.exports.modular_engine_free_buffer(rightPointer, frames);
    }

    this.port.postMessage(
      {
        type: "loopExport",
        requestId,
        moduleId,
        slot,
        bars,
        frames: left.length,
        sampleRate,
        left,
        right,
      },
      [left.buffer, right.buffer],
    );
  }
}

registerProcessor("modular-engine", ModularEngineProcessor);
