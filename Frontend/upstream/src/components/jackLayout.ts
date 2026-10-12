import type {
  JackDefinition,
  JackDirection,
  SignalKind,
} from "../modules/types";

export const MODULE_WIDTH = 238;
export const CONNECTION_BUTTON_WIDTH = 58;
export const CONNECTION_JACK_HEIGHT = 44;
export const CONNECTION_JACK_SOCKET_SIZE = 18;
export const CONNECTION_JACK_SOCKET_CENTER_X = CONNECTION_BUTTON_WIDTH / 2;
export const CONNECTION_JACK_SOCKET_CENTER_Y = 30;
export const CONNECTION_BASE_X = 8;
export const CONNECTION_TOP_Y = 8;
export const CONNECTION_BOTTOM_PAD = 8;
export const CONNECTION_COLUMN_GAP = 6;
export const CONNECTION_ROW_GAP = 6;
export const CONNECTION_GROUPED_BOX_HEIGHT = 54;
export const CONNECTION_GROUPED_BOX_PAD_X = 4;
export const CONNECTION_GROUPED_JACK_TOP = 17;
export const CONNECTION_GROUPED_JACK_WIDTH = 21;
export const CONNECTION_GROUPED_JACK_HEIGHT = 34;
export const CONNECTION_GROUPED_JACK_GAP = 3;
export const CONNECTION_GROUPED_JACK_SOCKET_CENTER_Y = 24;

const SIGNAL_ORDER: SignalKind[] = ["audio", "cv", "gate"];
const COMPACT_SPLIT_HEIGHT = 150;
const DIRECTION_GAP = 8;
const DIRECTION_PAD_X = 6;
const DIRECTION_PAD_TOP = 18;
const DIRECTION_PAD_BOTTOM = 6;

export interface ConnectionJackLayout {
  sections: ConnectionDirectionSection[];
  boxes: ConnectionJackBox[];
  rows: ConnectionJackRow[];
}

export interface ConnectionDirectionSection {
  direction: JackDirection;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ConnectionJackBox {
  id: string;
  kind: SignalKind;
  direction: JackDirection;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ConnectionJackRow {
  jack: JackDefinition;
  direction: JackDirection;
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  grouped: boolean;
  displayLabel: string;
}

interface DirectionLayout {
  section: ConnectionDirectionSection;
  boxes: ConnectionJackBox[];
  rows: ConnectionJackRow[];
}

export interface ConnectionJackLayoutOptions {
  directionChrome?: boolean;
}

interface LayoutItem {
  id: string;
  kind: SignalKind;
  direction: JackDirection;
  jacks: JackDefinition[];
  label: string;
  width: number;
  height: number;
  left: number;
  top: number;
  grouped: boolean;
}

export function connectionJackLayout(
  inputs: JackDefinition[],
  outputs: JackDefinition[],
  moduleWidth: number,
  moduleHeight: number,
  options: ConnectionJackLayoutOptions = {},
): ConnectionJackLayout {
  const width = availableWidth(moduleWidth);
  const placementWidth = Math.max(CONNECTION_BUTTON_WIDTH, moduleWidth - CONNECTION_BASE_X);
  const input = buildDirection("input", inputs, width, options);
  const output = buildDirection("output", outputs, width, options);
  const bothDirections = input && output;

  if (bothDirections && fitsSideBySide(input, output, placementWidth)) {
    return mergeDirections([
      translateDirection(input, CONNECTION_BASE_X, CONNECTION_TOP_Y),
      translateDirection(
        output,
        CONNECTION_BASE_X + input.section.width + DIRECTION_GAP,
        CONNECTION_TOP_Y,
      ),
    ]);
  }

  if (bothDirections && moduleHeight < COMPACT_SPLIT_HEIGHT) {
    const splitWidth = (width - DIRECTION_GAP) / 2;
    const compactInput = buildDirection("input", inputs, splitWidth, options);
    const compactOutput = buildDirection("output", outputs, splitWidth, options);
    return mergeDirections([
      compactInput ? translateDirection(compactInput, CONNECTION_BASE_X, 10) : null,
      compactOutput
        ? translateDirection(
            compactOutput,
            CONNECTION_BASE_X + splitWidth + DIRECTION_GAP,
            10,
          )
        : null,
    ]);
  }

  const placedInput = input
    ? translateDirection(input, CONNECTION_BASE_X, CONNECTION_TOP_Y)
    : null;
  const outputTop = output
    ? stackedOutputTop(input, output, moduleHeight)
    : 0;
  const placedOutput = output
    ? translateDirection(output, CONNECTION_BASE_X, outputTop)
    : null;

  return mergeDirections([placedInput, placedOutput]);
}

export function connectionJackRows(
  jacks: JackDefinition[],
  direction: JackDirection,
  moduleWidth: number,
  moduleHeight: number,
): ConnectionJackRow[] {
  return connectionJackLayout(
    direction === "input" ? jacks : [],
    direction === "output" ? jacks : [],
    moduleWidth,
    moduleHeight,
  ).rows;
}

export function connectionJackBoxes(
  jacks: JackDefinition[],
  direction: JackDirection,
  moduleWidth: number,
  moduleHeight: number,
): ConnectionJackBox[] {
  return connectionJackLayout(
    direction === "input" ? jacks : [],
    direction === "output" ? jacks : [],
    moduleWidth,
    moduleHeight,
  ).boxes;
}

export function connectionJackAnchorX(row: ConnectionJackRow) {
  return row.centerX;
}

function availableWidth(moduleWidth: number) {
  return Math.max(CONNECTION_BUTTON_WIDTH, moduleWidth - CONNECTION_BASE_X * 2);
}

function mergeDirections(directions: Array<DirectionLayout | null>): ConnectionJackLayout {
  const present = directions.filter((direction) => direction !== null);
  return {
    sections: present.map((direction) => direction.section),
    boxes: present.flatMap((direction) => direction.boxes),
    rows: present.flatMap((direction) => direction.rows),
  };
}

function fitsSideBySide(
  input: DirectionLayout,
  output: DirectionLayout,
  maxWidth: number,
) {
  return input.section.width + DIRECTION_GAP + output.section.width <= maxWidth;
}

function stackedOutputTop(
  input: DirectionLayout | null,
  output: DirectionLayout,
  moduleHeight: number,
) {
  const bottomAlignedTop = Math.max(
    CONNECTION_TOP_Y,
    moduleHeight - output.section.height - CONNECTION_BOTTOM_PAD,
  );
  if (!input) {
    return bottomAlignedTop;
  }

  return Math.max(
    bottomAlignedTop,
    CONNECTION_TOP_Y + input.section.height + DIRECTION_GAP,
  );
}

function buildDirection(
  direction: JackDirection,
  jacks: JackDefinition[],
  maxWidth: number,
  options: ConnectionJackLayoutOptions,
): DirectionLayout | null {
  if (jacks.length === 0) {
    return null;
  }

  const items = itemsForJacks(jacks, direction);
  if (items.length === 0) {
    return null;
  }
  const padX = options.directionChrome === false ? 0 : DIRECTION_PAD_X;
  const padTop = options.directionChrome === false ? 0 : DIRECTION_PAD_TOP;
  const padBottom = options.directionChrome === false ? 0 : DIRECTION_PAD_BOTTOM;
  const contentWidth = Math.max(
    CONNECTION_BUTTON_WIDTH,
    maxWidth - padX * 2,
  );
  layoutItems(items, contentWidth);

  const itemRight = Math.max(...items.map((item) => item.left + item.width));
  const itemBottom = Math.max(...items.map((item) => item.top + item.height));
  const width = itemRight + padX * 2;
  const height = itemBottom + padTop + padBottom;
  const boxes: ConnectionJackBox[] = [];
  const rows: ConnectionJackRow[] = [];
  for (const item of items) {
    if (item.grouped) {
      boxes.push({
        id: item.id,
        kind: item.kind,
        direction: item.direction,
        label: `${item.label} ${directionLabel(direction)}`,
        left: item.left + padX,
        top: item.top + padTop,
        width: item.width,
        height: item.height,
      });
    }
    rows.push(...rowsForItem(item, padX, padTop));
  }

  const section: ConnectionDirectionSection = {
    direction,
    label: directionLabel(direction),
    left: 0,
    top: 0,
    width,
    height,
  };

  return { section, boxes, rows };
}

function translateDirection(layout: DirectionLayout, x: number, y: number): DirectionLayout {
  layout.section.left += x;
  layout.section.top += y;
  for (const box of layout.boxes) {
    box.left += x;
    box.top += y;
  }
  for (const row of layout.rows) {
    row.left += x;
    row.top += y;
    row.centerX += x;
    row.centerY += y;
  }
  return layout;
}

function layoutItems(items: LayoutItem[], maxWidth: number) {
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const item of items) {
    if (cursorX > 0 && cursorX + item.width > maxWidth) {
      cursorX = 0;
      cursorY += rowHeight + CONNECTION_ROW_GAP;
      rowHeight = 0;
    }

    item.left = cursorX;
    item.top = cursorY;
    cursorX += item.width + CONNECTION_COLUMN_GAP;
    rowHeight = Math.max(rowHeight, item.height);
  }
}

function itemsForJacks(jacks: JackDefinition[], direction: JackDirection) {
  return SIGNAL_ORDER.flatMap((kind) =>
    itemsForKind(sortedJacksForKind(jacks, kind), direction),
  );
}

function itemsForKind(jacks: JackDefinition[], direction: JackDirection) {
  const explicitGroups = new Map<string, JackDefinition[]>();
  const singles: JackDefinition[] = [];

  for (const jack of jacks) {
    if (jack.connectionGroup) {
      const group = explicitGroups.get(jack.connectionGroup) ?? [];
      group.push(jack);
      explicitGroups.set(jack.connectionGroup, group);
    } else {
      singles.push(jack);
    }
  }

  const autoGroups = autoStereoItems(singles, direction);
  const autoIds = new Set(
    autoGroups.flatMap((item) => item.jacks.map((jack) => jack.id)),
  );
  return [
    ...singles
      .filter((jack) => !autoIds.has(jack.id))
      .map((jack) => singleItem(jack, direction)),
    ...autoGroups,
    ...Array.from(explicitGroups.entries()).map(([id, group]) =>
      groupedItem(id, group, direction),
    ),
  ].sort((a, b) => itemOrder(a) - itemOrder(b) || a.id.localeCompare(b.id));
}

function singleItem(jack: JackDefinition, direction: JackDirection): LayoutItem {
  return {
    id: `single-${direction}-${jack.id}`,
    kind: jack.kind,
    direction,
    jacks: [jack],
    label: jack.connectionGroupLabel ?? jack.label,
    width: CONNECTION_BUTTON_WIDTH,
    height: CONNECTION_JACK_HEIGHT,
    left: 0,
    top: 0,
    grouped: false,
  };
}

function groupedItem(
  id: string,
  jacks: JackDefinition[],
  direction: JackDirection,
): LayoutItem {
  const sorted = [...jacks].sort(compareJacks);
  const width =
    CONNECTION_GROUPED_BOX_PAD_X * 2 +
    sorted.length * CONNECTION_GROUPED_JACK_WIDTH +
    Math.max(0, sorted.length - 1) * CONNECTION_GROUPED_JACK_GAP;
  return {
    id: `group-${direction}-${id}`,
    kind: sorted[0].kind,
    direction,
    jacks: sorted,
    label: sorted[0].connectionGroupLabel ?? id,
    width: Math.max(CONNECTION_BUTTON_WIDTH, width),
    height: CONNECTION_GROUPED_BOX_HEIGHT,
    left: 0,
    top: 0,
    grouped: true,
  };
}

function autoStereoItems(
  singles: JackDefinition[],
  direction: JackDirection,
): LayoutItem[] {
  const available = [...singles].sort(compareJacks);
  const used = new Set<number>();
  const items: LayoutItem[] = [];

  for (let index = 0; index < available.length; index += 1) {
    const left = available[index];
    const leftMatch = stereoLabel(left.label);
    if (used.has(left.id) || left.kind !== "audio" || leftMatch?.side !== "L") {
      continue;
    }

    const right = available.find((candidate, candidateIndex) => {
      if (
        candidateIndex <= index ||
        used.has(candidate.id) ||
        candidate.kind !== left.kind
      ) {
        return false;
      }
      const rightMatch = stereoLabel(candidate.label);
      return rightMatch?.side === "R" && rightMatch.base === leftMatch.base;
    });
    if (!right) {
      continue;
    }

    used.add(left.id);
    used.add(right.id);
    items.push(
      groupedItem(
        `auto-stereo-${direction}-${left.id}-${right.id}`,
        [
          withStereoGroupLabel(left, leftMatch, direction),
          withStereoGroupLabel(right, leftMatch, direction),
        ],
        direction,
      ),
    );
  }

  return items;
}

function rowsForItem(item: LayoutItem, offsetX: number, offsetY: number): ConnectionJackRow[] {
  if (!item.grouped) {
    return item.jacks.map((jack) => ({
      jack,
      direction: item.direction,
      left: item.left + offsetX,
      top: item.top + offsetY,
      width: CONNECTION_BUTTON_WIDTH,
      height: CONNECTION_JACK_HEIGHT,
      centerX: item.left + offsetX + CONNECTION_JACK_SOCKET_CENTER_X,
      centerY: item.top + offsetY + CONNECTION_JACK_SOCKET_CENTER_Y,
      grouped: false,
      displayLabel: jack.connectionLabel ?? jack.label,
    }));
  }

  const groupWidth =
    item.jacks.length * CONNECTION_GROUPED_JACK_WIDTH +
    Math.max(0, item.jacks.length - 1) * CONNECTION_GROUPED_JACK_GAP;
  const startX = item.left + offsetX + (item.width - groupWidth) * 0.5;
  const top = item.top + offsetY + CONNECTION_GROUPED_JACK_TOP;

  return item.jacks.map((jack, index) => {
    const left =
      startX +
      index * (CONNECTION_GROUPED_JACK_WIDTH + CONNECTION_GROUPED_JACK_GAP);
    return {
      jack,
      direction: item.direction,
      left,
      top,
      width: CONNECTION_GROUPED_JACK_WIDTH,
      height: CONNECTION_GROUPED_JACK_HEIGHT,
      centerX: left + CONNECTION_GROUPED_JACK_WIDTH * 0.5,
      centerY: top + CONNECTION_GROUPED_JACK_SOCKET_CENTER_Y,
      grouped: true,
      displayLabel: jack.connectionLabel ?? jack.label,
    };
  });
}

function sortedJacksForKind(jacks: JackDefinition[], kind: SignalKind) {
  return jacks.filter((jack) => jack.kind === kind).sort(compareJacks);
}

function compareJacks(a: JackDefinition, b: JackDefinition) {
  return (a.connectionOrder ?? a.id) - (b.connectionOrder ?? b.id) || a.id - b.id;
}

function itemOrder(item: LayoutItem) {
  return Math.min(
    ...item.jacks.map(
      (jack) => jack.connectionGroupOrder ?? jack.connectionOrder ?? jack.id,
    ),
  );
}

function directionLabel(direction: JackDirection) {
  return direction === "input" ? "IN" : "OUT";
}

function stereoLabel(label: string) {
  const spaced = label.trim().toLowerCase().replace(/\s+/g, " ");

  if (spaced === "left" || spaced === "l") {
    return { base: "", side: "L" as const };
  }
  if (spaced === "right" || spaced === "r") {
    return { base: "", side: "R" as const };
  }

  const suffixMatch = spaced.match(/^(.*)\s+(left|right|l|r)$/);
  if (!suffixMatch) {
    return null;
  }

  return {
    base: suffixMatch[1].trim(),
    side: suffixMatch[2].startsWith("l") ? ("L" as const) : ("R" as const),
  };
}

function withStereoGroupLabel(
  jack: JackDefinition,
  match: NonNullable<ReturnType<typeof stereoLabel>>,
  direction: JackDirection,
): JackDefinition {
  const side = stereoLabel(jack.label)?.side;
  return {
    ...jack,
    connectionGroupLabel:
      match.base || (direction === "output" ? "main" : "stereo"),
    connectionLabel: side ?? jack.connectionLabel ?? jack.label,
  };
}
