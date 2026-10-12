import type { ReactNode } from "react";
import { ModuleKnob } from "../components/Knob";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "./types";

export interface KnobSectionConfig {
  title: string;
  paramIds: number[];
  accessory?: ReactNode;
  className?: string;
  knobClassName?: string;
}

interface KnobSectionProps {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  sections: KnobSectionConfig[];
  className?: string;
  accent?: string;
}

export function KnobSections({
  module,
  definition,
  onParamChange,
  sections,
  className = "",
  accent,
}: KnobSectionProps) {
  return (
    <div className={["productionSections", className].filter(Boolean).join(" ")}>
      {sections.map((section) => (
        <ProductionSection
          key={section.title}
          title={section.title}
          className={section.className}
        >
          {section.accessory ? (
            <div className="productionSectionAccessory">{section.accessory}</div>
          ) : null}
          {section.paramIds.length > 0 ? (
            <KnobList
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramIds={section.paramIds}
              className={section.knobClassName}
              accent={accent}
            />
          ) : null}
        </ProductionSection>
      ))}
    </div>
  );
}

export function ProductionSection({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={["productionSection", className].filter(Boolean).join(" ")}>
      <h3 className="productionSectionTitle">{title}</h3>
      {children}
    </section>
  );
}

export function KnobList({
  module,
  definition,
  onParamChange,
  paramIds,
  className = "",
  accent,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramIds: number[];
  className?: string;
  accent?: string;
}) {
  return (
    <div className={["productionSectionKnobs", className].filter(Boolean).join(" ")}>
      {paramIds.map((paramId) => {
        const parameter = paramById(paramId, definition);
        return (
          <ModuleKnob
            key={parameter.id}
            definition={definition}
            param={parameter}
            accent={accent ?? definition.accent}
            value={valueForParam(module.params, parameter)}
            onChange={(value) => onParamChange(module.id, parameter.id, value)}
          />
        );
      })}
    </div>
  );
}

export function paramById(
  paramId: number,
  definition: ModuleDefinition,
): ParamDefinition {
  const found = definition.params.find((candidate) => candidate.id === paramId);
  if (!found) {
    throw new Error(`Missing ${definition.name} param ${paramId}`);
  }
  return found;
}

export function valueForParam(
  params: Record<number, number>,
  parameter: ParamDefinition,
) {
  return params[parameter.id] ?? parameter.defaultValue;
}
