import type { PatchCable, RackModuleState } from "./modules/types";

export interface SavedSession {
  id: string;
  slug: string;
  name: string;
  description: string;
  tempoBpm: number;
  documentHash?: string;
  ownerId?: string;
  readOnly?: boolean;
  systemModules?: RackModuleState[];
  modules: RackModuleState[];
  cables: PatchCable[];
}
