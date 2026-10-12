import type { PointerEvent } from "react";
import {
  CONNECTION_JACK_HEIGHT,
  connectionJackAnchorX,
  connectionJackLayout,
} from "./jackLayout";
import { collapsedPatchSlotMetrics } from "./collapsedPatchSlot";
import {
  RACK_FLANGE_WIDTH,
  RACK_MODULE_HEADER_HEIGHT,
  rackModulePixelHeightForState,
  rackModulePixelPosition,
  rackModulePixelWidth,
} from "./rackLayout";
import type {
  CableEndpoint,
  ModuleDefinition,
  PatchCable,
  RackModuleState,
} from "../modules/types";

type CableEnd = "from" | "to";
interface CableEndpointPosition {
  x: number;
  y: number;
  collapsedSlot?: boolean;
}

interface CableLayerProps {
  modules: RackModuleState[];
  definitions: Map<number, ModuleDefinition>;
  cables: PatchCable[];
  draft: {
    anchor: CableEndpoint;
    cableId?: string;
    kind: CableEndpoint["kind"];
    pointer: { x: number; y: number };
    snapTarget?: CableEndpoint | null;
  } | null;
  onRemoveCable: (cableId: string) => void;
  onStartCableEdit: (
    cable: PatchCable,
    end: CableEnd,
    event: PointerEvent<SVGGElement>,
  ) => void;
}

export function CableLayer({
  modules,
  definitions,
  cables,
  draft,
  onRemoveCable,
  onStartCableEdit,
}: CableLayerProps) {
  return (
    <svg className="cableLayer" aria-hidden="true">
      {cables.map((cable) => {
        if (draft?.cableId === cable.id) {
          return null;
        }

        const from = endpointPosition(cable.from, modules, definitions);
        const to = endpointPosition(cable.to, modules, definitions);
        if (!from || !to) {
          return null;
        }

        const d = cablePath(from, to);
        const collapsed = from.collapsedSlot || to.collapsedSlot;

        return (
          <g key={cable.id}>
            <path
              className={[
                "patchCableShadow",
                collapsed ? "patchCableShadowCollapsed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              d={d}
            />
            <path
              className={[
                "patchCable",
                `cable-${cable.from.kind}`,
                collapsed ? "patchCableCollapsed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              d={d}
              onClick={() => onRemoveCable(cable.id)}
            />
            <CableEndHandle
              cable={cable}
              end="from"
              position={from}
              onStartCableEdit={onStartCableEdit}
            />
            <CableEndHandle
              cable={cable}
              end="to"
              position={to}
              onStartCableEdit={onStartCableEdit}
            />
          </g>
        );
      })}

      {draft ? (
        <DraftCablePath draft={draft} modules={modules} definitions={definitions} />
      ) : null}
    </svg>
  );
}

function DraftCablePath({
  draft,
  modules,
  definitions,
}: {
  draft: NonNullable<CableLayerProps["draft"]>;
  modules: RackModuleState[];
  definitions: Map<number, ModuleDefinition>;
}) {
  const d = draftPath(draft.anchor, draft.pointer, modules, definitions);
  return (
    <>
      <path className="patchCableShadow cableDraftShadow" d={d} />
      <path className={`patchCable cableDraft cable-${draft.kind}`} d={d} />
    </>
  );
}

export function endpointPosition(
  endpoint: CableEndpoint,
  modules: RackModuleState[],
  definitions: Map<number, ModuleDefinition>,
): CableEndpointPosition | null {
  const module = modules.find((candidate) => candidate.id === endpoint.moduleId);
  if (!module) {
    return null;
  }

  const definition = definitions.get(module.kind);
  if (!definition) {
    return null;
  }

  if (module.collapsed && !module.fixed) {
    return collapsedSlotEndpointPosition(endpoint, module, definition);
  }

  const moduleWidth = rackModulePixelWidth(definition);
  const moduleHeight = rackModulePixelHeightForState(module, definition);
  const moduleFaceWidth = moduleWidth - RACK_FLANGE_WIDTH * 2;
  const connectionBayTop = module.fixed ? 0 : RACK_MODULE_HEADER_HEIGHT;
  const connectionBayHeight = Math.max(
    CONNECTION_JACK_HEIGHT + 36,
    moduleHeight - connectionBayTop,
  );
  const row = connectionJackLayout(
    definition.inputs,
    definition.outputs,
    moduleFaceWidth,
    connectionBayHeight,
    { directionChrome: definition.connectionViewChrome !== "minimal" },
  ).rows.find(
    (candidate) =>
      candidate.direction === endpoint.direction &&
      candidate.jack.id === endpoint.jackId,
  );
  if (!row) {
    return null;
  }

  const position = rackModulePixelPosition(module);
  return {
    x: position.x + RACK_FLANGE_WIDTH + connectionJackAnchorX(row),
    y: position.y + connectionBayTop + row.centerY,
  };
}

function collapsedSlotEndpointPosition(
  endpoint: CableEndpoint,
  module: RackModuleState,
  definition: ModuleDefinition,
): CableEndpointPosition | null {
  const endpoints = [
    ...definition.inputs.map((jack) => ({
      direction: "input" as const,
      jack,
    })),
    ...definition.outputs.map((jack) => ({
      direction: "output" as const,
      jack,
    })),
  ];
  const index = endpoints.findIndex(
    (candidate) =>
      candidate.direction === endpoint.direction &&
      candidate.jack.id === endpoint.jackId,
  );
  if (index === -1) {
    return null;
  }

  const position = rackModulePixelPosition(module);
  const moduleWidth = rackModulePixelWidth(definition);
  const moduleFaceWidth = moduleWidth - RACK_FLANGE_WIDTH * 2;
  const slot = collapsedPatchSlotMetrics(moduleFaceWidth);

  return {
    x:
      position.x +
      RACK_FLANGE_WIDTH +
      slot.left +
      (slot.width * (index + 0.5)) / Math.max(1, endpoints.length),
    y: position.y + slot.centerY,
    collapsedSlot: true,
  };
}

function draftPath(
  anchor: CableEndpoint,
  pointer: { x: number; y: number },
  modules: RackModuleState[],
  definitions: Map<number, ModuleDefinition>,
) {
  const start = endpointPosition(anchor, modules, definitions);
  if (!start) {
    return "";
  }
  return cablePath(start, pointer);
}

function CableEndHandle({
  cable,
  end,
  position,
  onStartCableEdit,
}: {
  cable: PatchCable;
  end: CableEnd;
  position: CableEndpointPosition;
  onStartCableEdit: CableLayerProps["onStartCableEdit"];
}) {
  return (
    <g
      className={[
        "cableEndHandle",
        `cable-${cable.from.kind}`,
        position.collapsedSlot ? "cableEndHandleCollapsed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={(event) => onStartCableEdit(cable, end, event)}
    >
      <circle className="cableEndHit" cx={position.x} cy={position.y} r="18" />
      <circle className="cableEndJackRim" cx={position.x} cy={position.y} r="9" />
      <circle className="cableEndJackHole" cx={position.x} cy={position.y} r="4" />
    </g>
  );
}

const VERTICAL_CABLE_EPSILON = 10;

interface CablePathPoint {
  x: number;
  y: number;
  collapsedSlot?: boolean;
}

export function cablePath(
  from: CablePathPoint,
  to: CablePathPoint,
) {
  const dx = to.x - from.x;
  const span = Math.abs(dx);
  if (span <= VERTICAL_CABLE_EPSILON) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }

  const vertical = Math.abs(to.y - from.y);
  const sag =
    from.collapsedSlot || to.collapsedSlot
      ? Math.min(128, Math.max(24, 18 + span * 0.04 + vertical * 0.035))
      : Math.min(320, Math.max(78, 44 + span * 0.12 + vertical * 0.12));
  const belly = Math.max(from.y, to.y) + sag;
  const controlX = (from.x + to.x) * 0.5;
  const controlY = belly * 2 - (from.y + to.y) * 0.5;

  return `M ${from.x} ${from.y} Q ${controlX} ${controlY}, ${to.x} ${to.y}`;
}
