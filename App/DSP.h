#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
void *mdlr_create(void);
void mdlr_destroy(void *synth);
void mdlr_command(void *synth, uint32_t kind, uint32_t a, uint32_t b, float value);
void mdlr_render(void *synth, float *left, float *right, uint32_t frames, float sample_rate);
#ifdef __cplusplus
}
#endif
