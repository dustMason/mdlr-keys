import { useEffect, useState } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps } from "../types";
import "./AudioInputModule.css";

type AudioInputStatus =
  | "idle"
  | "loading"
  | "active"
  | "unsupported"
  | "denied"
  | "error";

const CHANNELS = 4;

export const audioInputDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.audioInput,
  slug: "in",
  name: "IN",
  accent: "#111111",
  rackWidth: "half",
  rackUnits: 1,
  width: 304,
  minHeight: 206,
  inputs: [],
  outputs: Array.from({ length: CHANNELS }, (_, index) => ({
    id: index,
    label: `${index + 1}`,
    kind: "audio" as const,
    connectionOrder: index,
    connectionGroup: `input-${index + 1}`,
    connectionGroupLabel: `ch ${index + 1}`,
    connectionGroupOrder: index,
  })),
  params: [],
  Component: AudioInputModule,
};

function AudioInputModule(props: ModuleRenderProps) {
  const { audioEngine, locked = false, lockedReason } = props;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [status, setStatus] = useState<AudioInputStatus>(() =>
    audioEngine.isAudioInputActive() ? "active" : "idle",
  );
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (locked) {
      setDevices([]);
      setSelectedDeviceId("");
      setStatus("idle");
      setMessage("remote owner only");
      return;
    }

    let isMounted = true;

    async function refreshDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) {
        if (isMounted) {
          setStatus("unsupported");
          setMessage("audio input unavailable");
        }
        return;
      }
      const nextDevices = await audioEngine.listAudioInputDevices();
      if (!isMounted) {
        return;
      }
      setDevices(nextDevices);
      setSelectedDeviceId((current) =>
        current && nextDevices.some((device) => device.deviceId === current)
          ? current
          : audioEngine.getAudioInputDeviceId(),
      );
    }

    refreshDevices().catch(() => {
      if (isMounted) {
        setStatus("error");
        setMessage("could not list devices");
      }
    });
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => {
      isMounted = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [audioEngine, locked]);

  async function toggleInput() {
    if (locked) {
      return;
    }
    if (status === "active") {
      audioEngine.disableAudioInput();
      setStatus("idle");
      setMessage("off");
      return;
    }

    setStatus("loading");
    setMessage("requesting input");
    try {
      await audioEngine.enableAudioInput(selectedDeviceId);
      const nextDevices = await audioEngine.listAudioInputDevices();
      setDevices(nextDevices);
      setSelectedDeviceId(audioEngine.getAudioInputDeviceId());
      setStatus("active");
      setMessage("live");
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : "";
      setStatus(errorName === "NotAllowedError" ? "denied" : "error");
      setMessage(error instanceof Error ? error.message : "input failed");
    }
  }

  return (
    <ModuleShell {...props}>
      <div
        className={[
          "audioInputPanel",
          locked ? "audioInputPanelLocked" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="audioInputControls">
          {locked ? (
            <div className="audioInputRemoteNotice">
              <span>disabled here</span>
              <strong>{lockedReason ?? "owned by another user"}</strong>
            </div>
          ) : (
            <label className="audioInputDevice">
              <span>device</span>
              <select
                value={selectedDeviceId}
                onChange={(event) => setSelectedDeviceId(event.target.value)}
                disabled={status === "active" || status === "loading"}
              >
                <option value="">default input</option>
                {devices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `input ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className={status === "active" ? "isActive" : ""}
            type="button"
            onClick={toggleInput}
            disabled={locked || status === "loading" || status === "unsupported"}
          >
            {status === "active" ? "off" : "on"}
          </button>
        </div>
        <div className="audioInputChannels" aria-label="audio input channels">
          {Array.from({ length: CHANNELS }, (_, index) => (
            <div key={index}>
              <strong>{index + 1}</strong>
              <span>out</span>
            </div>
          ))}
        </div>
        <p className={`audioInputStatus audioInputStatus-${status}`}>
          {locked
            ? "live input stays local; loops recorded from it will sync"
            : statusText(status, message)}
        </p>
      </div>
    </ModuleShell>
  );
}

function statusText(status: AudioInputStatus, message: string) {
  if (message) {
    return message;
  }
  if (status === "active") {
    return "live";
  }
  if (status === "unsupported") {
    return "audio input unavailable";
  }
  if (status === "denied") {
    return "permission denied";
  }
  return "ready";
}
