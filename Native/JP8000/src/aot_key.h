#pragma once

// Research helper for gearmulator b8e1a28d4efaa3764d875eb3118d881dba672a70.
// Exact content identity, independent of per-instance mutation generations.
// An integration must ALSO pin the emitter revision and verify its ABI layout.
#include "custom_chips/esp/esp_program.h"
#include <array>
#include <cstdint>

namespace jp_aot_probe {
struct Key {
    uint32_t schema = 1;
    uint32_t eramBits = 0;
    uint32_t clocks = 0;
    uint32_t memoryMode = 0;
    uint32_t compress = 0;
    uint32_t staticBus = 0;
    uint32_t conditionalBranches = 0;
    uint32_t spacing = 0;
    std::array<uint32_t, 2 * esp::PRAM_WORDS> structure{};
    bool operator==(const Key&) const = default;
};

inline Key keyOf(const esp::ProgramSnapshot& p, unsigned eramBits, unsigned clocks) {
    Key key;
    key.eramBits = eramBits;
    key.clocks = clocks;
    key.memoryMode = p.memoryMode;
    key.compress = p.compress;
    key.staticBus = p.staticBus;
    key.conditionalBranches = p.conditionalBranches;
    key.spacing = p.spacing;
    for (unsigned core = 0; core != 2; ++core) {
        for (unsigned pc = 0; pc != esp::PRAM_WORDS; ++pc) {
            const auto word = p.words[core][pc];
            key.structure[core * esp::PRAM_WORDS + pc] = esp::structureOf(word) |
                (core == 1 && pc < esp::PRAM_SIZE ? word & 0x0c000000u : 0);
        }
    }
    return key;
}
}
