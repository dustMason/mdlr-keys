import type {
  JackDefinition,
  ModuleDefinition,
  PatchCable,
  RackModuleState,
} from "../types";

interface RhythmTrackLabelContext {
  module: RackModuleState;
  definition: ModuleDefinition;
  rackModules?: readonly RackModuleState[];
  patchCables?: readonly PatchCable[];
  definitionsByKind?: ReadonlyMap<number, ModuleDefinition>;
  fallbackLabels: readonly string[];
}

export function rhythmTrackLabelsForConnections({
  module,
  definition,
  rackModules,
  patchCables,
  definitionsByKind,
  fallbackLabels,
}: RhythmTrackLabelContext) {
  if (!rackModules || !patchCables || !definitionsByKind) {
    return [...fallbackLabels];
  }

  const gateOutputs = sortedGateJacks(definition.outputs);
  return fallbackLabels.map((fallback, trackIndex) => {
    const output = gateOutputs[trackIndex];
    if (!output) {
      return fallback;
    }

    const cable = patchCables.find(
      (candidate) =>
        candidate.from.moduleId === module.id &&
        candidate.from.jackId === output.id &&
        candidate.from.direction === "output" &&
        candidate.from.kind === "gate" &&
        candidate.to.direction === "input" &&
        candidate.to.kind === "gate",
    );
    if (!cable) {
      return fallback;
    }

    const destinationModule = rackModules.find(
      (candidate) => candidate.id === cable.to.moduleId,
    );
    const destinationDefinition =
      destinationModule === undefined
        ? undefined
        : definitionsByKind.get(destinationModule.kind);
    const destinationJack = destinationDefinition?.inputs.find(
      (jack) => jack.id === cable.to.jackId && jack.kind === "gate",
    );

    return destinationJackLabel(destinationJack) ?? fallback;
  });
}

function sortedGateJacks(jacks: readonly JackDefinition[]) {
  return jacks
    .filter((jack) => jack.kind === "gate")
    .sort(
      (a, b) =>
        (a.connectionOrder ?? a.id) - (b.connectionOrder ?? b.id) ||
        a.id - b.id,
    );
}

function destinationJackLabel(jack: JackDefinition | undefined) {
  if (!jack) {
    return null;
  }

  return (
    usableGateLabel(jack.connectionGroupLabel) ??
    usableGateLabel(jack.label) ??
    usableGateLabel(jack.connectionLabel)
  );
}

function usableGateLabel(label: string | undefined) {
  const trimmed = label?.trim();
  if (!trimmed) {
    return null;
  }

  const withoutGenericGateWords = trimmed
    .replace(/\b(gate|trigger|trig|input|in)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const candidate = withoutGenericGateWords || trimmed;
  const normalized = candidate.toLowerCase();

  if (/^\d+$/.test(normalized) || genericGateLabels.has(normalized)) {
    return null;
  }

  return candidate.toUpperCase();
}

const genericGateLabels = new Set([
  "gate",
  "trigger",
  "trig",
  "input",
  "in",
]);
