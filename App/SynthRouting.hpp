#pragma once
#include "CommandQueue.hpp"

// Host-independent routing, shared by the audio bridge and its headless tests.
// Selection has one producer (the main thread); drain has one audio consumer.
class SynthRouting {
    std::atomic<uint64_t> selection_{0}; // generation:32, engine:32
    uint32_t renderGeneration_ = 0;
public:
    // The app keeps JP-8000 at slot 4. Rust's fifth engine is monologue.
    static bool isRustEngine(uint32_t engine) { return engine < 4 || engine == 5; }
    static uint32_t rustEngine(uint32_t engine) { return engine == 5 ? 4 : engine; }
    CommandQueue commands;
    uint32_t renderEngine = 0; // Audio-thread-owned.

    uint32_t selectedEngine() const {
        return uint32_t(selection_.load(std::memory_order_acquire));
    }
    bool selectEngine(uint32_t engine) {
        const uint32_t generation = uint32_t(selection_.load(std::memory_order_relaxed) >> 32) + 1;
        const bool queued = commands.push({1,engine,generation,0});
        // Publishing still succeeds when stopped audio has a saturated MIDI queue.
        selection_.store((uint64_t(generation) << 32) | engine,std::memory_order_release);
        return queued;
    }
    bool parameter(uint32_t engine,uint32_t id,float value) {
        return commands.push({2,id,engine,value});
    }

    template<class JPReceiver>
    void midi(uint8_t status,uint8_t a,uint8_t b,JPReceiver&& jp) {
        if(selectedEngine()==4) jp(status,a,b);
        else if(status<0xf0) commands.push({0,status,a,float(b)});
    }
    static bool supportedSystemStatus(uint8_t status) {
        switch(status) {
            case 0xf1: case 0xf2: case 0xf3: case 0xf6:
            case 0xf8: case 0xfa: case 0xfb: case 0xfc: case 0xfe: return true;
            default: return false;
        }
    }
    template<class JPReceiver>
    void umpWord(uint32_t word,JPReceiver&& jp) {
        const uint32_t type=word>>28;
        const uint8_t status=uint8_t((word>>16)&255);
        if(type==2 || (type==1 && supportedSystemStatus(status)))
            midi(status,uint8_t((word>>8)&127),uint8_t(word&127),jp);
    }

    template<class LegacyReceiver>
    void drain(LegacyReceiver&& legacy) {
        const auto select=[&](uint32_t engine,uint32_t generation) {
            if(generation<=renderGeneration_)return;
            renderGeneration_=generation;renderEngine=engine;
            if(isRustEngine(engine))legacy(Command{1,rustEngine(engine),0,0});
            else legacy(Command{4,0,0,0});
        };
        const bool overflow=commands.overflow.exchange(false);
        Command c;bool drained=false;
        for(uint32_t consumed=0;consumed<2048;++consumed) {
            if(!commands.pop(c)){drained=true;break;}
            if(c.kind==1)select(c.a,c.b);
            else if(c.kind==2) {
                // A dropped selector must never send the next patch to the old engine.
                if(isRustEngine(renderEngine) && c.b==renderEngine)legacy(Command{2,c.a,0,c.value});
            } else if((!overflow || c.kind!=0) && (isRustEngine(renderEngine) || c.kind!=0))legacy(c);
        }
        // After overflow, lost note-offs cannot leave the legacy synth sounding.
        if(overflow)legacy(Command{4,0,0,0});
        if(!drained)return; // Do not jump ahead of a switch still in the ordered queue.
        const uint64_t latest=selection_.load(std::memory_order_acquire);
        // A queued command can arrive before this mailbox is published. Its newer
        // generation prevents a stale mailbox from undoing that ordered switch.
        select(uint32_t(latest),uint32_t(latest>>32));
    }
};
