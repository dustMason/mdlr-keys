import type { RecordModel } from "pocketbase";
import { assertValidModulePresetPayload } from "../modulePresetDocument";
import type { ModuleDefinition, ModulePresetPayload } from "../modules/types";
import { pb } from "./pocketbase";

const MODULE_PRESET_COLLECTION = "module_presets";

export interface SavedModulePreset {
  id: string;
  userId: string;
  moduleKind: number;
  moduleSlug: string;
  name: string;
  payload: ModulePresetPayload;
  created?: string;
  updated?: string;
}

interface ModulePresetRecord extends RecordModel {
  user: string;
  moduleKind: number;
  moduleSlug: string;
  name: string;
  payload: ModulePresetPayload | string;
}

export async function fetchCurrentUserModulePresets(
  definitions: Map<number, ModuleDefinition>,
) {
  const records = await pb
    .collection<ModulePresetRecord>(MODULE_PRESET_COLLECTION)
    .getFullList({
      sort: "-updated",
    });

  const presets: SavedModulePreset[] = [];
  for (const record of records) {
    const preset = recordToSavedModulePreset(record, definitions);
    if (preset) {
      presets.push(preset);
    }
  }
  return presets;
}

export async function createCurrentUserModulePreset({
  name,
  definition,
  payload,
}: {
  name: string;
  definition: ModuleDefinition;
  payload: ModulePresetPayload;
}) {
  const userId = pb.authStore.record?.id;
  if (!userId) {
    throw new Error("No authenticated user is available for preset creation.");
  }

  assertValidModulePresetPayload(payload, definition);
  const record = await pb.collection<ModulePresetRecord>(MODULE_PRESET_COLLECTION).create({
    user: userId,
    moduleKind: definition.kind,
    moduleSlug: definition.slug,
    name,
    payload,
  });

  const preset = recordToSavedModulePreset(record, new Map([[definition.kind, definition]]));
  if (!preset) {
    throw new Error("Could not read saved module preset.");
  }
  return preset;
}

function recordToSavedModulePreset(
  record: ModulePresetRecord,
  definitions: Map<number, ModuleDefinition>,
): SavedModulePreset | null {
  const definition = definitions.get(Number(record.moduleKind));
  if (!definition) {
    return null;
  }

  const payload =
    typeof record.payload === "string"
      ? (JSON.parse(record.payload) as ModulePresetPayload)
      : record.payload;
  assertValidModulePresetPayload(payload, definition);

  return {
    id: record.id,
    userId: record.user,
    moduleKind: Number(record.moduleKind),
    moduleSlug: record.moduleSlug,
    name: record.name,
    payload,
    created: record.created,
    updated: record.updated,
  } satisfies SavedModulePreset;
}
