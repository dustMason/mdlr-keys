#ifndef MDLR_JP8000_H
#define MDLR_JP8000_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct jp8000 jp8000_t;
typedef enum jp8000_scope { JP8000_PATCH_UPPER=0, JP8000_PATCH_LOWER=1, JP8000_PART_UPPER=2, JP8000_PART_LOWER=3, JP8000_PERFORMANCE=4, JP8000_SYSTEM=5 } jp8000_scope;
typedef struct jp8000_stats_t { uint64_t aot_hits, aot_fallbacks, frame_position; int ready, state_syncing; } jp8000_stats_t;
/* Single owner: all calls on the producer thread, never concurrently or on the audio callback.
 * Creation boots real firmware off-thread. ROM must be 512 KiB; baseline RAM 256 KiB.
 * int operations return 0 on success, -1 on failure; last_error explains failures. */
jp8000_t* jp8000_create(const char* rom_path,const char* baseline_ram_path,char* error,size_t error_capacity);
void jp8000_destroy(jp8000_t*);
uint32_t jp8000_native_sample_rate(void);
int jp8000_ready(jp8000_t*);
int jp8000_stats(jp8000_t*,jp8000_stats_t*);
int jp8000_render(jp8000_t*,float* left,float* right,uint32_t frames);
// Channel voice plus F1/F2/F3/F6/F8/FA/FB/FC/FE. Unused data bytes are ignored;
// partial SysEx and undefined statuses are rejected. No device I/O occurs.
int jp8000_midi(jp8000_t*,uint8_t status,uint8_t data1,uint8_t data2,uint32_t offset);
/* wire_offset uses Roland base128 address bytes (0x0100 follows 0x007f).
 * width is 1 or 2 big-endian 7-bit data bytes. Supported parameter metadata is validated. */
int jp8000_parameter(jp8000_t*,jp8000_scope scope,uint32_t wire_offset,uint32_t value,uint32_t width);
int jp8000_factory_patch(jp8000_t*,uint32_t index,uint32_t part);
int jp8000_factory_performance(jp8000_t*,uint32_t index);
int jp8000_panel(jp8000_t*,uint32_t button,int down);
int jp8000_panic(jp8000_t*);
/* Snapshot returns required capacity INCLUDING terminating NUL; no partial copy.
 * Includes params_upper/params_lower using canonical IDs; midi_channels is upper/lower. */
size_t jp8000_snapshot_json(jp8000_t*,char* output,size_t capacity);
/* Save returns required byte length; fails with0 while readback is incomplete/pending.
 * Restore accepts a complete validated Roland SysEx system+performance+both-part state. */
size_t jp8000_save_state(jp8000_t*,uint8_t* output,size_t capacity);
int jp8000_load_state(jp8000_t*,const uint8_t* bytes,size_t length);
const char* jp8000_last_error(jp8000_t*);
#ifdef __cplusplus
}
#endif
#endif
