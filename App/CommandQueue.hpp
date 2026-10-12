#pragma once
#include <array>
#include <atomic>
#include <mutex>
#include <cstdint>
struct Command { uint32_t kind=0, a=0, b=0; float value=0; };
// Multiple control producers; one audio consumer. The audio thread never locks.
class CommandQueue {
    static constexpr uint32_t size=2048;
    std::array<Command,size> slots{};
    std::atomic<uint32_t> read{0},write{0};
    std::mutex producers;
public:
    std::atomic<bool> overflow{false};
    std::atomic<uint32_t> dropped{0};
    bool push(Command c) {
        std::lock_guard<std::mutex> lock(producers);
        auto w=write.load(std::memory_order_relaxed);
        auto next=(w+1)%size;
        if(next==read.load(std::memory_order_acquire)){overflow.store(true);dropped.fetch_add(1);return false;}
        slots[w]=c;write.store(next,std::memory_order_release);return true;
    }
    bool pop(Command &c) {
        auto r=read.load(std::memory_order_relaxed);
        if(r==write.load(std::memory_order_acquire))return false;
        c=slots[r];read.store((r+1)%size,std::memory_order_release);return true;
    }
};
