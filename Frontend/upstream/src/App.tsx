import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import type { AuthModel } from "pocketbase";
import { CableLayer, endpointPosition } from "./components/CableLayer";
import { AuthScreen } from "./components/AuthScreen";
import { PerfOverlay } from "./components/PerfOverlay";
import {
  layoutRackModulesForDisplay,
  normalizeRackLayout,
  rackCanvasSize,
  rackModulePixelHeightForState,
  rackModulePixelPosition,
  rackModulePixelWidth,
  reorderModulesForRackPoint,
} from "./components/rackLayout";
import {
  ModularAudioEngine,
  type ModuleLevelSnapshot,
  type MixerMeterSnapshot,
  type ScopeSnapshot,
  type TransportStepSnapshot,
  emptyAudioEngineStats,
} from "./audio/ModularAudioEngine";
import {
  createCurrentUserSession,
  deleteCurrentUserSession,
  fetchSessionBySlug,
  fetchCurrentUserSessions,
  submitSessionUpdate,
  type SessionDraft,
} from "./backend/sessions";
import {
  createCurrentUserModulePreset,
  fetchCurrentUserModulePresets,
  type SavedModulePreset,
} from "./backend/modulePresets";
import {
  openSessionCursorSocket,
  type LocalSessionCursor,
  type RemoteSessionCursor,
  type SessionSocketEvent,
} from "./backend/sessionCursors";
import { pb } from "./backend/pocketbase";
import {
  compactParamsForKind,
  defaultParams,
  definitionForKind,
  moduleDefinitionMap,
  moduleDefinitions,
  sparseDefaultParamValue,
} from "./modules/registry";
import type { SavedSession } from "./sessionTypes";
import {
  applySessionPatch,
  canonicalSessionDocumentJson,
  documentToSessionParts,
  sessionDocumentHash,
  sessionPartsToDocument,
  type SessionDocumentV2,
  type SessionPatch,
} from "./sessionDocument";
import {
  appendSessionMutation,
  rebaseableSessionMutationsToPatch,
  removeAppliedSessionMutations,
  sessionMutationsToPatch,
  sessionParamPatchOperation,
  type SessionMutation,
} from "./sessionMutations";
import {
  modulePresetPayloadFor,
  paramsFromModulePresetPayload,
} from "./modulePresetDocument";
import {
  SYSTEM_RACK_ROWS,
  SYSTEM_OUTPUT_MODULE_ID,
  SYSTEM_SCOPE_MODULE_ID,
  createSystemRackModules,
  isSystemModuleId,
  isSystemModuleKind,
} from "./systemModules";
import { preserveSessionLocalModuleState } from "./sessionLocalState";
import type {
  CableEndpoint,
  JackDefinition,
  JackDirection,
  LoopRuntimeSampleAsset,
  ModuleDefinition,
  ModulePresetOption,
  ModuleRuntimeSampleAsset,
  ModuleSampleState,
  ModuleTextState,
  PatchCable,
  RackModuleState,
  SignalKind,
} from "./modules/types";
import { loadLoopRuntimeAsset } from "./loop/loopStorage";
import { loadSamplerRuntimeAsset } from "./sampler/samplerLoader";

const CABLE_SNAP_RADIUS = 78;
const SESSION_AUTOSAVE_DELAY_MS = 650;
const SESSION_PATH_PREFIX = "/sessions/";
const INITIAL_TEMPO_BPM = 118;
const REMOTE_CURSOR_TTL_MS = 4_000;
const CURSOR_SEND_INTERVAL_MS = 1_000 / 30;
const REMOTE_PARAM_PREVIEW_TTL_MS = 2_500;
const STEPS_SEQUENCER_SLUG = "steps";
const MELODIC_SEQUENCER_SLUG = "melodic-sequencer";
const MUTA_SLUG = "muta";
const EUCLID_SEQUENCER_SLUG = "euclid";
const ROLL_SEQUENCER_SLUG = "roll";
const RHYTHM_SEQUENCER_SLUG = "rhythm-sequencer";
const DRONE_SLUG = "drone";
const MIDI_SLUG = "midi";
const CHORD_GENERATOR_SLUG = "chord";
const AUDIO_INPUT_SLUG = "in";
const FM4_SYNTH_SLUG = "fm4";
const FIVE_SYNTH_SLUG = "five";
const SIX_SYNTH_SLUG = "six";
const LOOP_SLUG = "loop";
const MIXER_SLUG = "m14";
const MELODIC_SOURCE_SLUGS = new Set([
  MIDI_SLUG,
  MUTA_SLUG,
  STEPS_SEQUENCER_SLUG,
  MELODIC_SEQUENCER_SLUG,
  ROLL_SEQUENCER_SLUG,
  DRONE_SLUG,
  CHORD_GENERATOR_SLUG,
]);
const RHYTHM_SOURCE_SLUGS = new Set([
  RHYTHM_SEQUENCER_SLUG,
  EUCLID_SEQUENCER_SLUG,
]);
const PITCHED_SYNTH_SLUGS = new Set([
  "dx",
  "pluck",
  FM4_SYNTH_SLUG,
  FIVE_SYNTH_SLUG,
  SIX_SYNTH_SLUG,
  "one",
  "choir",
  "farf",
]);
const DRUM_MACHINE_SLUGS = new Set(["r6", "hits", "samp", "r8", "cr78"]);
const MODULE_SELECT_GROUPS = [
  {
    label: "synth",
    accent: "#facc15",
    slugs: [
      "pluck",
      "fm4",
      FIVE_SYNTH_SLUG,
      SIX_SYNTH_SLUG,
      "one",
      "choir",
      "farf",
    ],
  },
  {
    label: "drum",
    accent: "#f97316",
    slugs: ["cr78", "hits", "r6", "r8", "samp"],
  },
  {
    label: "sequence",
    accent: "#14b8a6",
    slugs: [
      STEPS_SEQUENCER_SLUG,
      MIDI_SLUG,
      MUTA_SLUG,
      EUCLID_SEQUENCER_SLUG,
      MELODIC_SEQUENCER_SLUG,
      ROLL_SEQUENCER_SLUG,
      RHYTHM_SEQUENCER_SLUG,
      "curve",
      "lfo",
      DRONE_SLUG,
      CHORD_GENERATOR_SLUG,
    ],
  },
  {
    label: "fx",
    accent: "#3b82f6",
    slugs: [
      "amp",
      "dist",
      "crisp",
      "delay",
      "eq3",
      "squeeze",
      "stone",
      "verb",
    ],
  },
  {
    label: "mix",
    accent: "#a3a3a3",
    slugs: [AUDIO_INPUT_SLUG, LOOP_SLUG, MIXER_SLUG],
  },
] satisfies Array<{ label: string; accent: string; slugs: string[] }>;
const addableModuleDefinitions = moduleDefinitions.filter(
  (definition) => !isSystemModuleKind(definition.kind),
);
const addableModuleDefinitionsBySlug = new Map(
  addableModuleDefinitions.map((definition) => [definition.slug, definition]),
);
const addableModuleGroups = MODULE_SELECT_GROUPS.map((group) => ({
  label: group.label,
  accent: group.accent,
  definitions: group.slugs
    .map((slug) => addableModuleDefinitionsBySlug.get(slug))
    .filter(isModuleDefinition)
    .sort((left, right) => left.name.localeCompare(right.name)),
})).filter((group) => group.definitions.length > 0);
const FX_MODULE_SLUGS = new Set(
  MODULE_SELECT_GROUPS.find((group) => group.label === "fx")?.slugs ?? [],
);
const MODULE_LIBRARY_DESCRIPTIONS: Record<string, string> = {
  pluck: "Karplus-Strong string synth.",
  fm4: "Four-operator FM synth with movement macro controls.",
  five: "Five-voice analog polysynth.",
  six: "Six-voice DCO polysynth.",
  one: "Monophonic analog synth.",
  farf: "Retro monophonic transistor organ",
  dx: "Six-operator FM synth inspired by Dexed.",
  choir: "Physical choir voice synth.",
  r6: "Like a Roland TR-606.",
  hits: "Eight-channel synthesized drum voice.",
  samp: "Sample-bank drum module with factory banks and op1.fun loading.",
  cr78: "Like a Roland CR-78.",
  r8: "Like a Roland TR-808.",
  midi: "Web MIDI input and output with mono or four-voice CV.",
  steps: "Sixteen-step pitch and gate sequencer.",
  "melodic-sequencer": "Sixteen-step note sequencer.",
  euclid: "Eight-channel Euclidean rhythm generator with pattern logic.",
  roll: "Piano-roll poly sequencer for four voices.",
  "rhythm-sequencer": "Eleven drum lanes with per-lane accent CV.",
  curve: "Draw four CV curves by hand.",
  lfo: "Tempo-free CV LFO with low and audio-rate modes.",
  drone: "Eight latched pitch and gate outputs for sustained notes.",
  chord: "Turns one pitch into four-voice chord CV and gates.",
  in: "Routes up to four live audio input channels into the rack.",
  amp: "Four-stage guitar amp with tone stack and cabinet color.",
  dist: "Resonant drive, foldback, and asymmetric clipping shaper.",
  crisp: "Crisp resonant/noise coloration effect.",
  delay: "Warm modulated delay.",
  eq3: "Three-band parametric EQ.",
  squeeze: "Squeezer-style dB-domain stereo compressor.",
  stone: "Small Stone-style phaser into modulated chorus.",
  verb: "Dattorro plate and Freeverb-style reverb modes.",
  m14: "Fourteen-channel stereo mixer.",
  loop: "Eight-slot stereo loop pedal.",
};
const LOOP_CLIPS_PER_TRACK = 4;
const MODULE_INSERT_EDGE_GUARD_PX = 34;
const MODULE_DRAG_AUTOSCROLL_ZONE_PX = 96;
const MODULE_DRAG_AUTOSCROLL_MAX_PX = 24;

function isModuleDefinition(
  definition: ModuleDefinition | undefined,
): definition is ModuleDefinition {
  return definition !== undefined;
}

interface CableDraft {
  anchor: CableEndpoint;
  cableId?: string;
  kind: SignalKind;
  pointer: { x: number; y: number };
  snapTarget: CableEndpoint | null;
}

interface ModuleDrag {
  moduleId: number;
  pointerId: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface JackContextMenuState {
  source: CableEndpoint;
  x: number;
  y: number;
}

interface JackMenuGroup {
  moduleId: number;
  label: string;
  options: JackMenuOption[];
}

interface JackMenuOption {
  endpoint: CableEndpoint;
  label: string;
  connected: boolean;
}

type SessionSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

interface SessionRealtimeUpdate {
  slug: string;
  baseHash: string;
  hash: string;
  patch: SessionPatch;
  authorId?: string;
  clientId?: string;
}

interface RemoteParamPreview {
  path: string;
  moduleId: number;
  paramId: number;
  value: number;
  clientId: string;
  expiresAt: number;
}

function App() {
  const [authRecord, setAuthRecord] = useState<AuthModel>(
    pb.authStore.isValid ? pb.authStore.record : null,
  );
  const [availableSessions, setAvailableSessions] = useState<SavedSession[]>(
    [],
  );
  const [userModulePresets, setUserModulePresets] = useState<
    SavedModulePreset[]
  >([]);
  const [sessionLoadState, setSessionLoadState] = useState<
    "idle" | "loading" | "ready" | "error"
  >(pb.authStore.isValid ? "loading" : "idle");
  const [sessionLoadError, setSessionLoadError] = useState("");
  const [sessionSaveState, setSessionSaveState] =
    useState<SessionSaveState>("idle");
  const [sessionSaveError, setSessionSaveError] = useState("");
  const [selectedSessionSlug, setSelectedSessionSlug] = useState(
    () => sessionSlugFromLocation() ?? "",
  );
  const [systemModules, setSystemModules] = useState(createSystemRackModules);
  const [modules, setModules] = useState<RackModuleState[]>([]);
  const [cables, setCables] = useState<PatchCable[]>([]);
  const [cableDraft, setCableDraft] = useState<CableDraft | null>(null);
  const [jackContextMenu, setJackContextMenu] =
    useState<JackContextMenuState | null>(null);
  const [moduleDrag, setModuleDrag] = useState<ModuleDrag | null>(null);
  const [moduleInsertTargetId, setModuleInsertTargetId] = useState<
    number | null
  >(null);
  const [moduleDragPreviewPoint, setModuleDragPreviewPoint] = useState<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const [connectionView, setConnectionView] = useState(false);
  const [toolbarAddKind, setToolbarAddKind] = useState(
    () => addableModuleGroups[0]?.definitions[0]?.kind ?? 0,
  );
  const [perfOpen, setPerfOpen] = useState(false);
  const [audioStats, setAudioStats] = useState(emptyAudioEngineStats);
  const [sampleAssetRevision, setSampleAssetRevision] = useState(0);
  const [scopeSnapshots, setScopeSnapshots] = useState<
    Record<number, ScopeSnapshot>
  >({});
  const [mixerMeters, setMixerMeters] = useState<
    Record<number, MixerMeterSnapshot>
  >({});
  const [moduleLevels, setModuleLevels] = useState<Record<number, number>>({});
  const [remoteCursors, setRemoteCursors] = useState<
    Record<string, RemoteSessionCursor>
  >({});
  const [remoteParamPreviews, setRemoteParamPreviews] = useState<
    Record<string, RemoteParamPreview>
  >({});
  const [audioState, setAudioState] = useState<
    "idle" | "starting" | "running" | "stopping"
  >("idle");
  const [tempoBpm, setTempoBpm] = useState(INITIAL_TEMPO_BPM);
  const [nextModuleId, setNextModuleId] = useState(1);
  const rackRef = useRef<HTMLDivElement | null>(null);
  const rackCanvasRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef(new ModularAudioEngine());
  const lastPersistedSignatureRef = useRef("");
  const lastSyncedDocumentRef = useRef<SessionDocumentV2 | null>(null);
  const lastSyncedHashRef = useRef("");
  const currentSessionDocumentRef = useRef<SessionDocumentV2 | null>(null);
  const currentSessionSignatureRef = useRef("");
  const selectedSessionSlugRef = useRef(selectedSessionSlug);
  const pendingSessionMutationsRef = useRef<SessionMutation[]>([]);
  const saveSequenceRef = useRef(0);
  const audioRunningRef = useRef(false);
  const sessionClientIdRef = useRef(createSessionClientId());
  const cursorSocketRef = useRef<WebSocket | null>(null);
  const sessionHasRemotePeersRef = useRef(false);
  const cursorThrottleTimerRef = useRef(0);
  const lastCursorSendAtRef = useRef(0);
  const pendingCursorRef = useRef<LocalSessionCursor | null>(null);
  const previewFrameRef = useRef(0);
  const pendingPreviewOpsRef = useRef<Record<string, SessionPatch[number]>>({});
  const moduleDragPointerRef = useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const moduleAutoScrollFrameRef = useRef(0);
  const sampleAssetsRef = useRef(new Map<string, ModuleRuntimeSampleAsset>());
  const loadingSampleAssetsRef = useRef(new Set<string>());

  const rackModules = useMemo(
    () => [...systemModules, ...modules],
    [systemModules, modules],
  );
  const previewedRackModules = useMemo(
    () => applyRemoteParamPreviews(rackModules, remoteParamPreviews),
    [rackModules, remoteParamPreviews],
  );
  const renderedRackModules = useMemo(
    () => layoutRackModulesForDisplay(
      previewedRackModules,
      moduleDefinitionMap,
      0,
    ),
    [previewedRackModules],
  );
  const activeUserId = authUserId(authRecord);
  const lockedModuleIds = useMemo(
    () => lockedAudioInputModuleIds(previewedRackModules, activeUserId),
    [previewedRackModules, activeUserId],
  );
  const audioEngineRack = useMemo(
    () =>
      rackForLocalAudioInputOwner(
        previewedRackModules,
        cables,
        activeUserId,
      ),
    [previewedRackModules, cables, activeUserId],
  );
  const jackContextMenuGroups = useMemo(
    () =>
      jackContextMenu
        ? jackDestinationGroups(
            jackContextMenu.source,
            renderedRackModules,
            moduleDefinitionMap,
            cables,
            lockedModuleIds,
          )
        : [],
    [jackContextMenu, renderedRackModules, cables, lockedModuleIds],
  );
  const userModulePresetsByKind = useMemo(() => {
    const byKind = new Map<number, ModulePresetOption[]>();
    for (const preset of userModulePresets) {
      const options = byKind.get(preset.moduleKind) ?? [];
      options.push({
        id: preset.id,
        name: preset.name,
        payload: preset.payload,
        source: "user",
      });
      byKind.set(preset.moduleKind, options);
    }
    return byKind;
  }, [userModulePresets]);
  const selectedSession = useMemo(
    () =>
      availableSessions.find(
        (session) => session.slug === selectedSessionSlug,
      ) ?? null,
    [availableSessions, selectedSessionSlug],
  );
  const currentSessionDocument = useMemo(
    () => documentForRackState(systemModules, modules, cables, tempoBpm),
    [systemModules, modules, cables, tempoBpm],
  );
  const currentSessionSignature = useMemo(
    () => canonicalSessionDocumentJson(currentSessionDocument),
    [currentSessionDocument],
  );
  const sessionStatus = sessionStatusFor(
    sessionLoadState,
    sessionLoadError,
    sessionSaveState,
    sessionSaveError,
    selectedSession?.readOnly ?? false,
  );
  const sessionErrorStatus =
    sessionStatus?.kind === "error" ? sessionStatus : null;
  const sessionInlineStatus =
    sessionStatus && sessionStatus.kind !== "error" ? sessionStatus : null;
  const canDeleteSelectedSession = Boolean(
    selectedSession &&
    !selectedSession.readOnly &&
    (!selectedSession.ownerId || selectedSession.ownerId === authRecord?.id),
  );

  const rackSize = useMemo(() => {
    const size = rackCanvasSize(renderedRackModules, moduleDefinitionMap);
    return {
      width: size.width,
      height: size.height + (connectionView ? 96 : 0),
    };
  }, [renderedRackModules, connectionView]);

  const paramCount = useMemo(
    () =>
      renderedRackModules.reduce(
        (count, module) => count + Object.keys(module.params).length,
        0,
      ),
    [renderedRackModules],
  );

  useEffect(() => {
    return pb.authStore.onChange((_token, record) => {
      setAuthRecord(pb.authStore.isValid ? record : null);
    }, true);
  }, []);

  useEffect(() => {
    selectedSessionSlugRef.current = selectedSessionSlug;
    currentSessionDocumentRef.current = currentSessionDocument;
    currentSessionSignatureRef.current = currentSessionSignature;
  }, [currentSessionDocument, currentSessionSignature, selectedSessionSlug]);

  useEffect(() => {
    if (!authRecord) {
      setSessionLoadState("idle");
      setSessionLoadError("");
      setSessionSaveState("idle");
      setSessionSaveError("");
      setUserModulePresets([]);
      return;
    }

    let cancelled = false;

    async function loadUserSessions() {
      setSessionLoadState("loading");
      setSessionLoadError("");
      try {
        let nextSessions = await fetchCurrentUserSessions();
        if (cancelled) {
          return;
        }
        const requestedSlug = sessionSlugFromLocation();
        let sessionToApply = requestedSlug
          ? (nextSessions.find((session) => session.slug === requestedSlug) ??
            null)
          : null;

        if (requestedSlug && !sessionToApply) {
          try {
            const sharedSession = await fetchSessionBySlug(requestedSlug);
            sessionToApply = sharedSession;
            nextSessions = upsertSession(nextSessions, sharedSession);
          } catch (error) {
            if (nextSessions.length === 0) {
              setSessionLoadError(errorMessage(error));
            }
          }
          if (cancelled) {
            return;
          }
        }

        sessionToApply ??=
          nextSessions.find(
            (session) => session.slug === selectedSessionSlug,
          ) ??
          nextSessions[0] ??
          null;

        setAvailableSessions(nextSessions);
        setSessionLoadState("ready");
        if (sessionToApply) {
          applySession(sessionToApply);
        } else {
          resetLocalRack();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setSessionLoadState("error");
        setSessionLoadError(errorMessage(error));
      }
    }

    loadUserSessions();
    return () => {
      cancelled = true;
    };
  }, [authRecord?.id]);

  useEffect(() => {
    if (!authRecord) {
      setUserModulePresets([]);
      return;
    }

    let cancelled = false;
    async function loadUserModulePresets() {
      try {
        const presets =
          await fetchCurrentUserModulePresets(moduleDefinitionMap);
        if (!cancelled) {
          setUserModulePresets(presets);
        }
      } catch (error) {
        if (!cancelled) {
          setSessionSaveState("error");
          setSessionSaveError(errorMessage(error));
        }
      }
    }

    loadUserModulePresets();
    return () => {
      cancelled = true;
    };
  }, [authRecord?.id]);

  useEffect(() => {
    if (!authRecord || sessionLoadState !== "ready" || !selectedSession) {
      return;
    }
    if (currentSessionSignature === lastPersistedSignatureRef.current) {
      return;
    }

    setSessionSaveState("dirty");
    setSessionSaveError("");

    const sequence = ++saveSequenceRef.current;
    const timer = window.setTimeout(() => {
      void persistSessionSnapshot(
        selectedSession,
        currentSessionSignature,
        sequence,
      );
    }, SESSION_AUTOSAVE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    authRecord?.id,
    sessionLoadState,
    selectedSession?.id,
    currentSessionSignature,
  ]);

  useEffect(() => {
    if (!authRecord || sessionLoadState !== "ready" || !selectedSessionSlug) {
      sessionHasRemotePeersRef.current = false;
      clearPeerRealtimeQueues();
      setRemoteCursors({});
      return;
    }

    let closed = false;
    let reconnectTimer = 0;

    const connect = () => {
      const socket = openSessionCursorSocket(
        selectedSessionSlug,
        sessionClientIdRef.current,
      );
      if (!socket) {
        return;
      }

      cursorSocketRef.current = socket;
      socket.onmessage = (event) => {
        const message = parseSessionSocketEvent(event.data);
        if (!message) {
          return;
        }
        if (message.type === "session_update") {
          void handleRemoteSessionUpdate(message);
          return;
        }
        if (message.type === "session_preview") {
          handleRemoteSessionPreview(message);
          return;
        }
        if (message.type === "session_presence") {
          sessionHasRemotePeersRef.current = message.connections > 1;
          if (!sessionHasRemotePeersRef.current) {
            clearPeerRealtimeQueues();
          }
          return;
        }
        if (message.type === "cursor_leave") {
          setRemoteCursors((current) =>
            omitRemoteCursor(current, message.clientId),
          );
          return;
        }

        setRemoteCursors((current) => ({
          ...current,
          [message.clientId]: message,
        }));
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (cursorSocketRef.current === socket) {
          cursorSocketRef.current = null;
        }
        sessionHasRemotePeersRef.current = false;
        clearPeerRealtimeQueues();
        if (!closed) {
          reconnectTimer = window.setTimeout(connect, 1_000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      sessionHasRemotePeersRef.current = false;
      clearPeerRealtimeQueues();
      cursorSocketRef.current?.close();
      cursorSocketRef.current = null;
      setRemoteCursors({});
      setRemoteParamPreviews({});
    };
  }, [authRecord?.id, sessionLoadState, selectedSessionSlug]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - REMOTE_CURSOR_TTL_MS;
      setRemoteCursors((current) => {
        let changed = false;
        const next: Record<string, RemoteSessionCursor> = {};
        for (const [clientId, cursor] of Object.entries(current)) {
          if (cursor.at < cutoff) {
            changed = true;
            continue;
          }
          next[clientId] = cursor;
        }
        return changed ? next : current;
      });
      setRemoteParamPreviews((current) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, RemoteParamPreview> = {};
        for (const [key, preview] of Object.entries(current)) {
          if (preview.expiresAt <= now) {
            changed = true;
            continue;
          }
          next[key] = preview;
        }
        return changed ? next : current;
      });
    }, 1_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const element = rackRef.current;
    if (
      !element ||
      !authRecord ||
      sessionLoadState !== "ready" ||
      !selectedSessionSlug
    ) {
      return;
    }

    const onPointerMove = (event: globalThis.PointerEvent) => {
      queueCursor(event, event.buttons > 0 ? "drag" : "move");
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      queueCursor(event, "down");
    };
    const onPointerUp = (event: globalThis.PointerEvent) => {
      queueCursor(event, "up");
    };

    element.addEventListener("pointermove", onPointerMove, { capture: true });
    element.addEventListener("pointerdown", onPointerDown, { capture: true });
    element.addEventListener("pointerup", onPointerUp, { capture: true });
    return () => {
      element.removeEventListener("pointermove", onPointerMove, {
        capture: true,
      });
      element.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      element.removeEventListener("pointerup", onPointerUp, { capture: true });
      if (cursorThrottleTimerRef.current) {
        window.clearTimeout(cursorThrottleTimerRef.current);
        cursorThrottleTimerRef.current = 0;
      }
      pendingCursorRef.current = null;
    };
  }, [authRecord?.id, sessionLoadState, selectedSessionSlug, connectionView]);

  useEffect(() => {
    engineRef.current.setStatsListener(setAudioStats);
    return () => engineRef.current.setStatsListener(null);
  }, []);

  useEffect(() => {
    engineRef.current.setScopeListener((snapshots) => {
      setScopeSnapshots((current) => {
        const next = { ...current };
        for (const snapshot of snapshots) {
          next[snapshot.moduleId] = snapshot;
        }
        return next;
      });
    });
    return () => engineRef.current.setScopeListener(null);
  }, []);

  useEffect(() => {
    engineRef.current.setMixerMeterListener((meters) => {
      setMixerMeters((current) => {
        const next = { ...current };
        for (const meter of meters) {
          next[meter.moduleId] = meter;
        }
        return next;
      });
    });
    return () => engineRef.current.setMixerMeterListener(null);
  }, []);

  useEffect(() => {
    engineRef.current.setModuleLevelListener((levels) => {
      setModuleLevels((current) => mergeModuleLevels(current, levels));
    });
    return () => engineRef.current.setModuleLevelListener(null);
  }, []);

  useEffect(() => {
    engineRef.current.setTransportStepListener((transport) => {
      if (!audioRunningRef.current) {
        return;
      }
      const rackCanvas = rackCanvasRef.current;
      if (!rackCanvas) {
        return;
      }
      updateTransportPlayhead(rackCanvas, transport);
    });
    return () => engineRef.current.setTransportStepListener(null);
  }, []);

  useEffect(() => {
    engineRef.current.syncRack(
      audioEngineRack.modules,
      audioEngineRack.cables,
      tempoBpm,
      sampleAssetsRef.current,
    );
  }, [audioEngineRack, tempoBpm, sampleAssetRevision]);

  useEffect(() => {
    for (const module of rackModules) {
      if (module.sample) {
        ensureRuntimeSampleAsset(module.sample);
      }
    }
  }, [rackModules]);

  useEffect(() => {
    audioRunningRef.current = audioState === "running";
    if (audioState !== "running") {
      clearTransportPlayhead(rackCanvasRef.current);
    }
  }, [audioState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableEventTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      setCableDraft(null);
      setJackContextMenu(null);
      setConnectionView((current) => !current);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  useEffect(() => {
    if (!jackContextMenu) {
      return;
    }

    const closeMenu = () => setJackContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [jackContextMenu]);

  useEffect(() => {
    if (!connectionView) {
      setJackContextMenu(null);
    }
  }, [connectionView]);

  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (moduleDrag && event.pointerId === moduleDrag.pointerId) {
        moduleDragPointerRef.current = {
          clientX: event.clientX,
          clientY: event.clientY,
        };
        setModuleDragPreviewPoint(moduleDragPointerRef.current);
        updateModuleDragForClientPoint(moduleDrag, event.clientX, event.clientY);
      }

      if (cableDraft) {
        const point = rackPoint(event.clientX, event.clientY);
        if (point) {
          const snapTarget = nearestCompatibleEndpoint(
            cableDraft.anchor,
            point,
            renderedRackModules,
            moduleDefinitionMap,
            lockedModuleIds,
          );
          const snapPoint = snapTarget
            ? (endpointPosition(snapTarget, renderedRackModules, moduleDefinitionMap) ??
              point)
            : point;
          setCableDraft({ ...cableDraft, pointer: snapPoint, snapTarget });
        }
      }
    };

    const onPointerUp = (event: globalThis.PointerEvent) => {
      if (moduleDrag) {
        if (event.pointerId !== moduleDrag.pointerId) {
          return;
        }
        const point = rackPoint(event.clientX, event.clientY);
        const insertTarget = point
          ? moduleAudioInsertTargetAtPoint(moduleDrag.moduleId, point)
          : null;
        if (insertTarget) {
          insertFxModuleIntoAudioPath(moduleDrag.moduleId, insertTarget.id);
        }
        setModuleInsertTargetId(null);
        setModuleDragPreviewPoint(null);
        moduleDragPointerRef.current = null;
        setModuleDrag(null);
      }
      if (cableDraft) {
        const point = rackPoint(event.clientX, event.clientY);
        const snapTarget =
          cableDraft.snapTarget ??
          (point
            ? nearestCompatibleEndpoint(
                cableDraft.anchor,
                point,
                renderedRackModules,
                moduleDefinitionMap,
                lockedModuleIds,
              )
            : null);
        if (snapTarget) {
          upsertCable(cableDraft.anchor, snapTarget, cableDraft.cableId);
        }
      }
      setCableDraft(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [
    moduleDrag,
    cableDraft,
    modules,
    cables,
    renderedRackModules,
    lockedModuleIds,
  ]);

  useEffect(() => {
    if (!moduleDrag) {
      return;
    }

    const tick = () => {
      const rack = rackRef.current;
      const pointer = moduleDragPointerRef.current;
      if (rack && pointer) {
        const rect = rack.getBoundingClientRect();
        const velocity = moduleDragAutoScrollVelocity(pointer.clientY, rect);
        if (velocity !== 0) {
          const previousScrollTop = rack.scrollTop;
          rack.scrollTop += velocity;
          if (rack.scrollTop !== previousScrollTop) {
            updateModuleDragForClientPoint(
              moduleDrag,
              pointer.clientX,
              pointer.clientY,
            );
          }
        }
      }
      moduleAutoScrollFrameRef.current = window.requestAnimationFrame(tick);
    };

    moduleAutoScrollFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(moduleAutoScrollFrameRef.current);
      moduleAutoScrollFrameRef.current = 0;
    };
  }, [
    moduleDrag,
    modules,
    cables,
    renderedRackModules,
    lockedModuleIds,
  ]);

  async function toggleAudio() {
    if (audioState === "starting" || audioState === "stopping") {
      return;
    }

    if (audioState === "running") {
      setAudioState("stopping");
      audioRunningRef.current = false;
      clearTransportPlayhead(rackCanvasRef.current);
      await engineRef.current.stop({ resetTransport: true });
      setAudioState("idle");
      return;
    }

    try {
      setAudioState("starting");
      clearTransportPlayhead(rackCanvasRef.current);
      await engineRef.current.start({ resetTransport: true });
      engineRef.current.syncRack(
        audioEngineRack.modules,
        audioEngineRack.cables,
        tempoBpm,
        sampleAssetsRef.current,
      );
      audioRunningRef.current = true;
      setAudioState("running");
      engineRef.current.armTransportStep();
    } catch (error) {
      audioRunningRef.current = false;
      clearTransportPlayhead(rackCanvasRef.current);
      setAudioState("idle");
      throw error;
    }
  }

  function updateTempo(value: number) {
    const nextTempo = Math.min(300, Math.max(20, value));
    if (Object.is(tempoBpm, nextTempo)) {
      return;
    }
    enqueueSessionMutation({ type: "setTempo", tempoBpm: nextTempo });
    setTempoBpm(nextTempo);
    engineRef.current.setTempo(nextTempo);
  }

  function exportLoop(moduleId: number, slot: number) {
    return engineRef.current.requestLoopExport(moduleId, slot);
  }

  function syncEngineRackForCurrentUser(
    nextRackModules: RackModuleState[],
    nextCables: PatchCable[],
    nextTempoBpm: number,
  ) {
    const localRack = rackForLocalAudioInputOwner(
      nextRackModules,
      nextCables,
      authUserId(authRecord),
    );
    engineRef.current.syncRack(
      localRack.modules,
      localRack.cables,
      nextTempoBpm,
      sampleAssetsRef.current,
    );
  }

  function isLockedModule(moduleId: number) {
    return lockedModuleIds.has(moduleId);
  }

  function isLockedEndpoint(endpoint: CableEndpoint) {
    return lockedModuleIds.has(endpoint.moduleId);
  }

  function isLockedCable(cable: PatchCable) {
    return cableTouchesLockedModule(cable, lockedModuleIds);
  }

  function enqueueSessionMutation(mutation: SessionMutation) {
    pendingSessionMutationsRef.current = appendSessionMutation(
      pendingSessionMutationsRef.current,
      mutation,
    );
  }

  function clearPendingSessionMutations() {
    pendingSessionMutationsRef.current = [];
  }

  function removePendingSessionMutations(
    mutations: readonly SessionMutation[],
  ) {
    pendingSessionMutationsRef.current = removeAppliedSessionMutations(
      pendingSessionMutationsRef.current,
      mutations,
    );
  }

  function queueCursor(
    event: globalThis.PointerEvent,
    state: LocalSessionCursor["state"],
  ) {
    if (!selectedSessionSlug || !sessionHasRemotePeersRef.current) {
      return;
    }
    const target = rackCollabTarget(event);
    if (!target) {
      return;
    }

    const payload: LocalSessionCursor = {
      targetPath: target.path,
      x: target.x,
      y: target.y,
      mode: connectionView ? "patch" : "control",
      state,
    };

    pendingCursorRef.current = payload;
    if (cursorThrottleTimerRef.current) {
      return;
    }

    const now = performance.now();
    const elapsed = now - lastCursorSendAtRef.current;
    const wait = Math.max(0, CURSOR_SEND_INTERVAL_MS - elapsed);
    cursorThrottleTimerRef.current = window.setTimeout(() => {
      cursorThrottleTimerRef.current = 0;
      flushCursor();
    }, wait);
  }

  function flushCursor() {
    const next = pendingCursorRef.current;
    pendingCursorRef.current = null;
    if (next && sessionHasRemotePeersRef.current) {
      lastCursorSendAtRef.current = performance.now();
      sendCursor(next);
    }
  }

  function sendCursor(payload: LocalSessionCursor) {
    if (!sessionHasRemotePeersRef.current) {
      return;
    }
    const socket = cursorSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  function sendCursorLeave() {
    pendingCursorRef.current = null;
    if (cursorThrottleTimerRef.current) {
      window.clearTimeout(cursorThrottleTimerRef.current);
      cursorThrottleTimerRef.current = 0;
    }
    const socket = cursorSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: "cursor_leave" }));
  }

  function clearPeerRealtimeQueues() {
    if (cursorThrottleTimerRef.current) {
      window.clearTimeout(cursorThrottleTimerRef.current);
      cursorThrottleTimerRef.current = 0;
    }
    pendingCursorRef.current = null;
    if (previewFrameRef.current) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = 0;
    }
    pendingPreviewOpsRef.current = {};
  }

  async function loadSession(sessionSlug: string) {
    if (sessionSlug === selectedSessionSlug) {
      return;
    }
    const flushed = await flushCurrentSession();
    if (!flushed) {
      return;
    }

    let session = availableSessions.find(
      (candidate) => candidate.slug === sessionSlug,
    );
    if (!session) {
      try {
        const fetchedSession = await fetchSessionBySlug(sessionSlug);
        session = fetchedSession;
        setAvailableSessions((current) =>
          upsertSession(current, fetchedSession),
        );
      } catch (error) {
        setSessionSaveState("error");
        setSessionSaveError(errorMessage(error));
        return;
      }
    }

    applySession(session);
  }

  function resetLocalRack() {
    const nextSystemModules = createSystemRackModules();
    const nextModules: RackModuleState[] = [];
    const nextCables: PatchCable[] = [];
    const nextDocument = documentForRackState(
      nextSystemModules,
      nextModules,
      nextCables,
      INITIAL_TEMPO_BPM,
    );
    lastPersistedSignatureRef.current =
      canonicalSessionDocumentJson(nextDocument);
    currentSessionSignatureRef.current = lastPersistedSignatureRef.current;
    lastSyncedDocumentRef.current = null;
    lastSyncedHashRef.current = "";
    selectedSessionSlugRef.current = "";
    clearPendingSessionMutations();
    saveSequenceRef.current += 1;

    setSelectedSessionSlug("");
    setSystemModules(nextSystemModules);
    setModules(nextModules);
    setCables(nextCables);
    setTempoBpm(INITIAL_TEMPO_BPM);
    setCableDraft(null);
    setModuleDrag(null);
    setModuleInsertTargetId(null);
    setModuleDragPreviewPoint(null);
    setScopeSnapshots({});
    setMixerMeters({});
    setModuleLevels({});
    setRemoteParamPreviews({});
    setSessionSaveState("idle");
    setSessionSaveError("");
    setNextModuleId(1);
    engineRef.current.setTempo(INITIAL_TEMPO_BPM);
    syncEngineRackForCurrentUser(
      nextSystemModules,
      nextCables,
      INITIAL_TEMPO_BPM,
    );
  }

  function applySession(session: SavedSession) {
    const nextSystemModules = systemModulesForSession(session, systemModules);
    const localModules =
      session.slug === selectedSessionSlug ? modules : [];
    const nextModules = normalizeRackLayout(
      supportedRackModules(cloneModules(session.modules)).map((module) =>
        preserveSessionLocalModuleState(
          module,
          localModules.find((candidate) => candidate.id === module.id),
        ),
      ),
      moduleDefinitionMap,
      SYSTEM_RACK_ROWS,
    );
    const nextCables = sanitizeCablesForRack(
      [...nextSystemModules, ...nextModules],
      cloneCables(session.cables),
    );
    const nextDocument = documentForRackState(
      nextSystemModules,
      nextModules,
      nextCables,
      session.tempoBpm,
    );
    lastPersistedSignatureRef.current =
      canonicalSessionDocumentJson(nextDocument);
    currentSessionSignatureRef.current = lastPersistedSignatureRef.current;
    lastSyncedDocumentRef.current = nextDocument;
    lastSyncedHashRef.current = session.documentHash ?? "";
    selectedSessionSlugRef.current = session.slug;
    clearPendingSessionMutations();
    saveSequenceRef.current += 1;

    setSelectedSessionSlug(session.slug);
    replaceSessionUrl(session.slug);
    setSystemModules(nextSystemModules);
    setModules(nextModules);
    setCables(nextCables);
    setTempoBpm(session.tempoBpm);
    setCableDraft(null);
    setModuleDrag(null);
    setModuleInsertTargetId(null);
    setModuleDragPreviewPoint(null);
    setScopeSnapshots({});
    setMixerMeters({});
    setModuleLevels({});
    setRemoteParamPreviews({});
    setSessionSaveState("saved");
    setSessionSaveError("");
    setNextModuleId(nextModuleIdFor(session.modules));
    engineRef.current.setTempo(session.tempoBpm);
    syncEngineRackForCurrentUser(
      [...nextSystemModules, ...nextModules],
      nextCables,
      session.tempoBpm,
    );
  }

  function applySessionDocument(
    slug: string,
    document: SessionDocumentV2,
    hash: string,
    localDocument: SessionDocumentV2 | null = null,
  ) {
    const renderDocument = localDocument ?? document;
    const parts = documentToSessionParts(renderDocument);
    const supportedModules = supportedRackModules(parts.modules).map((module) =>
      preserveSessionLocalModuleState(
        module,
        modules.find((candidate) => candidate.id === module.id),
      ),
    );
    const nextSystemModules = systemModulesForSession(
      {
        ...(selectedSession ?? {
          id: slug,
          slug,
          name: "Shared Session",
          description: "",
        }),
        tempoBpm: parts.tempoBpm,
        documentHash: hash,
        systemModules: parts.systemModules,
        modules: supportedModules,
        cables: parts.cables,
      },
      systemModules,
    );
    const nextModules = normalizeRackLayout(
      cloneModules(supportedModules),
      moduleDefinitionMap,
      SYSTEM_RACK_ROWS,
    );
    const nextCables = sanitizeCablesForRack(
      [...nextSystemModules, ...nextModules],
      cloneCables(parts.cables),
    );
    const nextDocument = documentForRackState(
      nextSystemModules,
      nextModules,
      nextCables,
      parts.tempoBpm,
    );
    const syncedSignature = canonicalSessionDocumentJson(document);
    const localSignature = canonicalSessionDocumentJson(nextDocument);
    const hasLocalChanges = localSignature !== syncedSignature;

    lastSyncedDocumentRef.current = document;
    lastSyncedHashRef.current = hash;
    selectedSessionSlugRef.current = slug;
    lastPersistedSignatureRef.current = syncedSignature;
    currentSessionDocumentRef.current = nextDocument;
    currentSessionSignatureRef.current = localSignature;
    if (!hasLocalChanges) {
      clearPendingSessionMutations();
    }
    saveSequenceRef.current += 1;

    setSelectedSessionSlug(slug);
    replaceSessionUrl(slug);
    setSystemModules(nextSystemModules);
    setModules(nextModules);
    setCables(nextCables);
    setTempoBpm(parts.tempoBpm);
    setCableDraft(null);
    setModuleDrag(null);
    setModuleInsertTargetId(null);
    setModuleDragPreviewPoint(null);
    setScopeSnapshots({});
    setMixerMeters({});
    setModuleLevels({});
    setRemoteParamPreviews({});
    setSessionSaveState(hasLocalChanges ? "dirty" : "saved");
    setSessionSaveError("");
    setNextModuleId(nextModuleIdFor(parts.modules));
    setAvailableSessions((current) =>
      current.map((candidate) =>
        candidate.slug === slug
          ? sessionFromDocument(candidate, document, hash)
          : candidate,
      ),
    );
    engineRef.current.setTempo(parts.tempoBpm);
    syncEngineRackForCurrentUser(
      [...nextSystemModules, ...nextModules],
      nextCables,
      parts.tempoBpm,
    );
  }

  async function handleRemoteSessionUpdate(update: SessionRealtimeUpdate) {
    if (!update || update.slug !== selectedSessionSlug) {
      return;
    }
    if (update.clientId && update.clientId === sessionClientIdRef.current) {
      return;
    }
    if (update.hash && update.hash === lastSyncedHashRef.current) {
      return;
    }

    const baseDocument = lastSyncedDocumentRef.current;
    const isLocallyDirty =
      currentSessionSignatureRef.current !== lastPersistedSignatureRef.current;
    if (!baseDocument || update.baseHash !== lastSyncedHashRef.current) {
      try {
        await reloadSelectedSessionFromServer(update.slug);
      } catch (error) {
        setSessionSaveState("error");
        setSessionSaveError(errorMessage(error));
      }
      return;
    }

    try {
      const nextDocument = applySessionPatch(baseDocument, update.patch);
      const nextHash = await sessionDocumentHash(nextDocument);
      if (update.hash && update.hash !== nextHash) {
        throw new Error("Remote session update hash mismatch.");
      }
      if (isLocallyDirty) {
        const localDocument = currentSessionDocumentRef.current;
        if (!localDocument) {
          throw new Error("Missing local session document.");
        }
        const pendingMutations = pendingSessionMutationsRef.current;
        const localPatch = pendingMutations.length
          ? rebaseableSessionMutationsToPatch(baseDocument, pendingMutations)
          : null;
        if (!localPatch) {
          throw new Error("Remote update conflicted with local structural edits.");
        }
        const rebasedLocalDocument =
          localPatch.length === 0
            ? nextDocument
            : applySessionPatch(nextDocument, localPatch);
        applySessionDocument(update.slug, nextDocument, nextHash, rebasedLocalDocument);
      } else {
        applySessionDocument(update.slug, nextDocument, nextHash);
      }
      setRemoteParamPreviews({});
    } catch {
      try {
        await reloadSelectedSessionFromServer(update.slug);
      } catch (error) {
        setSessionSaveState("error");
        setSessionSaveError(errorMessage(error));
      }
    }
  }

  function handleRemoteSessionPreview(update: SessionSocketEvent) {
    if (
      update.type !== "session_preview" ||
      update.slug !== selectedSessionSlug ||
      update.clientId === sessionClientIdRef.current
    ) {
      return;
    }

    const previews = previewParamsFromPatch(
      update.patch,
      update.clientId,
      Date.now() + REMOTE_PARAM_PREVIEW_TTL_MS,
    );
    if (previews.length === 0) {
      return;
    }

    setRemoteParamPreviews((current) => {
      const next = { ...current };
      for (const preview of previews) {
        next[preview.path] = preview;
      }
      return next;
    });
  }

  async function reloadSelectedSessionFromServer(slug: string) {
    const latest = await fetchSessionBySlug(slug);
    setAvailableSessions((current) => upsertSession(current, latest));
    applySession(latest);
  }

  async function persistSessionSnapshot(
    session: SavedSession,
    signature: string,
    sequence: number,
  ) {
    setSessionSaveState("saving");
    setSessionSaveError("");

    const pendingMutations = [...pendingSessionMutationsRef.current];
    const markSaved = (document: SessionDocumentV2, hash: string) => {
      const syncedSignature = canonicalSessionDocumentJson(document);
      removePendingSessionMutations(pendingMutations);
      const hasRemainingLocalMutations =
        pendingSessionMutationsRef.current.length > 0;
      lastSyncedDocumentRef.current = document;
      lastSyncedHashRef.current = hash;
      lastPersistedSignatureRef.current = hasRemainingLocalMutations
        ? syncedSignature
        : signature;
      if (!hasRemainingLocalMutations) {
        currentSessionSignatureRef.current = signature;
      }
      setAvailableSessions((current) =>
        current.map((candidate) =>
          candidate.id === session.id || candidate.slug === session.slug
            ? sessionFromDocument(candidate, document, hash)
            : candidate,
        ),
      );
      setSessionSaveState(hasRemainingLocalMutations ? "dirty" : "saved");
      setSessionSaveError("");
    };

    let attemptedMutations: readonly SessionMutation[] = pendingMutations;
    try {
      let baseDocument = lastSyncedDocumentRef.current;
      let baseHash = lastSyncedHashRef.current;
      if (!baseDocument || !baseHash) {
        baseDocument = documentForSavedSession(session);
        baseHash =
          session.documentHash ?? (await sessionDocumentHash(baseDocument));
        lastSyncedDocumentRef.current = baseDocument;
        lastSyncedHashRef.current = baseHash;
      }

      if (pendingMutations.length === 0) {
        setSessionSaveState("error");
        setSessionSaveError(
          "Session changed without a session mutation; not saved.",
        );
        return false;
      }

      const patch = sessionMutationsToPatch(baseDocument, pendingMutations);
      if (patch.length === 0) {
        removePendingSessionMutations(pendingMutations);
        if (pendingSessionMutationsRef.current.length === 0) {
          lastPersistedSignatureRef.current = signature;
          currentSessionSignatureRef.current = signature;
          setSessionSaveState("saved");
        } else {
          lastPersistedSignatureRef.current = canonicalSessionDocumentJson(baseDocument);
          setSessionSaveState("dirty");
        }
        return true;
      }

      const savedSession = await submitSessionUpdate(
        session.slug,
        baseHash,
        pendingMutations,
        sessionClientIdRef.current,
      );

      if (selectedSessionSlugRef.current !== session.slug) {
        return false;
      }

      markSaved(savedSession.document, savedSession.hash);
      return true;
    } catch (error) {
      if (sequence !== saveSequenceRef.current) {
        return false;
      }
      if (isRebaseableSessionUpdateError(error)) {
        try {
          const latest = await fetchSessionBySlug(session.slug);
          const latestDocument = documentForSavedSession(latest);
          const latestHash =
            latest.documentHash ?? (await sessionDocumentHash(latestDocument));
          const rebasedPatch = rebaseableSessionMutationsToPatch(
            latestDocument,
            attemptedMutations,
          );
          if (!rebasedPatch) {
            applySession(latest);
            setSessionSaveState("error");
            setSessionSaveError(
              "Session changed; local structural edit was not saved.",
            );
            return false;
          }
          if (rebasedPatch.length === 0) {
            markSaved(latestDocument, latestHash);
            return true;
          }

          const savedSession = await submitSessionUpdate(
            session.slug,
            latestHash,
            attemptedMutations,
            sessionClientIdRef.current,
          );
          if (selectedSessionSlugRef.current !== session.slug) {
            return false;
          }
          markSaved(savedSession.document, savedSession.hash);
          return true;
        } catch (rebaseError) {
          setSessionSaveState("error");
          setSessionSaveError(errorMessage(rebaseError));
          return false;
        }
      }
      setSessionSaveState("error");
      setSessionSaveError(errorMessage(error));
      return false;
    }
  }

  async function flushCurrentSession() {
    if (!authRecord || sessionLoadState !== "ready" || !selectedSession) {
      return true;
    }
    if (currentSessionSignature === lastPersistedSignatureRef.current) {
      return true;
    }

    const sequence = ++saveSequenceRef.current;
    return persistSessionSnapshot(
      selectedSession,
      currentSessionSignature,
      sequence,
    );
  }

  async function createNewSession() {
    if (!authRecord || sessionLoadState !== "ready") {
      return;
    }

    const sessionName = promptNewSessionName(
      nextUntitledSessionName(availableSessions),
    );
    if (!sessionName) {
      return;
    }

    const flushed = await flushCurrentSession();
    if (!flushed) {
      return;
    }

    setSessionSaveState("saving");
    setSessionSaveError("");

    const initialRack = defaultNewSessionRack();
    const sharedInitialModules = modulesForSharedSessionDocument(
      initialRack.modules,
    );
    const draft: SessionDraft = {
      name: sessionName,
      description: "",
      tempoBpm: INITIAL_TEMPO_BPM,
      systemModules: initialRack.systemModules,
      modules: sharedInitialModules,
      cables: initialRack.cables,
    };

    try {
      const createdSession = await createCurrentUserSession(draft);
      const sessionWithLocalDefaultState = {
        ...createdSession,
        modules: withDefaultNewSessionLocalState(
          createdSession.modules,
          initialRack.modules,
        ),
      };
      setAvailableSessions((current) => [
        ...current,
        sessionWithLocalDefaultState,
      ]);
      applySession(sessionWithLocalDefaultState);
    } catch (error) {
      setSessionSaveState("error");
      setSessionSaveError(errorMessage(error));
    }
  }

  async function deleteSelectedSession() {
    if (
      !authRecord ||
      sessionLoadState !== "ready" ||
      !selectedSession ||
      !canDeleteSelectedSession
    ) {
      return;
    }
    if (!confirmDeleteSession(selectedSession.name)) {
      return;
    }

    const sessionToDelete = selectedSession;
    const currentIndex = availableSessions.findIndex(
      (session) =>
        session.id === sessionToDelete.id ||
        session.slug === sessionToDelete.slug,
    );
    const remainingSessions = availableSessions.filter(
      (session) =>
        session.id !== sessionToDelete.id &&
        session.slug !== sessionToDelete.slug,
    );
    const nextSession =
      remainingSessions[
        Math.min(Math.max(currentIndex, 0), remainingSessions.length - 1)
      ] ?? null;

    saveSequenceRef.current += 1;
    setSessionSaveState("saving");
    setSessionSaveError("");

    try {
      await deleteCurrentUserSession(sessionToDelete.id);
      setAvailableSessions(remainingSessions);
      if (nextSession) {
        applySession(nextSession);
      } else {
        resetLocalRack();
        clearSessionUrl();
      }
    } catch (error) {
      setSessionSaveState("error");
      setSessionSaveError(errorMessage(error));
    }
  }

  async function logOut() {
    const flushed = await flushCurrentSession();
    if (!flushed) {
      return;
    }

    if (audioState === "running") {
      setAudioState("stopping");
      audioRunningRef.current = false;
      clearTransportPlayhead(rackCanvasRef.current);
      await engineRef.current.stop();
      setAudioState("idle");
    }

    pb.authStore.clear();
    setAvailableSessions([]);
    setUserModulePresets([]);
    resetLocalRack();
  }

  function updateParam(moduleId: number, paramId: number, value: number) {
    if (isLockedModule(moduleId)) {
      return;
    }
    const targetModule = isSystemModuleId(moduleId)
      ? systemModules.find((module) => module.id === moduleId)
      : modules.find((module) => module.id === moduleId);
    const currentValue =
      targetModule?.params[paramId] ??
      (targetModule ? sparseDefaultParamValue(targetModule.kind, paramId) : undefined);
    if (!targetModule || Object.is(currentValue, value)) {
      return;
    }
    enqueueSessionMutation({
      type: "setModuleParam",
      moduleId,
      paramId,
      value,
    });
    const update = (module: RackModuleState) => {
      if (module.id !== moduleId) {
        return module;
      }
      return {
        ...module,
        params: compactParamsForKind(module.kind, {
          ...module.params,
          [paramId]: value,
        }),
      };
    };
    const updateCollection = (current: RackModuleState[]) => {
      let changed = false;
      const next = current.map((module) => {
        const updated = update(module);
        if (updated !== module) {
          changed = true;
        }
        return updated;
      });
      return changed ? next : current;
    };

    if (isSystemModuleId(moduleId)) {
      setSystemModules(updateCollection);
    } else {
      setModules(updateCollection);
    }
    engineRef.current.setFloatParam(moduleId, paramId, value);
    queueParamPreview(moduleId, paramId, value);
  }

  function updateModuleParams(
    moduleId: number,
    values: Record<number, number>,
  ) {
    if (isLockedModule(moduleId)) {
      return;
    }
    const targetModule = isSystemModuleId(moduleId)
      ? systemModules.find((module) => module.id === moduleId)
      : modules.find((module) => module.id === moduleId);
    if (!targetModule) {
      return;
    }

    const changedParams = Object.entries(values)
      .map(([paramIdKey, rawValue]) => [Number(paramIdKey), rawValue] as const)
      .filter(
        ([paramId, value]) =>
          Number.isInteger(paramId) &&
          Number.isFinite(value) &&
          !Object.is(
            targetModule.params[paramId] ??
              sparseDefaultParamValue(targetModule.kind, paramId),
            value,
          ),
      );
    if (changedParams.length === 0) {
      return;
    }

    const normalizedParams = Object.fromEntries(changedParams);
    enqueueSessionMutation({
      type: "setModuleParams",
      moduleId,
      values: normalizedParams,
    });
    const update = (module: RackModuleState) => {
      if (module.id !== moduleId) {
        return module;
      }
      return {
        ...module,
        params: compactParamsForKind(module.kind, {
          ...module.params,
          ...normalizedParams,
        }),
      };
    };
    const updateCollection = (current: RackModuleState[]) => {
      let changed = false;
      const next = current.map((module) => {
        const updated = update(module);
        if (updated !== module) {
          changed = true;
        }
        return updated;
      });
      return changed ? next : current;
    };

    if (isSystemModuleId(moduleId)) {
      setSystemModules(updateCollection);
    } else {
      setModules(updateCollection);
    }
    for (const [paramId, value] of changedParams) {
      engineRef.current.setFloatParam(moduleId, paramId, value);
    }
  }

  function updateRuntimeParam(
    moduleId: number,
    paramId: number,
    value: number,
  ) {
    if (isLockedModule(moduleId)) {
      return;
    }
    const module = rackModules.find((candidate) => candidate.id === moduleId);
    if (!module) {
      return;
    }
    engineRef.current.setRuntimeFloatParam(
      moduleId,
      module.kind,
      paramId,
      value,
    );
  }

  function updateModuleSample(
    moduleId: number,
    sample: ModuleSampleState | undefined,
    runtimeAsset?: ModuleRuntimeSampleAsset,
  ) {
    if (isLockedModule(moduleId)) {
      return;
    }
    const targetModule = isSystemModuleId(moduleId)
      ? systemModules.find((module) => module.id === moduleId)
      : modules.find((module) => module.id === moduleId);
    if (!targetModule) {
      return;
    }
    const assetToStore =
      sample
        ? mergeRuntimeSampleAsset(
            sample,
            runtimeAsset,
            targetModule?.sample,
            sampleAssetsRef.current,
          )
        : undefined;
    if (sample && assetToStore) {
      sampleAssetsRef.current.set(sample.assetId, assetToStore);
      setSampleAssetRevision((revision) => revision + 1);
    }

    if (moduleSampleSignature(targetModule?.sample) === moduleSampleSignature(sample)) {
      return;
    }

    enqueueSessionMutation({
      type: "setModuleSample",
      moduleId,
      sample,
    });

    const update = (module: RackModuleState) => {
      if (module.id !== moduleId) {
        return module;
      }
      return moduleWithSample(module, sample);
    };

    if (isSystemModuleId(moduleId)) {
      setSystemModules((current) => current.map(update));
    } else {
      setModules((current) => current.map(update));
    }
  }

  function updateModuleText(
    moduleId: number,
    text: ModuleTextState | undefined,
  ) {
    if (isLockedModule(moduleId)) {
      return;
    }
    const targetModule = isSystemModuleId(moduleId)
      ? systemModules.find((module) => module.id === moduleId)
      : modules.find((module) => module.id === moduleId);
    if (
      !targetModule ||
      moduleTextSignature(targetModule.text) === moduleTextSignature(text)
    ) {
      return;
    }

    const update = (module: RackModuleState) => {
      if (module.id !== moduleId) {
        return module;
      }
      return moduleWithText(module, text);
    };

    enqueueSessionMutation({
      type: "setModuleText",
      moduleId,
      text,
    });
    if (isSystemModuleId(moduleId)) {
      setSystemModules((current) => current.map(update));
    } else {
      setModules((current) => current.map(update));
    }
    engineRef.current.setModuleText(moduleId, text);
  }

  function ensureRuntimeSampleAsset(sample: ModuleSampleState) {
    if (
      sampleAssetsRef.current.has(sample.assetId) ||
      loadingSampleAssetsRef.current.has(sample.assetId)
    ) {
      return;
    }

    loadingSampleAssetsRef.current.add(sample.assetId);
    const loader =
      sample.kind === "loop"
        ? loadLoopRuntimeAsset(sample)
        : loadSamplerRuntimeAsset(sample);

    void loader
      .then((loaded) => {
        sampleAssetsRef.current.set(sample.assetId, loaded);
        setSampleAssetRevision((revision) => revision + 1);
      })
      .catch((error) => {
        setSessionSaveState("error");
        setSessionSaveError(errorMessage(error));
      })
      .finally(() => {
        loadingSampleAssetsRef.current.delete(sample.assetId);
      });
  }

  function applyModulePreset(moduleId: number, presetId: string) {
    if (isLockedModule(moduleId)) {
      return;
    }
    const module = rackModules.find((candidate) => candidate.id === moduleId);
    if (!module) {
      return;
    }

    const definition = definitionForKind(module.kind);
    const userPreset = userModulePresets.find(
      (preset) => preset.id === presetId,
    );
    const factoryPreset = definition.presets?.find(
      (preset) => preset.id === presetId,
    );
    const preset = userPreset ?? factoryPreset;
    if (!preset) {
      return;
    }

    try {
      replaceModuleParams(
        module,
        paramsFromModulePresetPayload(
          preset.payload,
          definition,
          module.params,
        ),
      );
    } catch (error) {
      setSessionSaveState("error");
      setSessionSaveError(errorMessage(error));
    }
  }

  async function saveModulePreset(moduleId: number) {
    if (isLockedModule(moduleId)) {
      return;
    }
    if (!authRecord) {
      return;
    }

    const module = rackModules.find((candidate) => candidate.id === moduleId);
    if (!module) {
      return;
    }

    const definition = definitionForKind(module.kind);
    if (!definition.presets) {
      return;
    }

    const name = promptModulePresetName(`${definition.name} preset`);
    if (!name) {
      return;
    }

    try {
      const created = await createCurrentUserModulePreset({
        name,
        definition,
        payload: modulePresetPayloadFor(module, definition),
      });
      if (created) {
        setUserModulePresets((current) => [
          created,
          ...current.filter((preset) => preset.id !== created.id),
        ]);
      }
    } catch (error) {
      setSessionSaveState("error");
      setSessionSaveError(errorMessage(error));
    }
  }

  function replaceModuleParams(
    module: RackModuleState,
    nextParams: RackModuleState["params"],
  ) {
    if (isLockedModule(module.id)) {
      return;
    }
    const changedParams = Object.entries(nextParams)
      .map(([paramId, value]) => [Number(paramId), value] as const)
      .filter(
        ([paramId, value]) =>
          !Object.is(
            module.params[paramId] ??
              sparseDefaultParamValue(module.kind, paramId),
            value,
          ),
      );
    if (changedParams.length === 0) {
      return;
    }

    const normalizedParams = Object.fromEntries(changedParams);
    enqueueSessionMutation({
      type: "setModuleParams",
      moduleId: module.id,
      values: normalizedParams,
    });
    const update = (candidate: RackModuleState) =>
      candidate.id === module.id
        ? {
            ...candidate,
            params: compactParamsForKind(candidate.kind, {
              ...candidate.params,
              ...normalizedParams,
            }),
          }
        : candidate;

    if (isSystemModuleId(module.id)) {
      setSystemModules((current) => current.map(update));
    } else {
      setModules((current) => current.map(update));
    }
    for (const [paramId, value] of changedParams) {
      engineRef.current.setFloatParam(module.id, paramId, value);
    }
  }

  function queueParamPreview(moduleId: number, paramId: number, value: number) {
    if (!sessionHasRemotePeersRef.current) {
      return;
    }
    const operation = sessionParamPatchOperation(
      currentSessionDocument,
      moduleId,
      paramId,
      value,
    );
    if (!operation) {
      return;
    }

    setRemoteParamPreviews((current) =>
      omitRemoteParamPreview(current, operation.path),
    );
    pendingPreviewOpsRef.current[operation.path] = operation;

    if (previewFrameRef.current) {
      return;
    }
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = 0;
      const patch = Object.values(pendingPreviewOpsRef.current);
      pendingPreviewOpsRef.current = {};
      const socket = cursorSocketRef.current;
      if (
        patch.length === 0 ||
        !sessionHasRemotePeersRef.current ||
        !selectedSessionSlug ||
        !socket ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: "session_preview",
          slug: selectedSessionSlug,
          patch,
          clientId: sessionClientIdRef.current,
        }),
      );
    });
  }

  function updateModuleLabel(moduleId: number, label: string) {
    if (isLockedModule(moduleId)) {
      return;
    }
    const targetModule = isSystemModuleId(moduleId)
      ? systemModules.find((module) => module.id === moduleId)
      : modules.find((module) => module.id === moduleId);
    if (!targetModule || targetModule.label === label) {
      return;
    }
    enqueueSessionMutation({
      type: "setModuleLabel",
      moduleId,
      label,
    });
    const update = (module: RackModuleState) =>
      module.id === moduleId
        ? {
            ...module,
            label,
          }
        : module;

    if (isSystemModuleId(moduleId)) {
      setSystemModules((current) => current.map(update));
    } else {
      setModules((current) => current.map(update));
    }
  }

  function toggleModuleCollapsed(moduleId: number) {
    if (isSystemModuleId(moduleId)) {
      return;
    }
    if (isLockedModule(moduleId)) {
      return;
    }

    setCableDraft(null);
    setModules((current) =>
      current.map((module) =>
        module.id === moduleId
          ? {
              ...module,
              collapsed: !module.collapsed,
            }
          : module,
      ),
    );
  }

  function beginModuleDrag(moduleId: number, event: PointerEvent) {
    if (isSystemModuleId(moduleId)) {
      return;
    }
    if (isLockedModule(moduleId)) {
      return;
    }
    const draggedModule = modules.find((candidate) => candidate.id === moduleId);
    if (!draggedModule) {
      return;
    }

    const moduleElement = event.currentTarget.closest<HTMLElement>(
      "[data-module-id]",
    );
    const bounds = moduleElement?.getBoundingClientRect();
    const definition = definitionForKind(draggedModule.kind);
    const moduleWidth = bounds?.width ?? rackModulePixelWidth(definition);
    const moduleHeight =
      bounds?.height ?? rackModulePixelHeightForState(draggedModule, definition);

    event.currentTarget.setPointerCapture(event.pointerId);
    setModuleInsertTargetId(null);
    moduleDragPointerRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
    setModuleDragPreviewPoint(moduleDragPointerRef.current);
    setModuleDrag({
      moduleId,
      pointerId: event.pointerId,
      offsetX: bounds ? event.clientX - bounds.left : moduleWidth / 2,
      offsetY: bounds ? event.clientY - bounds.top : 18,
      width: moduleWidth,
      height: moduleHeight,
    });
  }

  function updateModuleDragForClientPoint(
    drag: ModuleDrag,
    clientX: number,
    clientY: number,
  ) {
    const point = rackPoint(clientX, clientY);
    if (!point) {
      setModuleInsertTargetId(null);
      return;
    }

    const insertTarget = moduleAudioInsertTargetAtPoint(drag.moduleId, point);
    setModuleInsertTargetId(insertTarget?.id ?? null);
    if (insertTarget) {
      return;
    }

    setModules((current) => {
      const nextModules = reorderModulesForRackPoint(
        current,
        drag.moduleId,
        point,
        moduleDefinitionMap,
        SYSTEM_RACK_ROWS,
      );
      if (!sameModuleOrder(current, nextModules)) {
        enqueueSessionMutation({
          type: "setRackOrder",
          moduleIds: nextModules.map((module) => module.id),
        });
      }
      return nextModules;
    });
  }

  function moduleAudioInsertTargetAtPoint(
    draggedModuleId: number,
    point: { x: number; y: number },
  ) {
    const draggedModule = modules.find(
      (candidate) => candidate.id === draggedModuleId,
    );
    if (!draggedModule) {
      return null;
    }
    const draggedDefinition = definitionForKind(draggedModule.kind);
    if (!isFxModuleDefinition(draggedDefinition)) {
      return null;
    }

    const target = rackModuleInsertHitTarget(
      point,
      renderedRackModules,
      draggedModuleId,
      moduleDefinitionMap,
    );
    if (!target || isSystemModuleId(target.id) || isLockedModule(target.id)) {
      return null;
    }
    return audioPathInsertPlan(draggedModule, target, cables) ? target : null;
  }

  function insertFxModuleIntoAudioPath(
    fxModuleId: number,
    targetModuleId: number,
  ) {
    const fxModule = modules.find((module) => module.id === fxModuleId);
    const targetModule = modules.find((module) => module.id === targetModuleId);
    if (!fxModule || !targetModule || isLockedModule(targetModule.id)) {
      return;
    }

    const plan = audioPathInsertPlan(fxModule, targetModule, cables);
    if (!plan) {
      return;
    }

    const orderedModules = moveModuleAfter(modules, fxModuleId, targetModuleId);
    const nextModules = normalizeRackLayout(
      orderedModules,
      moduleDefinitionMap,
      SYSTEM_RACK_ROWS,
    );
    if (!sameModuleOrder(modules, nextModules)) {
      enqueueSessionMutation({
        type: "setRackOrder",
        moduleIds: nextModules.map((module) => module.id),
      });
      setModules(nextModules);
    }

    for (const cableId of plan.removeCableIds) {
      enqueueSessionMutation({ type: "removeCable", cableId });
    }
    for (const cable of plan.upsertCables) {
      enqueueSessionMutation({ type: "upsertCable", cable });
    }
    setCables(plan.nextCables);
  }

  function startCable(endpoint: CableEndpoint, event: PointerEvent) {
    if (isLockedEndpoint(endpoint)) {
      return;
    }
    setJackContextMenu(null);
    const point = rackPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    setCableDraft({
      anchor: endpoint,
      kind: endpoint.kind,
      pointer: point,
      snapTarget: null,
    });
  }

  function startCableEdit(
    cable: PatchCable,
    end: "from" | "to",
    event: PointerEvent<SVGGElement>,
  ) {
    if (isLockedCable(cable)) {
      return;
    }
    setJackContextMenu(null);
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const draggedEndpoint = cable[end];
    const anchor = end === "from" ? cable.to : cable.from;
    const endpointPoint = endpointPosition(
      draggedEndpoint,
      rackModules,
      moduleDefinitionMap,
    );
    const pointer = endpointPoint ?? rackPoint(event.clientX, event.clientY);
    if (!pointer) {
      return;
    }

    setCableDraft({
      anchor,
      cableId: cable.id,
      kind: cable.from.kind,
      pointer,
      snapTarget: null,
    });
  }

  function finishCable(endpoint: CableEndpoint, event: PointerEvent) {
    event.preventDefault();
    setJackContextMenu(null);
    if (!cableDraft) {
      return;
    }
    if (isLockedEndpoint(endpoint) || isLockedEndpoint(cableDraft.anchor)) {
      setCableDraft(null);
      return;
    }

    upsertCable(cableDraft.anchor, endpoint, cableDraft.cableId);
    setCableDraft(null);
  }

  function upsertCable(
    start: CableEndpoint,
    end: CableEndpoint,
    cableId?: string,
  ) {
    const normalized = normalizeConnection(start, end);
    if (!normalized) {
      return;
    }
    if (
      isLockedEndpoint(normalized.from) ||
      isLockedEndpoint(normalized.to)
    ) {
      return;
    }

    const nextCable = {
      id:
        cableId ??
        `${normalized.from.moduleId}:${normalized.from.jackId}->${normalized.to.moduleId}:${normalized.to.jackId}:${Date.now()}`,
      from: normalized.from,
      to: normalized.to,
    };
    enqueueSessionMutation({ type: "upsertCable", cable: nextCable });

    setCables((current) => upsertPatchCableInList(current, nextCable));
  }

  function openJackContextMenu(endpoint: CableEndpoint, event: MouseEvent) {
    if (!connectionView) {
      return;
    }
    if (isLockedEndpoint(endpoint)) {
      return;
    }

    setCableDraft(null);
    setJackContextMenu({
      source: endpoint,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function connectFromJackMenu(destination: CableEndpoint) {
    if (!jackContextMenu) {
      return;
    }
    if (
      isLockedEndpoint(jackContextMenu.source) ||
      isLockedEndpoint(destination)
    ) {
      setJackContextMenu(null);
      return;
    }

    upsertCable(jackContextMenu.source, destination);
    setJackContextMenu(null);
  }

  function addModule(kind: number) {
    const id = nextModuleId;
    const definition = definitionForKind(kind);
    const newModule: RackModuleState = {
      id,
      kind,
      x: 0,
      y: 0,
      label: nextDefaultModuleLabel(definition, rackModules),
      ...(definition.slug === AUDIO_INPUT_SLUG
        ? {
            ownerUserId: authUserId(authRecord),
            ownerUsername: authUsername(authRecord),
          }
        : {}),
      params: defaultParams(definition),
    };
    const nextModules = normalizeRackLayout(
      [...modules, newModule],
      moduleDefinitionMap,
      SYSTEM_RACK_ROWS,
    );
    const placedModule =
      nextModules.find((module) => module.id === id) ?? newModule;
    const candidateCables = applyAutomaticConnections(
      placedModule,
      [...systemModules, ...nextModules],
      cables,
    );
    const nextLockedModuleIds = lockedAudioInputModuleIds(
      [...systemModules, ...nextModules],
      authUserId(authRecord),
    );
    const nextCables = candidateCables.filter(
      (cable) => !cableTouchesLockedModule(cable, nextLockedModuleIds),
    );
    const addedCables = nextCables.filter(
      (cable) => !cables.some((current) => current.id === cable.id),
    );

    enqueueSessionMutation({
      type: "addModule",
      module: placedModule,
      index: nextModules.findIndex((module) => module.id === id),
    });
    for (const cable of addedCables) {
      enqueueSessionMutation({ type: "upsertCable", cable });
    }
    setNextModuleId(id + 1);
    setModules(nextModules);
    if (nextCables !== cables) {
      setCables(nextCables);
    }
    scrollModuleIntoView(id);
  }

  function scrollModuleIntoView(moduleId: number) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const moduleElement = rackCanvasRef.current?.querySelector<HTMLElement>(
          `[data-module-id="${moduleId}"]`,
        );
        moduleElement?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "smooth",
        });
      });
    });
  }

  function deleteModule(moduleId: number) {
    if (isSystemModuleId(moduleId)) {
      return;
    }
    if (isLockedModule(moduleId)) {
      return;
    }
    if (!modules.some((module) => module.id === moduleId)) {
      return;
    }
    enqueueSessionMutation({ type: "deleteModule", moduleId });
    setModules((current) =>
      normalizeRackLayout(
        current.filter((module) => module.id !== moduleId),
        moduleDefinitionMap,
        SYSTEM_RACK_ROWS,
      ),
    );
    setCables((current) =>
      current.filter(
        (cable) =>
          cable.from.moduleId !== moduleId && cable.to.moduleId !== moduleId,
      ),
    );
    setScopeSnapshots((current) => omitModuleSnapshot(current, moduleId));
    setMixerMeters((current) => omitModuleSnapshot(current, moduleId));
    setModuleLevels((current) => omitModuleSnapshot(current, moduleId));
    setCableDraft((current) =>
      current?.anchor.moduleId === moduleId ||
      current?.snapTarget?.moduleId === moduleId
        ? null
        : current,
    );
    setModuleDrag((current) =>
      current?.moduleId === moduleId ? null : current,
    );
    setModuleInsertTargetId((current) =>
      current === moduleId ? null : current,
    );
    setModuleDragPreviewPoint((current) =>
      moduleDrag?.moduleId === moduleId ? null : current,
    );
  }

  function removeCable(cableId: string) {
    const cable = cables.find((candidate) => candidate.id === cableId);
    if (!cable || isLockedCable(cable)) {
      return;
    }
    enqueueSessionMutation({ type: "removeCable", cableId });
    setCables((current) => {
      return current.filter((candidate) => candidate.id !== cableId);
    });
  }

  function rackPoint(clientX: number, clientY: number) {
    const rect = rackRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    return {
      x: clientX - rect.left + rackRef.current!.scrollLeft,
      y: clientY - rect.top + rackRef.current!.scrollTop,
    };
  }

  function rackCollabTarget(event: globalThis.PointerEvent) {
    if (!(event.target instanceof Element)) {
      return null;
    }
    const rack = rackCanvasRef.current;
    if (!rack || !rack.contains(event.target)) {
      return null;
    }
    const module = event.target.closest<HTMLElement>("[data-module-id]");
    const moduleId = module?.dataset.moduleId;
    if (!module || !moduleId || !rack.contains(module)) {
      return null;
    }
    const bounds = module.getBoundingClientRect();
    return {
      path: `/module/${moduleId}`,
      x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
    };
  }

  if (!authRecord) {
    return (
      <AuthScreen onAuthenticated={() => setAuthRecord(pb.authStore.record)} />
    );
  }

  return (
    <main className={`appShell ${connectionView ? "appShellPatch" : ""}`}>
      <header className="topBar">
        <div className="brandBlock">
          <h1>MDLR</h1>
        </div>
        <div className="sessionHeaderControls">
          <label className="sessionControl">
            <span>session</span>
            <select
              value={selectedSessionSlug}
              disabled={
                sessionLoadState === "loading" || availableSessions.length === 0
              }
              onChange={(event) => void loadSession(event.target.value)}
            >
              {availableSessions.length === 0 ? (
                <option value="">no sessions</option>
              ) : (
                availableSessions.map((session) => (
                  <option key={session.id} value={session.slug}>
                    {session.name}
                  </option>
                ))
              )}
            </select>
          </label>
          <button
            className="newSessionButton"
            type="button"
            disabled={
              sessionLoadState !== "ready" || sessionSaveState === "saving"
            }
            onClick={() => void createNewSession()}
          >
            new session
          </button>
          <button
            className="deleteSessionButton"
            type="button"
            disabled={
              sessionLoadState !== "ready" ||
              sessionSaveState === "saving" ||
              !canDeleteSelectedSession
            }
            onClick={() => void deleteSelectedSession()}
          >
            delete session
          </button>
          {sessionInlineStatus ? (
            <span
              className={`sessionSyncStatus sessionSyncStatus-${sessionInlineStatus.kind}`}
            >
              {sessionInlineStatus.label}
            </span>
          ) : null}
        </div>
        <details className="accountMenu">
          <summary>{authRecord.username}</summary>
          <div className="accountMenuPanel">
            <button type="button" onClick={logOut}>
              log out
            </button>
          </div>
        </details>
      </header>

      {sessionErrorStatus ? (
        <div className="sessionErrorBar" role="status">
          <span>session error</span>
          <strong>{sessionErrorStatus.label}</strong>
        </div>
      ) : null}

      <div className="moduleToolbar">
        <ToolbarModuleAdd
          groups={addableModuleGroups}
          selectedKind={toolbarAddKind}
          onSelectedKindChange={setToolbarAddKind}
          onAddModule={addModule}
        />
        <div className="rackTransport">
          <label className="tempoControl">
            <span>tempo</span>
            <input
              type="range"
              min="40"
              max="220"
              step="1"
              value={tempoBpm}
              onChange={(event) => updateTempo(Number(event.target.value))}
            />
            <input
              type="number"
              min="20"
              max="300"
              step="1"
              value={tempoBpm}
              onChange={(event) => updateTempo(Number(event.target.value))}
            />
            <span>bpm</span>
          </label>
          <button
            className="startButton"
            type="button"
            disabled={audioState === "starting" || audioState === "stopping"}
            onClick={toggleAudio}
          >
            {audioState === "running"
              ? "stop"
              : audioState === "starting"
                ? "playing"
                : audioState === "stopping"
                  ? "stopping"
                  : "play"}
          </button>
          <button
            className={`viewModeButton ${connectionView ? "isActive" : ""}`}
            type="button"
            onClick={() => {
              setCableDraft(null);
              setJackContextMenu(null);
              setConnectionView((current) => !current);
            }}
          >
            {connectionView ? "patch" : "control"}
          </button>
          <span className={`status status-${audioState}`} />
        </div>
      </div>

      <PerfOverlay
        open={perfOpen}
        audioStats={audioStats}
        moduleCount={renderedRackModules.length}
        cableCount={cables.length}
        paramCount={paramCount}
        rackSize={rackSize}
        connectionView={connectionView}
        onToggle={() => setPerfOpen((current) => !current)}
      />

      <div
        className="rackWorkspace"
        style={
          { "--rack-canvas-width": `${rackSize.width}px` } as CSSProperties
        }
      >
        <section ref={rackRef} className="rackViewport">
          <div
            ref={rackCanvasRef}
            className="rackCanvas"
            style={{
              width: rackSize.width,
              height: rackSize.height,
            }}
          >
            {connectionView ? (
              <CableLayer
                modules={renderedRackModules}
                definitions={moduleDefinitionMap}
                cables={cables}
                draft={cableDraft}
                onRemoveCable={removeCable}
                onStartCableEdit={startCableEdit}
              />
            ) : null}

            {renderedRackModules.map((module) => {
              const definition = definitionForKind(module.kind);
              const ModuleComponent = definition.Component;
              const locked = lockedModuleIds.has(module.id);
              return (
                <ModuleComponent
                  key={module.id}
                  module={module}
                  definition={definition}
                  connectionView={connectionView}
                  rackModules={renderedRackModules}
                  patchCables={cables}
                  definitionsByKind={moduleDefinitionMap}
                  locked={locked}
                  lockedReason={
                    locked ? lockedAudioInputReason(module) : undefined
                  }
                  insertTarget={moduleInsertTargetId === module.id}
                  dragging={moduleDrag?.moduleId === module.id}
                  scopeData={scopeSnapshots[module.id]}
                  mixerMeterData={mixerMeters[module.id]}
                  moduleLevel={
                    audioState === "running"
                      ? (moduleLevels[module.id] ?? 0)
                      : 0
                  }
                  modulePresetOptions={userModulePresetsByKind.get(
                    definition.kind,
                  )}
                  audioEngine={engineRef.current}
                  onParamChange={updateParam}
                  onModuleParamsChange={updateModuleParams}
                  onRuntimeParamChange={updateRuntimeParam}
                  onModuleSampleChange={updateModuleSample}
                  onModuleTextChange={updateModuleText}
                  onModulePresetSelect={applyModulePreset}
                  onModulePresetSave={saveModulePreset}
                  onLoopExport={exportLoop}
                  tempoBpm={tempoBpm}
                  onStartCable={startCable}
                  onFinishCable={finishCable}
                  onOpenJackMenu={openJackContextMenu}
                  onBeginModuleDrag={beginModuleDrag}
                  onModuleCollapseToggle={toggleModuleCollapsed}
                  onModuleLabelChange={updateModuleLabel}
                  onDeleteModule={deleteModule}
                />
              );
            })}
            <RemoteCursorLayer
              cursors={Object.values(remoteCursors)}
              rackCanvasRef={rackCanvasRef}
              rackViewportRef={rackRef}
            />
          </div>
        </section>

        <ModuleLibrary groups={addableModuleGroups} onAddModule={addModule} />
      </div>

      {moduleDrag && moduleDragPreviewPoint ? (
        <ModuleDragPreview
          drag={moduleDrag}
          point={moduleDragPreviewPoint}
          module={modules.find((candidate) => candidate.id === moduleDrag.moduleId)}
        />
      ) : null}

      {jackContextMenu ? (
        <JackContextMenu
          menu={jackContextMenu}
          groups={jackContextMenuGroups}
          onClose={() => setJackContextMenu(null)}
          onSelect={connectFromJackMenu}
        />
      ) : null}
    </main>
  );
}

function ModuleDragPreview({
  drag,
  point,
  module,
}: {
  drag: ModuleDrag;
  point: { clientX: number; clientY: number };
  module?: RackModuleState;
}) {
  if (!module) {
    return null;
  }
  const definition = definitionForKind(module.kind);
  return (
    <div
      aria-hidden="true"
      className="moduleDragPreview"
      style={
        {
          left: point.clientX - drag.offsetX,
          top: point.clientY - drag.offsetY,
          width: drag.width,
          height: drag.height,
          "--module-accent": definition.accent,
        } as CSSProperties
      }
    >
      <div className="moduleDragPreviewHeader">
        <span>{definition.name}</span>
        <strong>{module.label ?? ""}</strong>
      </div>
    </div>
  );
}

function JackContextMenu({
  menu,
  groups,
  onClose,
  onSelect,
}: {
  menu: JackContextMenuState;
  groups: JackMenuGroup[];
  onClose: () => void;
  onSelect: (endpoint: CableEndpoint) => void;
}) {
  const optionCount = groups.reduce(
    (count, group) => count + group.options.length,
    0,
  );

  return (
    <div
      className="jackContextMenu"
      role="menu"
      style={jackMenuPositionStyle(menu.x, menu.y)}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="jackContextMenuTitle">
        {menu.source.direction === "output"
          ? "connect to input"
          : "connect to output"}
      </div>
      {optionCount === 0 ? (
        <div className="jackContextMenuEmpty">no compatible jacks</div>
      ) : (
        <div className="jackContextMenuList">
          {groups.map((group) => (
            <div className="jackContextMenuGroup" key={group.moduleId}>
              <div className="jackContextMenuGroupLabel">{group.label}</div>
              {group.options.map((option) => (
                <button
                  key={cableEndpointKey(option.endpoint)}
                  className={[
                    "jackContextMenuOption",
                    `jackContextMenuOption-${option.endpoint.kind}`,
                    option.connected ? "isConnected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  role="menuitem"
                  type="button"
                  onClick={() => onSelect(option.endpoint)}
                >
                  <span>{option.label}</span>
                  {option.connected ? (
                    <span className="jackContextMenuOptionStatus">
                      connected
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModuleLibrary({
  groups,
  onAddModule,
}: {
  groups: typeof addableModuleGroups;
  onAddModule: (kind: number) => void;
}) {
  return (
    <aside className="moduleLibrary" aria-label="Add modules">
      <div className="moduleLibraryHeader">
        <span>modules</span>
      </div>
      <div className="moduleLibraryScroll">
        {groups.map((group) => (
          <section
            className="moduleLibraryGroup"
            key={group.label}
            style={{ "--section-accent": group.accent } as CSSProperties}
          >
            <h2>{group.label}</h2>
            <div className="moduleLibraryList">
              {group.definitions.map((definition) => (
                <button
                  key={definition.kind}
                  type="button"
                  className="moduleLibraryItem"
                  onClick={() => onAddModule(definition.kind)}
                >
                  <span className="moduleLibraryItemName">
                    {definition.name}
                  </span>
                  <span className="moduleLibraryItemDescription">
                    {moduleLibraryDescription(definition)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}

function ToolbarModuleAdd({
  groups,
  selectedKind,
  onSelectedKindChange,
  onAddModule,
}: {
  groups: typeof addableModuleGroups;
  selectedKind: number;
  onSelectedKindChange: (kind: number) => void;
  onAddModule: (kind: number) => void;
}) {
  const selectedDefinition =
    addableModuleDefinitions.find(
      (definition) => definition.kind === selectedKind,
    ) ?? groups[0]?.definitions[0];
  const activeKind = selectedDefinition?.kind ?? 0;

  return (
    <div className="toolbarModuleAdd">
      <label className="toolbarModuleSelect">
        <span>module</span>
        <select
          value={activeKind}
          onChange={(event) => onSelectedKindChange(Number(event.target.value))}
        >
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.definitions.map((definition) => (
                <option key={definition.kind} value={definition.kind}>
                  {definition.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <button
        className="toolbarModuleAddButton"
        type="button"
        disabled={!activeKind}
        onClick={() => activeKind && onAddModule(activeKind)}
      >
        + {selectedDefinition?.name ?? "module"}
      </button>
    </div>
  );
}

function moduleLibraryDescription(definition: ModuleDefinition) {
  return (
    MODULE_LIBRARY_DESCRIPTIONS[definition.slug] ??
    `${definition.inputs.length} in / ${definition.outputs.length} out module.`
  );
}

function defaultNewSessionRack() {
  const systemModules = createSystemRackModules();
  const loopDefinition = addableModuleDefinitionsBySlug.get(LOOP_SLUG);
  const mixerDefinition = addableModuleDefinitionsBySlug.get(MIXER_SLUG);
  if (!loopDefinition || !mixerDefinition) {
    return {
      systemModules,
      modules: [] as RackModuleState[],
      cables: [] as PatchCable[],
    };
  }

  const outputMixerModule: RackModuleState = {
    id: 1,
    kind: mixerDefinition.kind,
    x: 0,
    y: 0,
    collapsed: true,
    label: "output mixer",
    params: defaultParams(mixerDefinition),
  };
  const loopModule: RackModuleState = {
    id: 2,
    kind: loopDefinition.kind,
    x: 0,
    y: 0,
    collapsed: true,
    label: nextDefaultModuleLabel(loopDefinition, [outputMixerModule]),
    params: defaultParams(loopDefinition),
  };
  const inputMixerModule: RackModuleState = {
    id: 3,
    kind: mixerDefinition.kind,
    x: 0,
    y: 0,
    label: "input mixer",
    params: defaultParams(mixerDefinition),
  };
  const modules = normalizeRackLayout(
    [outputMixerModule, loopModule, inputMixerModule],
    moduleDefinitionMap,
    SYSTEM_RACK_ROWS,
  );
  const placedOutputMixer =
    modules.find((module) => module.id === outputMixerModule.id) ??
    outputMixerModule;
  const placedLoop =
    modules.find((module) => module.id === loopModule.id) ?? loopModule;
  const placedInputMixer =
    modules.find((module) => module.id === inputMixerModule.id) ??
    inputMixerModule;
  const cables = defaultNewSessionCables(
    systemModules,
    placedOutputMixer,
    placedLoop,
    placedInputMixer,
    mixerDefinition,
    loopDefinition,
  );

  return {
    systemModules,
    modules,
    cables,
  };
}

function withDefaultNewSessionLocalState(
  modules: RackModuleState[],
  localDefaults: RackModuleState[],
) {
  return modules.map((module) =>
    preserveSessionLocalModuleState(
      module,
      localDefaults.find((candidate) => candidate.id === module.id),
    ),
  );
}

function defaultNewSessionCables(
  systemModules: RackModuleState[],
  outputMixer: RackModuleState,
  loop: RackModuleState,
  inputMixer: RackModuleState,
  mixerDefinition: ModuleDefinition,
  loopDefinition: ModuleDefinition,
) {
  const outputModule = systemModules.find(
    (module) => module.id === SYSTEM_OUTPUT_MODULE_ID,
  );
  const scopeModule = systemModules.find(
    (module) => module.id === SYSTEM_SCOPE_MODULE_ID,
  );
  if (!outputModule) {
    return [] as PatchCable[];
  }

  const cables: PatchCable[] = [];
  const addCable = (start: CableEndpoint, end: CableEndpoint) => {
    const normalized = normalizeConnection(start, end);
    if (!normalized) {
      return;
    }
    cables.push({
      id: `default-${normalized.from.moduleId}-${normalized.from.jackId}-${normalized.to.moduleId}-${normalized.to.jackId}`,
      from: normalized.from,
      to: normalized.to,
    });
  };

  const mixerOutputs = mixerMainAudioOutputs(mixerDefinition);
  const loopInputs = primaryAudioInputs(loopDefinition);
  if (
    mixerOutputs.left &&
    mixerOutputs.right &&
    loopInputs.left &&
    loopInputs.right
  ) {
    addCable(
      endpointForJack(inputMixer, mixerOutputs.left.id, "output", "audio"),
      endpointForJack(loop, loopInputs.left.id, "input", "audio"),
    );
    addCable(
      endpointForJack(inputMixer, mixerOutputs.right.id, "output", "audio"),
      endpointForJack(loop, loopInputs.right.id, "input", "audio"),
    );
  }

  const outputMixerInputs = mixerStereoInputPairs(mixerDefinition);
  for (const [slot, outputPair] of loopSlotAudioOutputPairs(
    loopDefinition,
  ).entries()) {
    const inputPair = outputMixerInputs[slot];
    if (!inputPair) {
      break;
    }
    addCable(
      endpointForJack(loop, outputPair.left.id, "output", "audio"),
      endpointForJack(outputMixer, inputPair.left.id, "input", "audio"),
    );
    addCable(
      endpointForJack(loop, outputPair.right.id, "output", "audio"),
      endpointForJack(outputMixer, inputPair.right.id, "input", "audio"),
    );
  }

  const outputInputs = masterAudioInputs(definitionForKind(outputModule.kind));
  if (
    mixerOutputs.left &&
    mixerOutputs.right &&
    outputInputs.left &&
    outputInputs.right
  ) {
    let connectedThroughScope = false;
    if (scopeModule) {
      const scopeDefinition = definitionForKind(scopeModule.kind);
      const scopeInputs = positionalStereoAudioPair(scopeDefinition.inputs);
      const scopeOutputs = positionalStereoAudioPair(scopeDefinition.outputs);

      if (
        scopeInputs.left &&
        scopeInputs.right &&
        scopeOutputs.left &&
        scopeOutputs.right
      ) {
        addCable(
          endpointForJack(outputMixer, mixerOutputs.left.id, "output", "audio"),
          endpointForJack(scopeModule, scopeInputs.left.id, "input", "audio"),
        );
        addCable(
          endpointForJack(outputMixer, mixerOutputs.right.id, "output", "audio"),
          endpointForJack(scopeModule, scopeInputs.right.id, "input", "audio"),
        );
        addCable(
          endpointForJack(scopeModule, scopeOutputs.left.id, "output", "audio"),
          endpointForJack(outputModule, outputInputs.left.id, "input", "audio"),
        );
        addCable(
          endpointForJack(scopeModule, scopeOutputs.right.id, "output", "audio"),
          endpointForJack(outputModule, outputInputs.right.id, "input", "audio"),
        );
        connectedThroughScope = true;
      }
    }

    if (!connectedThroughScope) {
      addCable(
        endpointForJack(outputMixer, mixerOutputs.left.id, "output", "audio"),
        endpointForJack(outputModule, outputInputs.left.id, "input", "audio"),
      );
      addCable(
        endpointForJack(outputMixer, mixerOutputs.right.id, "output", "audio"),
        endpointForJack(outputModule, outputInputs.right.id, "input", "audio"),
      );
    }
  }

  return cables;
}

function jackMenuPositionStyle(x: number, y: number): CSSProperties {
  if (typeof window === "undefined") {
    return { left: x, top: y };
  }

  const width = 320;
  const height = 380;
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
  };
}

interface RemoteCursorView {
  cursor: RemoteSessionCursor;
  x: number;
  y: number;
  edge: "top" | "bottom" | null;
}

function RemoteCursorLayer({
  cursors,
  rackCanvasRef,
  rackViewportRef,
}: {
  cursors: RemoteSessionCursor[];
  rackCanvasRef: RefObject<HTMLDivElement | null>;
  rackViewportRef: RefObject<HTMLDivElement | null>;
}) {
  const [views, setViews] = useState<RemoteCursorView[]>([]);
  const [activityBarY, setActivityBarY] = useState({ top: 8, bottom: 8 });

  useLayoutEffect(() => {
    const viewport = rackViewportRef.current;
    const canvas = rackCanvasRef.current;
    if (!viewport || !canvas || cursors.length === 0) {
      setViews([]);
      setActivityBarY({ top: 8, bottom: 8 });
      return;
    }

    let frame = 0;
    const update = () => {
      frame = 0;
      const canvasRect = canvas.getBoundingClientRect();
      const scrollTop = viewport.scrollTop;
      const visibleTop = scrollTop;
      const visibleBottom = scrollTop + viewport.clientHeight;
      const nextViews: RemoteCursorView[] = [];
      setActivityBarY({
        top: scrollTop + 8,
        bottom: Math.max(scrollTop + 8, visibleBottom - 28),
      });

      for (const cursor of cursors) {
        const target = elementForCollabPath(canvas, cursor.targetPath);
        if (!target) {
          continue;
        }

        const rect = target.getBoundingClientRect();
        const point = remoteCursorModulePoint(target, cursor);
        const x = rect.left - canvasRect.left + point.x;
        const y = rect.top - canvasRect.top + point.y;
        nextViews.push({
          cursor,
          x,
          y,
          edge: y < visibleTop ? "top" : y > visibleBottom ? "bottom" : null,
        });
      }

      setViews(nextViews);
    };
    const schedule = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(update);
    };

    update();
    viewport.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [cursors, rackCanvasRef, rackViewportRef]);

  if (views.length === 0) {
    return null;
  }

  const topCursors = views.filter((view) => view.edge === "top");
  const bottomCursors = views.filter((view) => view.edge === "bottom");
  const visibleCursors = views.filter((view) => view.edge === null);

  return (
    <>
      <div className="remoteCursorLayer" aria-hidden="true">
        {visibleCursors.map(({ cursor, x, y }) => (
          <div
            key={cursor.clientId}
            className={[
              "remoteCursor",
              `remoteCursor-${cursor.mode}`,
              `remoteCursor-${cursor.state}`,
            ].join(" ")}
            style={
              {
                "--cursor-x": `${Math.round(x)}px`,
                "--cursor-y": `${Math.round(y)}px`,
                "--cursor-color": cursorColor(cursor.userId || cursor.clientId),
              } as CSSProperties
            }
          >
            <span className="remoteCursorMarker" />
            <span className="remoteCursorLabel">
              <strong>{cursor.username || "guest"}</strong>
            </span>
          </div>
        ))}
      </div>
      <RemoteActivityBar edge="top" views={topCursors} y={activityBarY.top} />
      <RemoteActivityBar
        edge="bottom"
        views={bottomCursors}
        y={activityBarY.bottom}
      />
    </>
  );
}

function RemoteActivityBar({
  edge,
  views,
  y,
}: {
  edge: "top" | "bottom";
  views: RemoteCursorView[];
  y: number;
}) {
  if (views.length === 0) {
    return null;
  }
  const names = compactUniqueNames(views.map(({ cursor }) => cursor.username || "guest"));
  return (
    <div
      className={`remoteActivityBar remoteActivityBar-${edge}`}
      aria-hidden="true"
      style={
        {
          "--cursor-color": cursorColor(
            views[0]?.cursor.userId || views[0]?.cursor.clientId || edge,
          ),
          "--bar-y": `${Math.round(y)}px`,
        } as CSSProperties
      }
    >
      {names.map((name) => (
        <span key={name}>{name}</span>
      ))}
    </div>
  );
}

function elementForCollabPath(root: HTMLElement, path: string | undefined): Element | null {
  const moduleMatch = path?.match(/^\/module\/(\d+)$/);
  if (moduleMatch) {
    return root.querySelector<HTMLElement>(
      `[data-module-id="${moduleMatch[1]}"]`,
    );
  }
  return null;
}

function remoteCursorModulePoint(
  target: Element,
  cursor: RemoteSessionCursor,
) {
  const bounds = target.getBoundingClientRect();
  if (target.classList.contains("rackModuleCollapsed")) {
    const header = target.querySelector<HTMLElement>(".moduleHeader");
    const headerBounds = header?.getBoundingClientRect();
    return {
      x: bounds.width / 2,
      y: headerBounds
        ? headerBounds.top - bounds.top + headerBounds.height / 2
        : 22,
    };
  }

  const x =
    typeof cursor.x === "number" && Number.isFinite(cursor.x)
      ? cursor.x
      : bounds.width / 2;
  const y =
    typeof cursor.y === "number" && Number.isFinite(cursor.y)
      ? cursor.y
      : bounds.height / 2;

  return {
    x: Math.max(0, Math.min(bounds.width, x)),
    y: Math.max(0, Math.min(bounds.height, y)),
  };
}

function compactUniqueNames(names: string[]) {
  return Array.from(new Set(names)).slice(0, 4);
}

function normalizeConnection(start: CableEndpoint, end: CableEndpoint) {
  if (start.moduleId === end.moduleId && start.jackId === end.jackId) {
    return null;
  }

  const from = start.direction === "output" ? start : end;
  const to = start.direction === "input" ? start : end;
  if (from.direction !== "output" || to.direction !== "input") {
    return null;
  }
  if (!signalsCompatible(from.kind, to.kind)) {
    return null;
  }

  return { from, to };
}

function jackDestinationGroups(
  source: CableEndpoint,
  modules: RackModuleState[],
  definitions: Map<number, ModuleDefinition>,
  cables: PatchCable[],
  lockedModuleIds = new Set<number>(),
): JackMenuGroup[] {
  if (lockedModuleIds.has(source.moduleId)) {
    return [];
  }
  const targetDirection: JackDirection =
    source.direction === "output" ? "input" : "output";
  const occupied = occupiedCableEndpoints(cables);

  return modules
    .map((module) => {
      if (lockedModuleIds.has(module.id)) {
        return null;
      }
      const definition = definitions.get(module.kind);
      if (!definition) {
        return null;
      }

      const jacks =
        targetDirection === "input" ? definition.inputs : definition.outputs;
      const options = [...jacks]
        .sort(compareJacksForMenu)
        .map((jack) =>
          jackMenuOptionFor(source, module, jack, targetDirection, occupied),
        )
        .filter(isJackMenuOption);

      if (options.length === 0) {
        return null;
      }

      return {
        moduleId: module.id,
        label: moduleMenuLabel(module, definition),
        options,
      };
    })
    .filter(isJackMenuGroup);
}

function jackMenuOptionFor(
  source: CableEndpoint,
  module: RackModuleState,
  jack: JackDefinition,
  direction: JackDirection,
  occupied: Set<string>,
): JackMenuOption | null {
  const endpoint = endpointForJack(module, jack.id, direction, jack.kind);
  const normalized = normalizeConnection(source, endpoint);
  if (!normalized) {
    return null;
  }

  return {
    endpoint,
    label: jackMenuJackLabel(jack, direction),
    connected: occupied.has(cableEndpointKey(endpoint)),
  };
}

function isJackMenuGroup(group: JackMenuGroup | null): group is JackMenuGroup {
  return group !== null;
}

function isJackMenuOption(
  option: JackMenuOption | null,
): option is JackMenuOption {
  return option !== null;
}

function moduleMenuLabel(
  module: RackModuleState,
  definition: ModuleDefinition,
) {
  return module.label?.trim() || definition.name.toLowerCase();
}

function jackMenuJackLabel(jack: JackDefinition, direction: JackDirection) {
  const group = jack.connectionGroupLabel?.trim();
  const label = (jack.connectionLabel ?? jack.label).trim();
  const jackLabel =
    group && group.toLowerCase() !== label.toLowerCase()
      ? `${group} ${label}`
      : label;
  return `${jackLabel} ${direction === "input" ? "in" : "out"} · ${jack.kind}`;
}

function compareJacksForMenu(a: JackDefinition, b: JackDefinition) {
  return (
    (a.connectionGroupOrder ?? a.connectionOrder ?? a.id) -
      (b.connectionGroupOrder ?? b.connectionOrder ?? b.id) ||
    (a.connectionOrder ?? a.id) - (b.connectionOrder ?? b.id) ||
    a.id - b.id
  );
}

function nextDefaultModuleLabel(
  definition: ModuleDefinition,
  modules: RackModuleState[],
) {
  const base = definition.name.toLowerCase();
  const sameKindModules = modules.filter(
    (module) => module.kind === definition.kind,
  );
  const usedLabels = new Set(
    sameKindModules
      .map((module) => module.label?.trim().toLowerCase())
      .filter(isNonEmptyString),
  );
  let index = sameKindModules.length + 1;
  while (usedLabels.has(`${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function applyAutomaticConnections(
  newModule: RackModuleState,
  modules: RackModuleState[],
  currentCables: PatchCable[],
) {
  const nextCables = [...currentCables];
  const occupied = occupiedCableEndpoints(currentCables);

  const addCable = (start: CableEndpoint, end: CableEndpoint) => {
    const normalized = normalizeConnection(start, end);
    if (!normalized) {
      return false;
    }
    if (
      occupied.has(cableEndpointKey(normalized.from)) ||
      occupied.has(cableEndpointKey(normalized.to))
    ) {
      return false;
    }

    const cable = {
      id: `auto-${normalized.from.moduleId}-${normalized.from.jackId}-${normalized.to.moduleId}-${normalized.to.jackId}-${Date.now()}-${nextCables.length}`,
      from: normalized.from,
      to: normalized.to,
    };
    nextCables.push(cable);
    occupied.add(cableEndpointKey(cable.from));
    occupied.add(cableEndpointKey(cable.to));
    return true;
  };

  connectSequencerNeighbor(newModule, modules, occupied, addCable);
  connectAudioToMixer(newModule, modules, occupied, addCable);
  connectPostMixerChain(newModule, modules, occupied, addCable);

  return nextCables.length === currentCables.length
    ? currentCables
    : nextCables;
}

function connectSequencerNeighbor(
  newModule: RackModuleState,
  modules: RackModuleState[],
  occupied: Set<string>,
  addCable: (start: CableEndpoint, end: CableEndpoint) => boolean,
) {
  const newDefinition = definitionForKind(newModule.kind);

  if (MELODIC_SOURCE_SLUGS.has(newDefinition.slug)) {
    for (const synth of neighborModulesMatching(
      newModule,
      modules,
      (module, definition) =>
        PITCHED_SYNTH_SLUGS.has(definition.slug) &&
        synthNeedsMelodicControl(module, definition, occupied),
    )) {
      if (connectMelodicSourceToSynth(newModule, synth, occupied, addCable)) {
        break;
      }
    }
    return;
  }

  if (PITCHED_SYNTH_SLUGS.has(newDefinition.slug)) {
    const sequencers = neighborModulesMatching(
      newModule,
      modules,
      (_module, definition) => MELODIC_SOURCE_SLUGS.has(definition.slug),
    );
    if (synthNeedsMelodicControl(newModule, newDefinition, occupied)) {
      for (const sequencer of sequencers) {
        if (
          connectMelodicSourceToSynth(sequencer, newModule, occupied, addCable)
        ) {
          break;
        }
      }
    }
    return;
  }

  if (RHYTHM_SOURCE_SLUGS.has(newDefinition.slug)) {
    for (const drum of neighborModulesMatching(
      newModule,
      modules,
      (module, definition) =>
        DRUM_MACHINE_SLUGS.has(definition.slug) &&
        drumNeedsRhythmControl(module, definition, occupied),
    )) {
      if (connectRhythmSequencerToDrum(newModule, drum, occupied, addCable)) {
        break;
      }
    }
    return;
  }

  if (DRUM_MACHINE_SLUGS.has(newDefinition.slug)) {
    const sequencers = neighborModulesMatching(
      newModule,
      modules,
      (_module, definition) => RHYTHM_SOURCE_SLUGS.has(definition.slug),
    );
    if (drumNeedsRhythmControl(newModule, newDefinition, occupied)) {
      for (const sequencer of sequencers) {
        if (
          connectRhythmSequencerToDrum(sequencer, newModule, occupied, addCable)
        ) {
          break;
        }
      }
    }
  }
}

function connectAudioToMixer(
  newModule: RackModuleState,
  modules: RackModuleState[],
  occupied: Set<string>,
  addCable: (start: CableEndpoint, end: CableEndpoint) => boolean,
) {
  const sourceDefinition = definitionForKind(newModule.kind);
  if (
    sourceDefinition.slug === MIXER_SLUG ||
    sourceDefinition.slug === LOOP_SLUG ||
    sourceDefinition.outputs.length === 0
  ) {
    return;
  }

  if (sourceDefinition.slug === AUDIO_INPUT_SLUG) {
    connectAudioInputToMixer(newModule, modules, occupied, addCable);
    return;
  }

  const outputs = primaryAudioOutputs(sourceDefinition);
  if (!outputs.left) {
    return;
  }

  const mixers = modules
    .filter((module) => module.id !== newModule.id)
    .filter((module) => definitionForKind(module.kind).slug === MIXER_SLUG)
    .sort(compareAudioMixerTargets(newModule));

  for (const mixer of mixers) {
    const mixerDefinition = definitionForKind(mixer.kind);
    for (const inputPair of mixerStereoInputPairs(mixerDefinition)) {
      const mixerLeft = endpointForJack(
        mixer,
        inputPair.left.id,
        "input",
        "audio",
      );
      const mixerRight = endpointForJack(
        mixer,
        inputPair.right.id,
        "input",
        "audio",
      );
      if (
        occupied.has(cableEndpointKey(mixerLeft)) ||
        occupied.has(cableEndpointKey(mixerRight))
      ) {
        continue;
      }

      const sourceLeft = endpointForJack(
        newModule,
        outputs.left.id,
        "output",
        "audio",
      );
      if (occupied.has(cableEndpointKey(sourceLeft))) {
        return;
      }

      if (outputs.right) {
        const sourceRight = endpointForJack(
          newModule,
          outputs.right.id,
          "output",
          "audio",
        );
        if (occupied.has(cableEndpointKey(sourceRight))) {
          return;
        }
        addCable(sourceLeft, mixerLeft);
        addCable(sourceRight, mixerRight);
        return;
      }

      addCable(sourceLeft, mixerLeft);
      return;
    }
  }
}

function connectAudioInputToMixer(
  sourceModule: RackModuleState,
  modules: RackModuleState[],
  occupied: Set<string>,
  addCable: (start: CableEndpoint, end: CableEndpoint) => boolean,
) {
  const sourceDefinition = definitionForKind(sourceModule.kind);
  const sourceOutputs = sortedJacks(sourceDefinition.outputs, "audio");
  const mixers = modules
    .filter((module) => module.id !== sourceModule.id)
    .filter((module) => definitionForKind(module.kind).slug === MIXER_SLUG)
    .sort(compareAudioMixerTargets(sourceModule));
  let outputIndex = 0;

  for (const mixer of mixers) {
    const mixerDefinition = definitionForKind(mixer.kind);
    for (const inputPair of mixerStereoInputPairs(mixerDefinition)) {
      if (outputIndex >= sourceOutputs.length) {
        return;
      }

      const mixerLeft = endpointForJack(
        mixer,
        inputPair.left.id,
        "input",
        "audio",
      );
      const mixerRight = endpointForJack(
        mixer,
        inputPair.right.id,
        "input",
        "audio",
      );
      if (
        occupied.has(cableEndpointKey(mixerLeft)) ||
        occupied.has(cableEndpointKey(mixerRight))
      ) {
        continue;
      }

      const sourceLeft = endpointForJack(
        sourceModule,
        sourceOutputs[outputIndex].id,
        "output",
        "audio",
      );
      if (occupied.has(cableEndpointKey(sourceLeft))) {
        outputIndex += 2;
        continue;
      }

      addCable(sourceLeft, mixerLeft);
      const sourceRightJack = sourceOutputs[outputIndex + 1];
      if (sourceRightJack) {
        const sourceRight = endpointForJack(
          sourceModule,
          sourceRightJack.id,
          "output",
          "audio",
        );
        if (!occupied.has(cableEndpointKey(sourceRight))) {
          addCable(sourceRight, mixerRight);
        }
      }
      outputIndex += 2;
    }
  }
}

function connectPostMixerChain(
  newModule: RackModuleState,
  modules: RackModuleState[],
  occupied: Set<string>,
  addCable: (start: CableEndpoint, end: CableEndpoint) => boolean,
) {
  const definition = definitionForKind(newModule.kind);
  if (definition.slug === MIXER_SLUG) {
    const loop = connectMixerToLoop(newModule, modules, occupied, addCable);
    if (loop) {
      connectModuleToMasterOutput(
        loop,
        definitionForKind(loop.kind),
        modules,
        occupied,
        addCable,
      );
      return;
    }
    connectModuleToMasterOutput(
      newModule,
      definition,
      modules,
      occupied,
      addCable,
    );
    return;
  }

  if (definition.slug !== LOOP_SLUG) {
    return;
  }

  const mixers = modules
    .filter((module) => module.id !== newModule.id)
    .filter((module) => definitionForKind(module.kind).slug === MIXER_SLUG)
    .sort(compareRackNeighbors(newModule));
  for (const mixer of mixers) {
    if (connectMixerToLoop(mixer, modules, occupied, addCable)) {
      break;
    }
  }

  connectModuleToMasterOutput(
    newModule,
    definition,
    modules,
    occupied,
    addCable,
  );
}

function connectMixerToLoop(
  mixer: RackModuleState,
  modules: RackModuleState[],
  occupied: Set<string>,
  addCable: (start: CableEndpoint, end: CableEndpoint) => boolean,
) {
  const mixerDefinition = definitionForKind(mixer.kind);
  const outputs = mixerMainAudioOutputs(mixerDefinition);
  if (!outputs.left || !outputs.right) {
    return null;
  }

  const loops = modules
    .filter((module) => module.id !== mixer.id)
    .filter((module) => definitionForKind(module.kind).slug === LOOP_SLUG)
    .sort(compareRackNeighbors(mixer));

  for (const loop of loops) {
    const inputs = primaryAudioInputs(definitionForKind(loop.kind));
    if (!inputs.left || !inputs.right) {
      continue;
    }

    const connections = [
      [
        endpointForJack(mixer, outputs.left.id, "output", "audio"),
        endpointForJack(loop, inputs.left.id, "input", "audio"),
      ],
      [
        endpointForJack(mixer, outputs.right.id, "output", "audio"),
        endpointForJack(loop, inputs.right.id, "input", "audio"),
      ],
    ] satisfies [CableEndpoint, CableEndpoint][];

    if (connections.every(([start, end]) => canAddCable(start, end, occupied))) {
      for (const [start, end] of connections) {
        addCable(start, end);
      }
      return loop;
    }
  }

  return null;
}

function connectModuleToMasterOutput(
  rackModule: RackModuleState,
  definition: ModuleDefinition,
  modules: RackModuleState[],
  occupied: Set<string>,
  addCable: (start: CableEndpoint, end: CableEndpoint) => boolean,
) {
  const master = modules.find(
    (module) => module.id === SYSTEM_OUTPUT_MODULE_ID,
  );
  if (!master) {
    return;
  }

  const outputs =
    definition.slug === MIXER_SLUG
      ? mixerMainAudioOutputs(definition)
      : primaryAudioOutputs(definition);
  const inputs = masterAudioInputs(definitionForKind(master.kind));
  if (!outputs.left || !outputs.right || !inputs.left || !inputs.right) {
    return;
  }

  const connections = [
    [
      endpointForJack(rackModule, outputs.left.id, "output", "audio"),
      endpointForJack(master, inputs.left.id, "input", "audio"),
    ],
    [
      endpointForJack(rackModule, outputs.right.id, "output", "audio"),
      endpointForJack(master, inputs.right.id, "input", "audio"),
    ],
  ] satisfies [CableEndpoint, CableEndpoint][];

  if (connections.every(([start, end]) => canAddCable(start, end, occupied))) {
    for (const [start, end] of connections) {
      addCable(start, end);
    }
  }
}

function connectMelodicSourceToSynth(
  source: RackModuleState,
  synth: RackModuleState,
  occupied: Set<string>,
  addCable: (start: CableEndpoint, end: CableEndpoint) => boolean,
) {
  const sourceDefinition = definitionForKind(source.kind);
  const synthDefinition = definitionForKind(synth.kind);
  const outputPairs = melodicOutputPairCandidates(sourceDefinition);
  const inputPairs = melodicInputPairCandidates(synthDefinition);

  if (outputPairs.length === 0 || inputPairs.length === 0) {
    return false;
  }

  const pairCount = Math.min(outputPairs.length, inputPairs.length);
  const requiredPairs: [CableEndpoint, CableEndpoint][] = [];

  for (let index = 0; index < pairCount; index += 1) {
    const outputPair = outputPairs[index];
    const inputPair = inputPairs[index];
    const candidates = [
      [
        endpointForJack(source, outputPair.pitch.id, "output", "cv"),
        endpointForJack(synth, inputPair.pitch.id, "input", "cv"),
      ],
      [
        endpointForJack(source, outputPair.gate.id, "output", "gate"),
        endpointForJack(synth, inputPair.gate.id, "input", "gate"),
      ],
    ] satisfies [CableEndpoint, CableEndpoint][];

    if (candidates.every(([start, end]) => canAddCable(start, end, occupied))) {
      requiredPairs.push(...candidates);
    }
  }

  if (requiredPairs.length === 0) {
    return false;
  }

  for (const [start, end] of requiredPairs) {
    addCable(start, end);
  }

  connectOptionalMelodicJacks(
    source,
    sourceDefinition,
    synth,
    synthDefinition,
    occupied,
    addCable,
  );
  return true;
}

function connectOptionalMelodicJacks(
  source: RackModuleState,
  sourceDefinition: ModuleDefinition,
  synth: RackModuleState,
  synthDefinition: ModuleDefinition,
  occupied: Set<string>,
  addCable: (start: CableEndpoint, end: CableEndpoint) => boolean,
) {
  for (const label of ["accent", "slide"]) {
    const output = sourceDefinition.outputs.find(
      (jack) => jack.label.toLowerCase() === label,
    );
    const input = synthDefinition.inputs.find(
      (jack) =>
        jack.label.toLowerCase() === label && jack.kind === output?.kind,
    );
    if (!output || !input) {
      continue;
    }
    const start = endpointForJack(source, output.id, "output", output.kind);
    const end = endpointForJack(synth, input.id, "input", input.kind);
    if (canAddCable(start, end, occupied)) {
      addCable(start, end);
    }
  }
}

function melodicOutputPairCandidates(definition: ModuleDefinition) {
  if (definition.slug === MUTA_SLUG) {
    return [0, 1, 2]
      .map((channel) => ({
        pitch: jackByLabel(definition.outputs, `note ${channel + 1}`, "cv"),
        gate: jackByLabel(definition.outputs, `gate ${channel + 1}`, "gate"),
      }))
      .filter(
        (pair): pair is { pitch: JackDefinition; gate: JackDefinition } =>
          Boolean(pair.pitch && pair.gate),
      );
  }

  if (
    definition.slug === STEPS_SEQUENCER_SLUG ||
    definition.slug === DRONE_SLUG ||
    definition.slug === MIDI_SLUG ||
    definition.slug === ROLL_SEQUENCER_SLUG ||
    definition.slug === CHORD_GENERATOR_SLUG
  ) {
    const pitchOutputs = sortedJacks(definition.outputs, "cv");
    const gateOutputs = sortedJacks(definition.outputs, "gate");
    return Array.from(
      { length: Math.min(pitchOutputs.length, gateOutputs.length) },
      (_, index) => ({
        pitch: pitchOutputs[index],
        gate: gateOutputs[index],
      }),
    );
  }

  const pitch = jackByLabel(definition.outputs, "pitch", "cv");
  const gate = jackByLabel(definition.outputs, "gate", "gate");
  return pitch && gate ? [{ pitch, gate }] : [];
}

function melodicInputPairCandidates(definition: ModuleDefinition) {
  if (
    definition.slug === FM4_SYNTH_SLUG ||
    definition.slug === FIVE_SYNTH_SLUG ||
    definition.slug === SIX_SYNTH_SLUG
  ) {
    const pitchInputs = sortedJacks(definition.inputs, "cv").filter((jack) =>
      jack.label.toLowerCase().includes("pitch"),
    );
    const gateInputs = sortedJacks(definition.inputs, "gate").filter((jack) =>
      jack.label.toLowerCase().includes("gate"),
    );
    return Array.from(
      { length: Math.min(pitchInputs.length, gateInputs.length) },
      (_, index) => ({
        pitch: pitchInputs[index],
        gate: gateInputs[index],
      }),
    );
  }

  const pitch = jackByLabel(definition.inputs, "pitch", "cv");
  const gate = jackByLabel(definition.inputs, "gate", "gate");
  return pitch && gate ? [{ pitch, gate }] : [];
}

function connectRhythmSequencerToDrum(
  sequencer: RackModuleState,
  drum: RackModuleState,
  occupied: Set<string>,
  addCable: (start: CableEndpoint, end: CableEndpoint) => boolean,
) {
  const sequencerDefinition = definitionForKind(sequencer.kind);
  const drumDefinition = definitionForKind(drum.kind);
  const outputs = sortedJacks(sequencerDefinition.outputs, "gate");
  const inputs = primaryDrumGateInputs(drumDefinition);
  const pairs = inputs
    .slice(0, outputs.length)
    .map(
      (input, index) =>
        [
          endpointForJack(sequencer, outputs[index].id, "output", "gate"),
          endpointForJack(drum, input.id, "input", "gate"),
        ] satisfies [CableEndpoint, CableEndpoint],
    );

  if (
    pairs.length === 0 ||
    !pairs.every(([start, end]) => canAddCable(start, end, occupied))
  ) {
    return false;
  }

  for (const [start, end] of pairs) {
    addCable(start, end);
  }

  const accentOutputsByLane = new Map<number, JackDefinition>();
  for (const output of sortedJacks(sequencerDefinition.outputs, "cv")) {
    if (!isAccentJack(output)) {
      continue;
    }
    accentOutputsByLane.set(output.connectionGroupOrder ?? output.id, output);
  }
  for (const input of drumDefinition.inputs) {
    if (input.kind !== "cv" || !isAccentJack(input)) {
      continue;
    }
    const lane = input.connectionGroupOrder ?? input.id;
    const output = accentOutputsByLane.get(lane);
    if (!output) {
      continue;
    }
    const start = endpointForJack(sequencer, output.id, "output", "cv");
    const end = endpointForJack(drum, input.id, "input", "cv");
    if (canAddCable(start, end, occupied)) {
      addCable(start, end);
    }
  }
  return true;
}

function synthNeedsMelodicControl(
  module: RackModuleState,
  definition: ModuleDefinition,
  occupied: Set<string>,
) {
  return melodicInputPairCandidates(definition).some(
    (pair) =>
      !occupied.has(
        cableEndpointKey(endpointForJack(module, pair.pitch.id, "input", "cv")),
      ) &&
      !occupied.has(
        cableEndpointKey(
          endpointForJack(module, pair.gate.id, "input", "gate"),
        ),
      ),
  );
}

function drumNeedsRhythmControl(
  module: RackModuleState,
  definition: ModuleDefinition,
  occupied: Set<string>,
) {
  const inputs = primaryDrumGateInputs(definition);
  return (
    inputs.length > 0 &&
    inputs.every(
      (input) =>
        !occupied.has(
          cableEndpointKey(endpointForJack(module, input.id, "input", "gate")),
        ),
    )
  );
}

function canAddCable(
  start: CableEndpoint,
  end: CableEndpoint,
  occupied: Set<string>,
) {
  const normalized = normalizeConnection(start, end);
  return (
    normalized !== null &&
    !occupied.has(cableEndpointKey(normalized.from)) &&
    !occupied.has(cableEndpointKey(normalized.to))
  );
}

function neighborModulesMatching(
  newModule: RackModuleState,
  modules: RackModuleState[],
  predicate: (module: RackModuleState, definition: ModuleDefinition) => boolean,
) {
  return modules
    .filter((module) => module.id !== newModule.id && !module.fixed)
    .filter((module) => predicate(module, definitionForKind(module.kind)))
    .sort(compareRackNeighbors(newModule));
}

function compareRackNeighbors(reference: RackModuleState) {
  return (first: RackModuleState, second: RackModuleState) =>
    rackNeighborDistance(reference, first) -
    rackNeighborDistance(reference, second);
}

function rackNeighborDistance(first: RackModuleState, second: RackModuleState) {
  return Math.abs(first.y - second.y) * 4 + Math.abs(first.x - second.x);
}

function compareAudioMixerTargets(source: RackModuleState) {
  return (first: RackModuleState, second: RackModuleState) => {
    if (first.y !== second.y) {
      return second.y - first.y;
    }

    return compareRackNeighbors(source)(first, second);
  };
}

function primaryAudioOutputs(definition: ModuleDefinition) {
  const audioOutputs = sortedJacks(definition.outputs, "audio");
  const left = audioOutputs.find((jack) => jack.label.toLowerCase() === "left");
  const right = audioOutputs.find(
    (jack) => jack.label.toLowerCase() === "right",
  );
  if (left && right) {
    return { left, right };
  }
  return { left: audioOutputs[0] ?? null, right: null };
}

function primaryAudioInputs(definition: ModuleDefinition) {
  const audioInputs = sortedJacks(definition.inputs, "audio");
  return {
    left:
      audioInputs.find(
        (jack) =>
          jack.connectionLabel?.toLowerCase() === "l" ||
          jack.label.toLowerCase() === "left",
      ) ??
      audioInputs[0] ??
      null,
    right:
      audioInputs.find(
        (jack) =>
          jack.connectionLabel?.toLowerCase() === "r" ||
          jack.label.toLowerCase() === "right",
      ) ?? null,
  };
}

function positionalStereoAudioPair(jacks: readonly JackDefinition[]) {
  const audioJacks = sortedJacks(jacks, "audio");
  return {
    left: audioJacks[0] ?? null,
    right: audioJacks[1] ?? null,
  };
}

function mixerMainAudioOutputs(definition: ModuleDefinition) {
  const audioOutputs = sortedJacks(definition.outputs, "audio");
  const mainOutputs = audioOutputs.filter(
    (jack) => jack.connectionGroup === "main-out",
  );
  const candidates = mainOutputs.length > 0 ? mainOutputs : audioOutputs;
  return {
    left:
      candidates.find(
        (jack) =>
          jack.connectionLabel?.toLowerCase() === "l" ||
          jack.label.toLowerCase() === "main left" ||
          jack.label.toLowerCase() === "left",
      ) ?? null,
    right:
      candidates.find(
        (jack) =>
          jack.connectionLabel?.toLowerCase() === "r" ||
          jack.label.toLowerCase() === "main right" ||
          jack.label.toLowerCase() === "right",
      ) ?? null,
  };
}

function masterAudioInputs(definition: ModuleDefinition) {
  const audioInputs = sortedJacks(definition.inputs, "audio");
  return {
    left:
      audioInputs.find((jack) => jack.label.toLowerCase() === "left") ??
      audioInputs[0] ??
      null,
    right:
      audioInputs.find((jack) => jack.label.toLowerCase() === "right") ??
      audioInputs[1] ??
      null,
  };
}

function mixerStereoInputPairs(definition: ModuleDefinition) {
  const leftInputs = sortedJacks(definition.inputs, "audio").filter((jack) =>
    jack.label.toLowerCase().endsWith(" left"),
  );
  const rightByGroup = new Map(
    sortedJacks(definition.inputs, "audio")
      .filter((jack) => jack.label.toLowerCase().endsWith(" right"))
      .map((jack) => [jack.connectionGroup ?? "", jack]),
  );
  return leftInputs
    .map((left) => ({
      left,
      right: rightByGroup.get(left.connectionGroup ?? ""),
    }))
    .filter(
      (
        pair,
      ): pair is {
        left: ModuleDefinition["inputs"][number];
        right: ModuleDefinition["inputs"][number];
      } => pair.right !== undefined,
    );
}

function loopSlotAudioOutputPairs(definition: ModuleDefinition) {
  const leftOutputs = sortedJacks(definition.outputs, "audio").filter((jack) =>
    isLoopTrackOutputGroup(jack.connectionGroup) &&
      jack.connectionLabel?.toLowerCase() === "l",
  );
  const rightByGroup = new Map(
    sortedJacks(definition.outputs, "audio")
      .filter(
        (jack) =>
          isLoopTrackOutputGroup(jack.connectionGroup) &&
          jack.connectionLabel?.toLowerCase() === "r",
      )
      .map((jack) => [jack.connectionGroup ?? "", jack]),
  );
  return leftOutputs
    .map((left) => ({
      left,
      right: rightByGroup.get(left.connectionGroup ?? ""),
    }))
    .filter(
      (
        pair,
      ): pair is {
        left: ModuleDefinition["outputs"][number];
        right: ModuleDefinition["outputs"][number];
      } => pair.right !== undefined,
    );
}

function isLoopTrackOutputGroup(group: string | undefined) {
  return group?.startsWith("track-") || group?.startsWith("slot-");
}

function primaryDrumGateInputs(definition: ModuleDefinition) {
  return sortedJacks(definition.inputs, "gate").filter(
    (jack) => !jack.label.toLowerCase().includes("choke"),
  );
}

function isAccentJack(jack: JackDefinition) {
  const label = `${jack.connectionLabel ?? ""} ${jack.label}`.toLowerCase();
  return /\bacc(?:ent)?\b/.test(label);
}

function jackByLabel(
  jacks: ModuleDefinition["inputs"],
  label: string,
  kind: SignalKind,
) {
  return jacks.find(
    (jack) => jack.kind === kind && jack.label.toLowerCase() === label,
  );
}

function sortedJacks(jacks: readonly JackDefinition[], kind: SignalKind) {
  return jacks
    .filter((jack) => jack.kind === kind)
    .sort(
      (first, second) =>
        (first.connectionOrder ?? first.id) -
          (second.connectionOrder ?? second.id) || first.id - second.id,
    );
}

function endpointForJack(
  module: RackModuleState,
  jackId: number,
  direction: CableEndpoint["direction"],
  kind: SignalKind,
): CableEndpoint {
  return {
    moduleId: module.id,
    jackId,
    direction,
    kind,
  };
}

function occupiedCableEndpoints(cables: PatchCable[]) {
  const occupied = new Set<string>();
  for (const cable of cables) {
    occupied.add(cableEndpointKey(cable.from));
    occupied.add(cableEndpointKey(cable.to));
  }
  return occupied;
}

function cableEndpointKey(endpoint: CableEndpoint) {
  return `${endpoint.direction}:${endpoint.moduleId}:${endpoint.jackId}`;
}

function signalsCompatible(from: SignalKind, to: SignalKind) {
  if (from === to) {
    return true;
  }

  return from === "gate" && to === "cv";
}

function cablesShareJack(first: PatchCable, second: PatchCable) {
  return (
    endpointsEqual(first.from, second.from) ||
    endpointsEqual(first.from, second.to) ||
    endpointsEqual(first.to, second.from) ||
    endpointsEqual(first.to, second.to)
  );
}

function endpointsEqual(first: CableEndpoint, second: CableEndpoint) {
  return (
    first.direction === second.direction &&
    first.moduleId === second.moduleId &&
    first.jackId === second.jackId
  );
}

function nearestCompatibleEndpoint(
  start: CableEndpoint,
  point: { x: number; y: number },
  modules: RackModuleState[],
  definitions: typeof moduleDefinitionMap,
  lockedModuleIds = new Set<number>(),
) {
  if (lockedModuleIds.has(start.moduleId)) {
    return null;
  }
  const targetDirection = start.direction === "output" ? "input" : "output";
  let best: { endpoint: CableEndpoint; distance: number } | null = null;

  for (const module of modules) {
    if (module.id === start.moduleId) {
      continue;
    }
    if (lockedModuleIds.has(module.id)) {
      continue;
    }

    const definition = definitions.get(module.kind);
    if (!definition) {
      continue;
    }

    const jacks =
      targetDirection === "input" ? definition.inputs : definition.outputs;
    for (const jack of jacks) {
      const endpoint: CableEndpoint = {
        moduleId: module.id,
        jackId: jack.id,
        direction: targetDirection,
        kind: jack.kind,
      };
      if (!normalizeConnection(start, endpoint)) {
        continue;
      }

      const position = endpointPosition(endpoint, modules, definitions);
      if (!position) {
        continue;
      }

      const distance = Math.hypot(position.x - point.x, position.y - point.y);
      if (distance > CABLE_SNAP_RADIUS) {
        continue;
      }
      if (!best || distance < best.distance) {
        best = { endpoint, distance };
      }
    }
  }

  return best?.endpoint ?? null;
}

function cloneModules(modules: RackModuleState[]) {
  return modules.map((module) =>
    moduleWithText(
      moduleWithSample(
        {
          ...module,
          params: { ...module.params },
        },
        cloneModuleSample(module.sample),
      ),
      cloneModuleText(module.text),
    ),
  );
}

function moduleWithSample(
  module: RackModuleState,
  sample: ModuleSampleState | undefined,
) {
  if (sample) {
    return { ...module, sample };
  }
  const { sample: _sample, ...moduleWithoutSample } = module;
  return moduleWithoutSample;
}

function mergeRuntimeSampleAsset(
  sample: ModuleSampleState,
  runtimeAsset: ModuleRuntimeSampleAsset | undefined,
  previousSample: ModuleSampleState | undefined,
  loadedAssets: ReadonlyMap<string, ModuleRuntimeSampleAsset>,
): ModuleRuntimeSampleAsset | undefined {
  if (sample.kind !== "loop") {
    return runtimeAsset;
  }

  type RuntimeLoop = LoopRuntimeSampleAsset["loops"][number];
  const loopsByCell = new Map<number, RuntimeLoop>();
  const previousLoopsByObjectKey = new Map<string, RuntimeLoop>();
  const previousLoopSample =
    previousSample?.kind === "loop" ? previousSample : undefined;
  const previousRuntimeAsset =
    previousLoopSample ? loadedAssets.get(previousLoopSample.assetId) : undefined;
  if (previousLoopSample && previousRuntimeAsset?.kind === "loop") {
    const previousRuntimeLoopsByCell = new Map(
      previousRuntimeAsset.loops.map((loop) => [loop.slot, loop]),
    );
    for (const loop of previousLoopSample.loops) {
      const runtimeLoop = previousRuntimeLoopsByCell.get(
        loopCellIndex(loop.slot, loop.clip),
      );
      if (runtimeLoop) {
        previousLoopsByObjectKey.set(loop.objectKey, runtimeLoop);
      }
    }
    for (const loop of previousRuntimeAsset.loops) {
      loopsByCell.set(loop.slot, loop);
    }
  }
  if (runtimeAsset?.kind === "loop") {
    for (const loop of runtimeAsset.loops) {
      loopsByCell.set(loop.slot, loop);
    }
  }

  const loops = [];
  for (const loop of sample.loops) {
    const cell = loopCellIndex(loop.slot, loop.clip);
    const runtimeLoop = loopsByCell.get(cell) ?? previousLoopsByObjectKey.get(loop.objectKey);
    if (!runtimeLoop) {
      return undefined;
    }
    loops.push({
      ...runtimeLoop,
      slot: cell,
      clip: loop.clip,
    });
  }

  return {
    kind: "loop",
    assetId: sample.assetId,
    loops,
  };
}

function loopCellIndex(slot: number, clip: number) {
  return slot * LOOP_CLIPS_PER_TRACK + clip;
}

function moduleWithText(
  module: RackModuleState,
  text: ModuleTextState | undefined,
) {
  if (text) {
    return { ...module, text };
  }
  const { text: _text, ...moduleWithoutText } = module;
  return moduleWithoutText;
}

function cloneModuleSample(sample: ModuleSampleState | undefined) {
  if (!sample) {
    return undefined;
  }
  if (sample.kind === "loop") {
    return {
      ...sample,
      loops: sample.loops.map((loop) => ({ ...loop })),
    };
  }
  return {
    ...sample,
    slices: sample.slices.map((slice) => ({ ...slice })),
    ...(sample.kind === "sampler" && sample.padLabels
      ? { padLabels: [...sample.padLabels] }
      : {}),
  };
}

function cloneModuleText(text: ModuleTextState | undefined) {
  if (!text) {
    return undefined;
  }
  if (text.kind === "loop") {
    return {
      ...text,
      slotLabels: [...text.slotLabels],
    };
  }
  return {
    ...text,
    phrases: [...text.phrases],
  };
}

function moduleTextSignature(text: ModuleTextState | undefined) {
  if (!text) {
    return "";
  }
  return JSON.stringify(text);
}

function moduleSampleSignature(sample: ModuleSampleState | undefined) {
  if (!sample) {
    return "";
  }
  return JSON.stringify(sample);
}

function sameModuleOrder(
  left: readonly RackModuleState[],
  right: readonly RackModuleState[],
) {
  return (
    left.length === right.length &&
    left.every((module, index) => module.id === right[index]?.id)
  );
}

function isFxModuleDefinition(definition: ModuleDefinition) {
  return FX_MODULE_SLUGS.has(definition.slug);
}

function rackModuleInsertHitTarget(
  point: { x: number; y: number },
  modules: readonly RackModuleState[],
  ignoredModuleId: number,
  definitions: ReadonlyMap<number, ModuleDefinition>,
) {
  for (let index = modules.length - 1; index >= 0; index -= 1) {
    const module = modules[index];
    if (module.id === ignoredModuleId) {
      continue;
    }
    const definition = definitions.get(module.kind);
    if (!definition) {
      continue;
    }
    const position = rackModulePixelPosition(module);
    const width = rackModulePixelWidth(definition);
    const height = rackModulePixelHeightForState(module, definition);
    if (
      point.x < position.x ||
      point.x > position.x + width ||
      point.y < position.y ||
      point.y > position.y + height
    ) {
      continue;
    }

    const edgeGuard = Math.min(MODULE_INSERT_EDGE_GUARD_PX, height * 0.25);
    if (
      point.y < position.y + edgeGuard ||
      point.y > position.y + height - edgeGuard
    ) {
      return null;
    }
    return module;
  }

  return null;
}

function moduleDragAutoScrollVelocity(clientY: number, rect: DOMRect) {
  const topDistance = clientY - rect.top;
  const bottomDistance = rect.bottom - clientY;
  if (topDistance < MODULE_DRAG_AUTOSCROLL_ZONE_PX) {
    const ratio = Math.min(
      1,
      Math.max(0, (MODULE_DRAG_AUTOSCROLL_ZONE_PX - topDistance) / MODULE_DRAG_AUTOSCROLL_ZONE_PX),
    );
    return -Math.max(1, Math.round(MODULE_DRAG_AUTOSCROLL_MAX_PX * ratio * ratio));
  }
  if (bottomDistance < MODULE_DRAG_AUTOSCROLL_ZONE_PX) {
    const ratio = Math.min(
      1,
      Math.max(0, (MODULE_DRAG_AUTOSCROLL_ZONE_PX - bottomDistance) / MODULE_DRAG_AUTOSCROLL_ZONE_PX),
    );
    return Math.max(1, Math.round(MODULE_DRAG_AUTOSCROLL_MAX_PX * ratio * ratio));
  }
  return 0;
}

function audioPathInsertPlan(
  fxModule: RackModuleState,
  targetModule: RackModuleState,
  currentCables: readonly PatchCable[],
) {
  if (fxModule.id === targetModule.id) {
    return null;
  }

  const fxDefinition = definitionForKind(fxModule.kind);
  if (!isFxModuleDefinition(fxDefinition)) {
    return null;
  }
  if (modulesHaveDirectAudioCable(currentCables, fxModule.id, targetModule.id)) {
    return null;
  }

  const targetDefinition = definitionForKind(targetModule.kind);
  const channels = audioPathInsertChannels(
    targetModule,
    targetDefinition,
    fxModule,
    fxDefinition,
  );
  if (channels.length === 0) {
    return null;
  }

  const channelByTargetOutputJackId = new Map(
    channels.map((channel) => [channel.targetOutput.jackId, channel]),
  );
  const removeCableIds = new Set(
    currentCables
      .filter((cable) => cableTouchesModuleAudio(cable, fxModule.id))
      .map((cable) => cable.id),
  );
  const downstreamCables = currentCables.filter(
    (cable) =>
      !removeCableIds.has(cable.id) &&
      cable.from.moduleId === targetModule.id &&
      cable.from.kind === "audio" &&
      channelByTargetOutputJackId.has(cable.from.jackId),
  );
  const activeChannels =
    downstreamCables.length > 0
      ? channels.filter((channel) =>
          downstreamCables.some(
            (cable) => cable.from.jackId === channel.targetOutput.jackId,
          ),
        )
      : channels;
  if (activeChannels.length === 0) {
    return null;
  }

  const upsertCables: PatchCable[] = [];
  for (const channel of activeChannels) {
    upsertCables.push({
      id: audioInsertCableId(
        targetModule.id,
        channel.targetOutput.jackId,
        fxModule.id,
        channel.fxInput.jackId,
      ),
      from: channel.targetOutput,
      to: channel.fxInput,
    });

    const previousDownstream = downstreamCables.find(
      (cable) => cable.from.jackId === channel.targetOutput.jackId,
    );
    if (previousDownstream) {
      upsertCables.push({
        ...previousDownstream,
        from: channel.fxOutput,
      });
    }
  }

  let nextCables = currentCables.filter(
    (cable) => !removeCableIds.has(cable.id),
  );
  for (const cable of upsertCables) {
    nextCables = upsertPatchCableInList(nextCables, cable);
  }

  return { removeCableIds: [...removeCableIds], upsertCables, nextCables };
}

function audioPathInsertChannels(
  targetModule: RackModuleState,
  targetDefinition: ModuleDefinition,
  fxModule: RackModuleState,
  fxDefinition: ModuleDefinition,
) {
  const targetOutputs =
    targetDefinition.slug === MIXER_SLUG
      ? mixerMainAudioOutputs(targetDefinition)
      : primaryAudioOutputs(targetDefinition);
  const fxInputs = primaryAudioInputs(fxDefinition);
  const fxOutputs = primaryAudioOutputs(fxDefinition);
  const channels = [];

  if (targetOutputs.left && fxInputs.left && fxOutputs.left) {
    channels.push({
      targetOutput: endpointForJack(
        targetModule,
        targetOutputs.left.id,
        "output",
        "audio",
      ),
      fxInput: endpointForJack(fxModule, fxInputs.left.id, "input", "audio"),
      fxOutput: endpointForJack(fxModule, fxOutputs.left.id, "output", "audio"),
    });
  }
  if (targetOutputs.right && fxInputs.right && fxOutputs.right) {
    channels.push({
      targetOutput: endpointForJack(
        targetModule,
        targetOutputs.right.id,
        "output",
        "audio",
      ),
      fxInput: endpointForJack(fxModule, fxInputs.right.id, "input", "audio"),
      fxOutput: endpointForJack(fxModule, fxOutputs.right.id, "output", "audio"),
    });
  }

  return channels;
}

function audioInsertCableId(
  sourceModuleId: number,
  sourceJackId: number,
  fxModuleId: number,
  fxInputJackId: number,
) {
  return `${sourceModuleId}:${sourceJackId}->${fxModuleId}:${fxInputJackId}:insert`;
}

function upsertPatchCableInList(
  cables: readonly PatchCable[],
  cable: PatchCable,
) {
  const originalIndex = cables.findIndex(
    (candidate) => candidate.id === cable.id,
  );
  const withoutDuplicate = cables.filter(
    (candidate) =>
      candidate.id !== cable.id && !cablesShareJack(candidate, cable),
  );
  if (originalIndex === -1) {
    return [...withoutDuplicate, cable];
  }

  const next = [...withoutDuplicate];
  next.splice(Math.min(originalIndex, next.length), 0, cable);
  return next;
}

function cableTouchesModuleAudio(cable: PatchCable, moduleId: number) {
  return (
    (cable.from.moduleId === moduleId && cable.from.kind === "audio") ||
    (cable.to.moduleId === moduleId && cable.to.kind === "audio")
  );
}

function modulesHaveDirectAudioCable(
  cables: readonly PatchCable[],
  firstModuleId: number,
  secondModuleId: number,
) {
  return cables.some(
    (cable) =>
      cable.from.kind === "audio" &&
      cable.to.kind === "audio" &&
      ((cable.from.moduleId === firstModuleId &&
        cable.to.moduleId === secondModuleId) ||
        (cable.from.moduleId === secondModuleId &&
          cable.to.moduleId === firstModuleId)),
  );
}

function moveModuleAfter(
  modules: readonly RackModuleState[],
  movingModuleId: number,
  targetModuleId: number,
) {
  const moving = modules.find((module) => module.id === movingModuleId);
  if (!moving || movingModuleId === targetModuleId) {
    return [...modules];
  }
  const withoutMoving = modules.filter((module) => module.id !== movingModuleId);
  const targetIndex = withoutMoving.findIndex(
    (module) => module.id === targetModuleId,
  );
  if (targetIndex === -1) {
    return [...modules];
  }
  const next = [...withoutMoving];
  next.splice(targetIndex + 1, 0, moving);
  return next;
}

function isEditableEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
}

function supportedRackModules(modules: RackModuleState[]) {
  return modules.filter((module) => moduleDefinitionMap.has(module.kind));
}

function cloneCables(cables: PatchCable[]) {
  return cables.map((cable) => ({
    ...cable,
    from: { ...cable.from },
    to: { ...cable.to },
  }));
}

function sanitizeCablesForRack(
  rackModules: RackModuleState[],
  cables: PatchCable[],
) {
  const modulesById = new Map(rackModules.map((module) => [module.id, module]));
  const occupied = new Set<string>();
  const sanitized: PatchCable[] = [];
  for (const cable of cables) {
    if (
      !cableEndpointMatchesDefinition(cable.from, modulesById) ||
      !cableEndpointMatchesDefinition(cable.to, modulesById) ||
      !normalizeConnection(cable.from, cable.to)
    ) {
      continue;
    }

    const fromKey = cableEndpointKey(cable.from);
    const toKey = cableEndpointKey(cable.to);
    if (occupied.has(fromKey) || occupied.has(toKey)) {
      continue;
    }

    occupied.add(fromKey);
    occupied.add(toKey);
    sanitized.push(cable);
  }
  return sanitized;
}

function cableEndpointMatchesDefinition(
  endpoint: CableEndpoint,
  modulesById: Map<number, RackModuleState>,
) {
  const module = modulesById.get(endpoint.moduleId);
  if (!module) {
    return false;
  }
  const definition = moduleDefinitionMap.get(module.kind);
  if (!definition) {
    return false;
  }
  const jacks =
    endpoint.direction === "input" ? definition.inputs : definition.outputs;
  return jacks.some(
    (jack) => jack.id === endpoint.jackId && jack.kind === endpoint.kind,
  );
}

function applyRemoteParamPreviews(
  modules: RackModuleState[],
  previews: Record<string, RemoteParamPreview>,
) {
  const entries = Object.values(previews);
  if (entries.length === 0) {
    return modules;
  }

  const byModule = new Map<number, RemoteParamPreview[]>();
  for (const preview of entries) {
    const modulePreviews = byModule.get(preview.moduleId);
    if (modulePreviews) {
      modulePreviews.push(preview);
    } else {
      byModule.set(preview.moduleId, [preview]);
    }
  }

  let changed = false;
  const nextModules = modules.map((module) => {
    const modulePreviews = byModule.get(module.id);
    if (!modulePreviews) {
      return module;
    }
    changed = true;
    const params = { ...module.params };
    for (const preview of modulePreviews) {
      params[preview.paramId] = preview.value;
    }
    return {
      ...module,
      params,
    };
  });

  return changed ? nextModules : modules;
}

function omitModuleSnapshot<T>(snapshots: Record<number, T>, moduleId: number) {
  if (!(moduleId in snapshots)) {
    return snapshots;
  }

  const next = { ...snapshots };
  delete next[moduleId];
  return next;
}

function mergeModuleLevels(
  current: Record<number, number>,
  levels: ModuleLevelSnapshot[],
) {
  const next = { ...current };
  for (const meter of levels) {
    const previous = current[meter.moduleId] ?? 0;
    const incoming = Number.isFinite(meter.level)
      ? Math.max(0, meter.level)
      : 0;
    next[meter.moduleId] = Math.max(incoming, previous * 0.72);
  }
  return next;
}

function omitRemoteCursor(
  cursors: Record<string, RemoteSessionCursor>,
  clientId: string,
) {
  if (!(clientId in cursors)) {
    return cursors;
  }

  const next = { ...cursors };
  delete next[clientId];
  return next;
}

function omitRemoteParamPreview(
  previews: Record<string, RemoteParamPreview>,
  path: string,
) {
  if (!(path in previews)) {
    return previews;
  }
  const next = { ...previews };
  delete next[path];
  return next;
}

function previewParamsFromPatch(
  patch: SessionPatch,
  clientId: string,
  expiresAt: number,
) {
  const previews: RemoteParamPreview[] = [];
  for (const operation of patch) {
    if (operation.op !== "add" && operation.op !== "replace") {
      continue;
    }
    if (
      typeof operation.value !== "number" ||
      !Number.isFinite(operation.value)
    ) {
      continue;
    }
    const target = parseSessionParamPath(operation.path);
    if (!target) {
      continue;
    }
    previews.push({
      path: operation.path,
      moduleId: target.moduleId,
      paramId: target.paramId,
      value: operation.value,
      clientId,
      expiresAt,
    });
  }
  return previews;
}

function parseSessionParamPath(path: string) {
  const segments = path.split("/");
  if (
    segments.length !== 5 ||
    segments[0] !== "" ||
    (segments[1] !== "modulesById" && segments[1] !== "systemModulesById") ||
    segments[3] !== "params"
  ) {
    return null;
  }
  const moduleId = Number(segments[2]);
  const paramId = Number(segments[4]);
  if (!Number.isInteger(moduleId) || !Number.isInteger(paramId)) {
    return null;
  }
  return { moduleId, paramId };
}

function parseSessionSocketEvent(value: unknown): SessionSocketEvent | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<SessionSocketEvent>;
    if (parsed.type === "session_update") {
      if (
        typeof parsed.slug !== "string" ||
        typeof parsed.baseHash !== "string" ||
        typeof parsed.hash !== "string" ||
        !Array.isArray(parsed.patch)
      ) {
        return null;
      }
      return parsed as SessionSocketEvent;
    }
    if (parsed.type === "session_preview") {
      if (
        typeof parsed.slug !== "string" ||
        typeof parsed.clientId !== "string" ||
        !Array.isArray(parsed.patch)
      ) {
        return null;
      }
      return parsed as SessionSocketEvent;
    }
    if (parsed.type === "session_presence") {
      if (
        typeof parsed.slug !== "string" ||
        typeof parsed.connections !== "number" ||
        !Number.isFinite(parsed.connections)
      ) {
        return null;
      }
      return {
        ...parsed,
        connections: Math.max(0, Math.floor(parsed.connections)),
      } as SessionSocketEvent;
    }
    if (parsed.type === "cursor" || parsed.type === "cursor_leave") {
      if (!parsed.clientId || typeof parsed.clientId !== "string") {
        return null;
      }
      return parsed as SessionSocketEvent;
    }
    return null;
  } catch {
    return null;
  }
}

function createSessionClientId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cursorColor(seed: string) {
  const palette = [
    "#0f766e",
    "#2563eb",
    "#be123c",
    "#7c2d12",
    "#6d28d9",
    "#047857",
    "#b45309",
  ];
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return palette[hash % palette.length];
}

function nextModuleIdFor(modules: RackModuleState[]) {
  return Math.max(0, ...modules.map((module) => module.id)) + 1;
}

function updateTransportPlayhead(
  rackCanvas: HTMLElement,
  transport: TransportStepSnapshot,
) {
  updateStepPlayheads(rackCanvas, transport);
  updateRollPlayheads(rackCanvas, transport);
}

function updateRollPlayheads(
  rackCanvas: HTMLElement,
  transport: TransportStepSnapshot,
) {
  const position = transportPosition(transport);
  for (const grid of rackCanvas.querySelectorAll<HTMLElement>(".rollGrid")) {
    const length = rollGridLength(grid);
    const step = rollPlayheadStep(position, length);
    if (grid.dataset.rollPlayheadStep === String(step)) {
      continue;
    }
    grid.dataset.rollPlayheadStep = String(step);
    const playhead = grid.querySelector<HTMLElement>(".rollPlayhead");
    if (playhead) {
      const leftRatio = step / length;
      playhead.style.left = `calc(42px + ${(leftRatio * 100).toFixed(4)}% - ${(leftRatio * 42).toFixed(4)}px)`;
      playhead.style.width = `calc(${(100 / length).toFixed(4)}% - ${(42 / length).toFixed(4)}px)`;
    }
  }
}

function updateStepPlayheads(
  rackCanvas: HTMLElement,
  transport: TransportStepSnapshot,
) {
  const position = transportPosition(transport);
  for (const panel of rackCanvas.querySelectorAll<HTMLElement>(".stepsPanel")) {
    updateStepsPanelPlayhead(panel, position);
  }
  for (const panel of rackCanvas.querySelectorAll<HTMLElement>(
    ".melodicSeqPanel, .rhythmSeqPanel",
  )) {
    const step = panel.classList.contains("rhythmSeqPanel")
      ? rhythmSequencerPlayheadStep(
          position,
          stepPanelLoopSteps(panel),
          panel.classList.contains("isThreeFour"),
        )
      : sequencerPlayheadStep(position, stepPanelLoopSteps(panel));
    if (panel.dataset.playheadStep === String(step)) {
      continue;
    }
    for (const element of panel.querySelectorAll(".isPlayhead")) {
      element.classList.remove("isPlayhead");
    }
    for (const element of panel.querySelectorAll(`[data-step="${step}"]`)) {
      element.classList.add("isPlayhead");
    }
    panel.dataset.playheadStep = String(step);
  }
}

function updateStepsPanelPlayhead(panel: HTMLElement, position: number) {
  const stage = stepsPanelPlayheadStage(panel, position);
  if (panel.dataset.playheadStep === String(stage)) {
    return;
  }
  for (const element of panel.querySelectorAll(".isPlayhead")) {
    element.classList.remove("isPlayhead");
  }
  for (const element of panel.querySelectorAll(`[data-stage="${stage}"]`)) {
    element.classList.add("isPlayhead");
  }
  panel.dataset.playheadStep = String(stage);
}

function stepsPanelPlayheadStage(panel: HTMLElement, position: number) {
  const sequenceSteps = stepPanelLoopSteps(panel);
  const absolute = Math.floor(position + 1.0e-9);
  const direction = Number(panel.dataset.direction);
  const unit = stepsPanelDirectedUnit(absolute, sequenceSteps, direction);
  const stageSteps = parseStepsPanelValues(panel.dataset.stageSteps, 8, 1, 16);
  const skips = parseStepsPanelValues(panel.dataset.stageSkips, 8, 0, 1);
  const patternUnits = stageSteps.reduce(
    (sum, value, stage) => sum + (skips[stage] >= 1 ? 0 : value),
    0,
  );
  if (patternUnits <= 0) {
    return 0;
  }

  const patternUnit = unit % patternUnits;
  let cursor = 0;
  for (let stage = 0; stage < stageSteps.length; stage += 1) {
    if (skips[stage] >= 1) {
      continue;
    }
    const length = stageSteps[stage];
    if (patternUnit < cursor + length) {
      return stage;
    }
    cursor += length;
  }
  return 0;
}

function stepsPanelDirectedUnit(
  absolute: number,
  sequenceSteps: number,
  direction: number,
) {
  const length = Math.max(1, sequenceSteps);
  if (direction === 1) {
    return length - 1 - positiveModulo(absolute, length);
  }
  if (direction === 2) {
    if (length <= 1) {
      return 0;
    }
    const cycle = length * 2 - 2;
    const wrapped = positiveModulo(absolute, cycle);
    return wrapped < length ? wrapped : cycle - wrapped;
  }
  if (direction === 3) {
    return positiveModulo(absolute * 1_664_525 + 1_013_904_223, length);
  }
  return positiveModulo(absolute, length);
}

function parseStepsPanelValues(
  value: string | undefined,
  count: number,
  min: number,
  max: number,
) {
  const parts = (value ?? "").split(",");
  return Array.from({ length: count }, (_, index) => {
    const parsed = Number(parts[index]);
    if (!Number.isFinite(parsed)) {
      return min;
    }
    return Math.max(min, Math.min(max, Math.round(parsed)));
  });
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function transportPosition(transport: TransportStepSnapshot) {
  return Number.isFinite(transport.position)
    ? transport.position
    : transport.absoluteStep;
}

function sequencerPlayheadStep(position: number, loopSteps: number) {
  if (loopSteps === 12) {
    return Math.floor((position * 12) / 16 + 1.0e-9) % 12;
  }
  return Math.floor(position + 1.0e-9) % loopSteps;
}

function rhythmSequencerPlayheadStep(
  position: number,
  patternLength: number,
  tripleMeter: boolean,
) {
  if (!tripleMeter) {
    return Math.floor(position + 1.0e-9) % patternLength;
  }
  const pages = Math.max(1, Math.ceil(patternLength / 16));
  const activeSteps = 12 * pages;
  const activeStep = Math.floor((position * 12) / 16 + 1.0e-9) % activeSteps;
  return Math.floor(activeStep / 12) * 16 + (activeStep % 12);
}

function rollPlayheadStep(position: number, length: number) {
  if (length === 12 || length === 24 || length === 48) {
    return Math.floor((position * 3) / 4 + 1.0e-9) % length;
  }
  return Math.floor(position + 1.0e-9) % length;
}

function stepPanelLoopSteps(panel: HTMLElement) {
  const value = Number(panel.dataset.loopSteps);
  if (panel.classList.contains("stepsPanel") && Number.isInteger(value)) {
    return Math.max(1, Math.min(64, value));
  }
  if (panel.classList.contains("rhythmSeqPanel") && Number.isInteger(value)) {
    return Math.max(1, Math.min(64, value));
  }
  if (Number.isInteger(value) && value >= 1 && value <= 16) {
    return value;
  }
  return 16;
}

function clearTransportPlayhead(rackCanvas: HTMLElement | null) {
  if (!rackCanvas) {
    return;
  }
  rackCanvas.removeAttribute("data-playhead-step");
  for (const panel of rackCanvas.querySelectorAll<HTMLElement>(
    ".stepsPanel, .melodicSeqPanel, .rhythmSeqPanel",
  )) {
    delete panel.dataset.playheadStep;
  }
  for (const element of rackCanvas.querySelectorAll(
    ".stepsPanel .isPlayhead, .melodicSeqPanel .isPlayhead, .rhythmSeqPanel .isPlayhead",
  )) {
    element.classList.remove("isPlayhead");
  }
  for (const grid of rackCanvas.querySelectorAll<HTMLElement>(".rollGrid")) {
    delete grid.dataset.rollPlayheadStep;
    const playhead = grid.querySelector<HTMLElement>(".rollPlayhead");
    if (playhead) {
      playhead.style.left = "";
      playhead.style.width = "";
    }
  }
}

function rollGridLength(grid: HTMLElement) {
  const value = Number(grid.dataset.rollLength);
  if ([12, 16, 24, 32, 48, 64].includes(value)) {
    return value;
  }
  return 16;
}

function upsertSession(
  sessions: SavedSession[],
  session: SavedSession,
): SavedSession[] {
  const index = sessions.findIndex(
    (candidate) =>
      candidate.id === session.id || candidate.slug === session.slug,
  );
  if (index === -1) {
    return [session, ...sessions];
  }

  return sessions.map((candidate, candidateIndex) =>
    candidateIndex === index ? session : candidate,
  );
}

function documentForRackState(
  systemModules: RackModuleState[],
  modules: RackModuleState[],
  cables: PatchCable[],
  tempoBpm: number,
) {
  const sharedModules = modulesForSharedSessionDocument(modules);
  const rackModules = [...systemModules, ...sharedModules];
  return sessionPartsToDocument({
    tempoBpm,
    systemModules,
    modules: sharedModules,
    cables: sanitizeCablesForRack(rackModules, cables),
  });
}

function modulesForSharedSessionDocument(modules: RackModuleState[]) {
  return modules.map(moduleWithoutLocalSessionState);
}

function moduleWithoutLocalSessionState(module: RackModuleState) {
  const shared = { ...module };
  delete shared.collapsed;
  return shared;
}

function authUserId(record: AuthModel) {
  return authRecordString(record, "id");
}

function authUsername(record: AuthModel) {
  return (
    authRecordString(record, "username") ||
    authRecordString(record, "name") ||
    authRecordString(record, "email") ||
    "user"
  );
}

function authRecordString(record: AuthModel, field: string) {
  if (!record) {
    return "";
  }
  const value = (record as Record<string, unknown>)[field];
  return typeof value === "string" ? value.trim() : "";
}

function lockedAudioInputModuleIds(
  modules: RackModuleState[],
  currentUserId: string,
) {
  const locked = new Set<number>();
  for (const module of modules) {
    if (isRemoteOwnedAudioInputModule(module, currentUserId)) {
      locked.add(module.id);
    }
  }
  return locked;
}

function isRemoteOwnedAudioInputModule(
  module: RackModuleState,
  currentUserId: string,
) {
  return (
    definitionForKind(module.kind).slug === AUDIO_INPUT_SLUG &&
    Boolean(module.ownerUserId) &&
    module.ownerUserId !== currentUserId
  );
}

function lockedAudioInputReason(module: RackModuleState) {
  const owner = module.ownerUsername?.trim() || "another user";
  return `owned by ${owner}`;
}

function rackForLocalAudioInputOwner(
  modules: RackModuleState[],
  cables: PatchCable[],
  currentUserId: string,
) {
  const locked = lockedAudioInputModuleIds(modules, currentUserId);
  if (locked.size === 0) {
    return { modules, cables };
  }
  return {
    modules: modules.filter((module) => !locked.has(module.id)),
    cables: cables.filter((cable) => !cableTouchesLockedModule(cable, locked)),
  };
}

function cableTouchesLockedModule(
  cable: PatchCable,
  lockedModuleIds: Set<number>,
) {
  return (
    lockedModuleIds.has(cable.from.moduleId) ||
    lockedModuleIds.has(cable.to.moduleId)
  );
}

function documentForSavedSession(session: SavedSession) {
  const modules = supportedRackModules(cloneModules(session.modules));
  return documentForRackState(
    systemModulesForSession(session),
    normalizeRackLayout(modules, moduleDefinitionMap, SYSTEM_RACK_ROWS),
    cloneCables(session.cables),
    session.tempoBpm,
  );
}

function sessionFromDocument(
  session: SavedSession,
  document: SessionDocumentV2,
  documentHash: string,
): SavedSession {
  const parts = documentToSessionParts(document);
  return {
    ...session,
    documentHash,
    tempoBpm: parts.tempoBpm,
    systemModules: parts.systemModules,
    modules: parts.modules,
    cables: parts.cables,
  };
}

function isRebaseableSessionUpdateError(error: unknown) {
  return isConflictError(error) || isInvalidSessionUpdateError(error);
}

function isConflictError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 409
  );
}

function isInvalidSessionUpdateError(error: unknown) {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { status?: number }).status !== 400
  ) {
    return false;
  }

  const message = errorMessage(error).toLowerCase();
  if (message.includes("invalid session update")) {
    return true;
  }

  const data = (error as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    JSON.stringify(data).toLowerCase().includes("invalid session update")
  );
}

function systemModulesForSession(
  session: SavedSession,
  localSystemModules: RackModuleState[] = [],
) {
  const defaults = createSystemRackModules();
  if (!session.systemModules) {
    return defaults.map((defaultModule) => {
      const localModule = localSystemModules.find(
        (candidate) =>
          candidate.id === defaultModule.id ||
          candidate.kind === defaultModule.kind,
      );
      return preserveSessionLocalModuleState(defaultModule, localModule);
    });
  }

  return defaults.map((defaultModule) => {
    const savedModule = session.systemModules?.find(
      (candidate) =>
        candidate.id === defaultModule.id ||
        candidate.kind === defaultModule.kind,
    );
    if (!savedModule) {
      const localModule = localSystemModules.find(
        (candidate) =>
          candidate.id === defaultModule.id ||
          candidate.kind === defaultModule.kind,
      );
      return preserveSessionLocalModuleState(defaultModule, localModule);
    }

    const localModule = localSystemModules.find(
      (candidate) =>
        candidate.id === defaultModule.id ||
        candidate.kind === defaultModule.kind,
    );
    return preserveSessionLocalModuleState(
      {
        ...defaultModule,
        label: savedModule.label ?? defaultModule.label,
        params: {
          ...defaultModule.params,
          ...savedModule.params,
        },
      },
      localModule,
    );
  });
}

function sessionStatusFor(
  loadState: "idle" | "loading" | "ready" | "error",
  loadError: string,
  saveState: SessionSaveState,
  saveError: string,
  readOnly: boolean,
) {
  if (loadState === "loading") {
    return { kind: "loading", label: "loading sessions" };
  }
  if (loadState === "error") {
    return { kind: "error", label: loadError || "session load failed" };
  }
  if (readOnly) {
    return { kind: "saved", label: "read only" };
  }
  if (saveState === "dirty") {
    return { kind: "dirty", label: "unsaved" };
  }
  if (saveState === "saving") {
    return { kind: "saving", label: "saving" };
  }
  if (saveState === "saved") {
    return { kind: "saved", label: "saved" };
  }
  if (saveState === "error") {
    return { kind: "error", label: saveError || "save failed" };
  }
  return null;
}

function sessionSlugFromLocation() {
  if (typeof window === "undefined") {
    return null;
  }

  const path = window.location.pathname;
  if (!path.startsWith(SESSION_PATH_PREFIX)) {
    return null;
  }

  const slug = path.slice(SESSION_PATH_PREFIX.length).split("/")[0];
  return slug ? decodeURIComponent(slug) : null;
}

function replaceSessionUrl(slug: string) {
  if (typeof window === "undefined") {
    return;
  }

  const nextPath = `${SESSION_PATH_PREFIX}${encodeURIComponent(slug)}`;
  const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
  if (
    `${window.location.pathname}${window.location.search}${window.location.hash}` !==
    nextUrl
  ) {
    window.history.replaceState(null, "", nextUrl);
  }
}

function clearSessionUrl() {
  if (typeof window === "undefined") {
    return;
  }

  const nextUrl = `/${window.location.search}${window.location.hash}`;
  if (
    `${window.location.pathname}${window.location.search}${window.location.hash}` !==
    nextUrl
  ) {
    window.history.replaceState(null, "", nextUrl);
  }
}

function nextUntitledSessionName(existingSessions: SavedSession[]) {
  const names = new Set(existingSessions.map((session) => session.name));
  let index = 1;
  let name = "Untitled Session";
  while (names.has(name)) {
    index += 1;
    name = `Untitled Session ${index}`;
  }
  return name;
}

function promptNewSessionName(defaultName: string) {
  if (typeof window === "undefined") {
    return defaultName;
  }

  const name = window.prompt("Name this session", defaultName);
  if (name === null) {
    return null;
  }

  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

function confirmDeleteSession(sessionName: string) {
  if (typeof window === "undefined") {
    return true;
  }

  return window.confirm(`Delete "${sessionName}"? This cannot be undone.`);
}

function promptModulePresetName(defaultName: string) {
  if (typeof window === "undefined") {
    return defaultName;
  }

  const name = window.prompt("Name this module preset", defaultName);
  if (name === null) {
    return null;
  }

  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Request failed.";
}

export default App;
