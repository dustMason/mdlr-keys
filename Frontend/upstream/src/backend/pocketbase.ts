import PocketBase from "pocketbase";

const pocketBaseUrl = import.meta.env.VITE_POCKETBASE_URL || window.location.origin;

export const pb = new PocketBase(pocketBaseUrl);
pb.autoCancellation(false);
