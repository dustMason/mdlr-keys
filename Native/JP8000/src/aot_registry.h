#pragma once
#include "aot_key.h"
#include "custom_chips/esp/esp_jit.h"
namespace jp_aot_probe { esp::KernelFn lookup(const Key&); }
