import { describe, expect, it } from "vitest";
import type { ChoirTextState } from "../modules/types";

describe("ModularAudioEngine", () => {
  it("posts choir text changes directly to the worklet", async () => {
    globalThis.window ??= {
      location: { origin: "http://127.0.0.1:5173" },
    } as Window & typeof globalThis;
    const { ModularAudioEngine } = await import("./ModularAudioEngine");
    const engine = new ModularAudioEngine();
    const messages: unknown[] = [];
    (
      engine as unknown as {
        node: { port: { postMessage: (message: unknown) => void } };
      }
    ).node = {
      port: {
        postMessage: (message: unknown) => messages.push(message),
      },
    };

    const text: ChoirTextState = {
      version: 1,
      kind: "choir",
      phrases: ["be"],
    };
    engine.setModuleText(6, text);
    engine.setModuleText(6, text);

    expect(messages).toEqual([
      {
        type: "setModuleText",
        moduleId: 6,
        text: {
          kind: "choir",
          phrases: ["be"],
        },
      },
      {
        type: "setModuleText",
        moduleId: 6,
        text: {
          kind: "choir",
          phrases: ["be"],
        },
      },
    ]);
  });
});
