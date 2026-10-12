import type { CSSProperties, PropsWithChildren } from "react";
import { JackPort } from "./Jack";
import { collapsedPatchSlotMetrics } from "./collapsedPatchSlot";
import {
  CONNECTION_JACK_HEIGHT,
  connectionJackLayout,
} from "./jackLayout";
import {
  RACK_FLANGE_WIDTH,
  RACK_MODULE_HEADER_HEIGHT,
  rackModulePixelHeightForState,
  rackModulePixelPosition,
  rackModulePixelWidth,
  rackModuleUnits,
  rackModuleWidthMode,
} from "./rackLayout";
import type { ModuleRenderProps } from "../modules/types";

type ModuleShellProps = PropsWithChildren<ModuleRenderProps>;

const DEFAULT_SKIN_MODULE_SLUGS = new Set([
  "amp",
  "muta",
  "chord",
  "delay",
  "cr78",
  "crisp",
  "curve",
  "drone",
  "dx",
  "eq3",
  "euclid",
  "in",
  "six",
  "lfo",
  "loop",
  "choir",
  "melodic-sequencer",
  "samp",
  "verb",
  "five",
  "r6",
  "rhythm-sequencer",
  "roll",
  "one",
  "squeeze",
  "stone",
]);

export function ModuleShell({
  module,
  definition,
  connectionView,
  moduleLevel = 0,
  modulePresetOptions,
  locked = false,
  lockedReason,
  insertTarget = false,
  dragging = false,
  onBeginModuleDrag,
  onModuleCollapseToggle,
  onModuleLabelChange,
  onModulePresetSelect,
  onModulePresetSave,
  onDeleteModule,
  onParamChange,
  onStartCable,
  onFinishCable,
  onOpenJackMenu,
  children,
}: ModuleShellProps) {
  const moduleWidth = rackModulePixelWidth(definition);
  const moduleHeight = rackModulePixelHeightForState(module, definition);
  const moduleUnits = rackModuleUnits(definition);
  const moduleFaceWidth = moduleWidth - RACK_FLANGE_WIDTH * 2;
  const collapsedSlot = collapsedPatchSlotMetrics(moduleFaceWidth);
  const position = rackModulePixelPosition(module);
  const isFixed = module.fixed === true;
  const isCollapsed = !isFixed && module.collapsed === true;
  const flangeUnits = isFixed || isCollapsed ? 1 : moduleUnits;
  const bypassParamId = definition.bypassParamId;
  const factoryPresets = definition.presets ?? [];
  const userPresets = modulePresetOptions ?? [];
  const hasPresetMenu = factoryPresets.length > 0 || userPresets.length > 0;
  const bypassed =
    bypassParamId === undefined ? false : (module.params[bypassParamId] ?? 0) >= 0.5;
  const connectionBayTop = isFixed ? 0 : RACK_MODULE_HEADER_HEIGHT;
  const connectionBayHeight = Math.max(
    CONNECTION_JACK_HEIGHT + 36,
    moduleHeight - connectionBayTop,
  );

  return (
    <section
      data-module-id={module.id}
      className={[
        "rackModule",
        isFixed ? "rackModuleFixed" : "",
        isFixed ? "rackModuleSystem" : "",
        DEFAULT_SKIN_MODULE_SLUGS.has(definition.slug) ? "moduleDefaultSkin" : "",
        isCollapsed ? "rackModuleCollapsed" : "",
        locked ? "rackModuleLocked" : "",
        insertTarget ? "rackModuleInsertTarget" : "",
        dragging ? "rackModuleDragging" : "",
        `module-${definition.slug}`,
        `rackWidth-${rackModuleWidthMode(definition)}`,
        `rackUnits-${moduleUnits}`,
        connectionView ? "moduleConnectionView" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          transform: `translate(${position.x}px, ${position.y}px)`,
          "--module-accent": definition.accent,
          "--rack-units": moduleUnits,
          "--rack-flange-width": `${RACK_FLANGE_WIDTH}px`,
          width: moduleWidth,
          height: moduleHeight,
          minHeight: moduleHeight,
        } as CSSProperties
      }
      aria-disabled={locked || undefined}
    >
      <RackFlange side="left" units={flangeUnits} singleScrew={isCollapsed} />
      <RackFlange side="right" units={flangeUnits} singleScrew={isCollapsed} />

      <div className="moduleFace">
        {isFixed ? null : (
          <div
            className="moduleHeader"
            onPointerDown={(event) => {
              if (locked) {
                return;
              }
              onBeginModuleDrag(module.id, event);
            }}
          >
            <button
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${definition.name}`}
              className="moduleCollapseButton"
              disabled={locked}
              title={locked ? lockedReason : isCollapsed ? "Expand" : "Collapse"}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (locked) {
                  return;
                }
                onModuleCollapseToggle(module.id);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <span />
            </button>
            <span className="moduleName">{definition.name}</span>
            <input
              aria-label={`${definition.name} rack label`}
              className="moduleLabelInput"
              maxLength={28}
              placeholder="label"
              spellCheck={false}
              type="text"
              value={module.label ?? ""}
              disabled={locked}
              title={locked ? lockedReason : undefined}
              onChange={(event) => {
                if (locked) {
                  return;
                }
                onModuleLabelChange(module.id, event.target.value);
              }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            />
            {hasPresetMenu ? (
              <select
                aria-label={`${definition.name} presets`}
                className="modulePresetSelect"
                disabled={locked}
                title={locked ? lockedReason : undefined}
                value=""
                onChange={(event) => {
                  if (locked) {
                    event.currentTarget.value = "";
                    return;
                  }
                  const presetId = event.target.value;
                  event.currentTarget.value = "";
                  if (!presetId) {
                    return;
                  }
                  if (presetId === "__save") {
                    onModulePresetSave(module.id);
                  } else {
                    onModulePresetSelect(module.id, presetId);
                  }
                }}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <option value="">preset</option>
                {userPresets.length > 0 ? (
                  <optgroup label="mine">
                    {userPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {factoryPresets.length > 0 ? (
                  <optgroup label="factory">
                    {factoryPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <option value="__save">save preset...</option>
              </select>
            ) : null}
            <div className="moduleHeaderActions">
              {bypassParamId === undefined ? null : (
                <button
                  aria-label={`${bypassed ? "Disable" : "Enable"} ${definition.name} bypass`}
                  aria-pressed={bypassed}
                  className={[
                    "moduleBypassButton",
                    bypassed ? "moduleBypassButtonActive" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  title={`${bypassed ? "Disable" : "Enable"} bypass`}
                  type="button"
                  disabled={locked}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (locked) {
                      return;
                    }
                    onParamChange(module.id, bypassParamId, bypassed ? 0 : 1);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  byp
                </button>
              )}
              <ModuleActivityMeter level={moduleLevel} />
              <button
                aria-label={`Delete ${definition.name}`}
                className="moduleDeleteButton"
                disabled={locked}
                title={locked ? lockedReason : `Delete ${definition.name}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (locked) {
                    return;
                  }
                  onDeleteModule(module.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                X
              </button>
            </div>
          </div>
        )}

        {isCollapsed && connectionView ? (
          <span
            className="collapsedPatchSlot"
            aria-hidden="true"
            style={
              {
                "--collapsed-patch-slot-left": `${collapsedSlot.left}px`,
                "--collapsed-patch-slot-width": `${collapsedSlot.width}px`,
              } as CSSProperties
            }
          />
        ) : null}

        {isCollapsed ? null : connectionView ? (
          <ConnectionBay
            moduleId={module.id}
            moduleWidth={moduleFaceWidth}
            moduleHeight={connectionBayHeight}
            top={connectionBayTop}
            definition={definition}
            onStartCable={onStartCable}
            onFinishCable={onFinishCable}
            onOpenJackMenu={onOpenJackMenu}
            locked={locked}
          />
        ) : (
          <div className="moduleBody">
            {children}
          </div>
        )}
      </div>
    </section>
  );
}

function ModuleActivityMeter({ level }: { level: number }) {
  const normalized = normalizeMeterLevel(level);
  return (
    <span
      aria-label="module output level"
      className="moduleActivityMeter"
      title="Output level"
    >
      {[0.08, 0.28, 0.58].map((threshold) => (
        <span
          key={threshold}
          className={normalized >= threshold ? "isActive" : ""}
        />
      ))}
    </span>
  );
}

function normalizeMeterLevel(level: number) {
  if (!Number.isFinite(level) || level <= 0.000_2) {
    return 0;
  }
  return Math.max(0, Math.min(1, (Math.log10(level) + 3) / 3));
}

function RackFlange({
  side,
  units,
  singleScrew = false,
}: {
  side: "left" | "right";
  units: number;
  singleScrew?: boolean;
}) {
  if (singleScrew) {
    return (
      <div className={`rackFlange rackFlange-${side}`} aria-hidden="true">
        <span className="rackFlangeUnit">
          <span
            className="rackScrew rackScrew-center"
            style={
              {
                "--screw-angle": `${rackScrewAngle(side, 0, "center")}deg`,
              } as CSSProperties
            }
          />
        </span>
      </div>
    );
  }

  return (
    <div className={`rackFlange rackFlange-${side}`} aria-hidden="true">
      {Array.from({ length: units }, (_, index) => (
        <span className="rackFlangeUnit" key={index}>
          <span
            className="rackScrew rackScrew-top"
            style={
              { "--screw-angle": `${rackScrewAngle(side, index, "top")}deg` } as CSSProperties
            }
          />
          <span
            className="rackScrew rackScrew-bottom"
            style={
              {
                "--screw-angle": `${rackScrewAngle(side, index, "bottom")}deg`,
              } as CSSProperties
            }
          />
        </span>
      ))}
    </div>
  );
}

function rackScrewAngle(
  side: "left" | "right",
  unitIndex: number,
  position: "top" | "bottom" | "center",
) {
  const sideSeed = side === "left" ? 19 : 53;
  const positionSeed = position === "top" ? 7 : position === "bottom" ? 31 : 43;
  const hash = (sideSeed + unitIndex * 37 + positionSeed * 17) % 53;
  return hash - 26;
}

function ConnectionBay({
  moduleId,
  moduleWidth,
  moduleHeight,
  top,
  definition,
  onStartCable,
  onFinishCable,
  onOpenJackMenu,
  locked = false,
}: Pick<
  ModuleRenderProps,
  "onStartCable" | "onFinishCable" | "onOpenJackMenu"
> & {
  moduleId: number;
  moduleWidth: number;
  moduleHeight: number;
  top: number;
  definition: ModuleRenderProps["definition"];
  locked?: boolean;
}) {
  const layout = connectionJackLayout(
    definition.inputs,
    definition.outputs,
    moduleWidth,
    moduleHeight,
    { directionChrome: definition.connectionViewChrome !== "minimal" },
  );
  const showDirectionChrome = definition.connectionViewChrome !== "minimal";

  return (
    <div
      className={["connectionBay", locked ? "connectionBayLocked" : ""]
        .filter(Boolean)
        .join(" ")}
      style={{
        top,
      }}
    >
      {showDirectionChrome
        ? layout.sections.map((section) => (
            <span
              key={section.direction}
              aria-hidden="true"
              className={`connectionDirectionBox connectionDirectionBox-${section.direction}`}
              style={{
                top: section.top,
                left: section.left,
                width: section.width,
                height: section.height,
              }}
            >
              <span className="connectionDirectionBoxLabel">{section.label}</span>
            </span>
          ))
        : null}

      {layout.boxes.map((box) => (
        <span
          key={box.id}
          aria-hidden="true"
          className={`connectionJackBox connectionJackBox-${box.direction} jack-${box.kind}`}
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
          }}
        >
          {box.label}
        </span>
      ))}

      {layout.rows.map((row) => (
        <div
          key={`${row.direction}-${row.jack.id}`}
          className={[
            "connectionJackSlot",
            row.grouped ? "connectionJackSlotGrouped" : "",
            `connectionJack-${row.direction}`,
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            top: row.top,
            left: row.left,
            width: row.width,
            height: row.height,
          }}
        >
          <JackPort
            moduleId={moduleId}
            jack={row.jack}
            direction={row.direction}
            displayLabel={row.displayLabel}
            onStartCable={(endpoint, event) => {
              if (!locked) {
                onStartCable(endpoint, event);
              }
            }}
            onFinishCable={(endpoint, event) => {
              if (!locked) {
                onFinishCable(endpoint, event);
              }
            }}
            onOpenJackMenu={(endpoint, event) => {
              if (!locked) {
                onOpenJackMenu(endpoint, event);
              }
            }}
          />
        </div>
      ))}
    </div>
  );
}
