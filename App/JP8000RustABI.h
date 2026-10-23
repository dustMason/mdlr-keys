#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Create/destroy off the audio thread. All handle operations have one owner.
// Render is allocation-free, fixed88.2kHz, planar stereo, at most16384 frames.
void *mdlr_jp8000_rust_create(void);
void mdlr_jp8000_rust_destroy(void *engine);
int32_t mdlr_jp8000_rust_set_parameter(void *engine,uint16_t id,uint16_t value);
// Atomic final-state validation; at most256 unique parameter IDs. No partial apply.
int32_t mdlr_jp8000_rust_apply_patch(void *engine,const uint16_t *ids,const uint16_t *values,uint32_t count);
int32_t mdlr_jp8000_rust_get_parameter(void *engine,uint16_t id);
// Patch/part IDs use part0 Upper or1 Lower. Common IDs use the legacy setter.
int32_t mdlr_jp8000_rust_set_part_parameter(void *engine,uint8_t part,uint16_t id,uint16_t value);
int32_t mdlr_jp8000_rust_get_part_parameter(const void *engine,uint8_t part,uint16_t id);
// Atomic final-state transaction: at most256 unique IDs in each scope.
// Part scopes contain patch/part IDs; common contains performance/system IDs.
int32_t mdlr_jp8000_rust_apply_performance(void *engine,
 const uint16_t *upper_ids,const uint16_t *upper_values,uint32_t upper_count,
 const uint16_t *lower_ids,const uint16_t *lower_values,uint32_t lower_count,
 const uint16_t *common_ids,const uint16_t *common_values,uint32_t common_count);
int32_t mdlr_jp8000_rust_midi(void *engine,uint8_t status,uint8_t data1,uint8_t data2);
// Semantic on-screen Remote input: status 0x80/0x90 or 0xb0 with controller64.
// Bypasses external MIDI channel filtering only. Shares Remote key/pedal state.
int32_t mdlr_jp8000_rust_remote_touch(void *engine,uint8_t status,uint8_t data1,uint8_t data2);
int32_t mdlr_jp8000_rust_render(void *engine,float *left,float *right,uint32_t frames);
void mdlr_jp8000_rust_silence(void *engine);
// These immutable metadata queries are safe on any thread.
int32_t mdlr_jp8000_rust_parameter_capability(uint16_t id);
// Enum feature coverage:1 active,2 dormant storage only,0 unavailable.
// This does not replace parameter bounds or atomic final-state validation.
int32_t mdlr_jp8000_rust_parameter_value_capability(uint16_t id,uint16_t value);
int32_t mdlr_jp8000_rust_supported_waveform(uint16_t waveform);
#ifdef __cplusplus
}
#endif
