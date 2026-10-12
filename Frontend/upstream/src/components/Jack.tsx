import type { MouseEvent, PointerEvent } from "react";
import type { CableEndpoint, JackDefinition, JackDirection } from "../modules/types";

interface JackProps {
  moduleId: number;
  jack: JackDefinition;
  direction: JackDirection;
  displayLabel?: string;
  onStartCable: (endpoint: CableEndpoint, event: PointerEvent) => void;
  onFinishCable: (endpoint: CableEndpoint, event: PointerEvent) => void;
  onOpenJackMenu: (endpoint: CableEndpoint, event: MouseEvent) => void;
}

export function JackPort({
  moduleId,
  jack,
  direction,
  displayLabel,
  onStartCable,
  onFinishCable,
  onOpenJackMenu,
}: JackProps) {
  const endpoint: CableEndpoint = {
    moduleId,
    jackId: jack.id,
    direction,
    kind: jack.kind,
  };

  return (
    <button
      className={`jackPort jack-${jack.kind} jack-${direction}`}
      type="button"
      title={`${jack.label} ${jack.kind}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenJackMenu(endpoint, event);
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0 || event.ctrlKey) {
          return;
        }
        onStartCable(endpoint, event);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        if (event.button !== 0 || event.ctrlKey) {
          return;
        }
        onFinishCable(endpoint, event);
      }}
    >
      <span className="jackSocket" />
      <span className="jackText">{displayLabel ?? jack.label}</span>
    </button>
  );
}
