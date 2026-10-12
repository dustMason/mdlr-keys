import { RACK_MODULE_HEADER_HEIGHT } from "./rackLayout";

const COLLAPSED_PATCH_SLOT_SIDE_MARGIN = 42;
const COLLAPSED_PATCH_SLOT_MIN_WIDTH = 160;
const COLLAPSED_PATCH_SLOT_MAX_WIDTH = 520;
const COLLAPSED_PATCH_SLOT_WIDTH_RATIO = 0.52;
export const COLLAPSED_PATCH_SLOT_HEIGHT = 8;
export const COLLAPSED_PATCH_SLOT_BOTTOM = 5;
export const COLLAPSED_PATCH_SLOT_CENTER_Y =
  RACK_MODULE_HEADER_HEIGHT -
  COLLAPSED_PATCH_SLOT_BOTTOM -
  COLLAPSED_PATCH_SLOT_HEIGHT / 2;

export function collapsedPatchSlotMetrics(moduleFaceWidth: number) {
  const maxAvailable = Math.max(
    1,
    moduleFaceWidth - COLLAPSED_PATCH_SLOT_SIDE_MARGIN * 2,
  );
  const width = Math.min(
    maxAvailable,
    Math.max(
      Math.min(COLLAPSED_PATCH_SLOT_MIN_WIDTH, maxAvailable),
      Math.min(
        COLLAPSED_PATCH_SLOT_MAX_WIDTH,
        moduleFaceWidth * COLLAPSED_PATCH_SLOT_WIDTH_RATIO,
      ),
    ),
  );

  return {
    left: (moduleFaceWidth - width) / 2,
    width,
    centerY: COLLAPSED_PATCH_SLOT_CENTER_Y,
  };
}
