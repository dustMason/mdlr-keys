#pragma once
#include "JP8000Host.hpp"
#ifndef MDLR_JP8000_RUST_ONLY
#define MDLR_JP8000_RUST_ONLY 0
#endif
#if MDLR_JP8000_RUST_ONLY
#undef MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
#define MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST 1
#endif
#ifndef MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
#define MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST 0
#endif
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
#include "JP8000RustHost.hpp"
#endif

// Explicit selection only. The tested firmware host remains the default.
class JP8000Backend {
#if !MDLR_JP8000_RUST_ONLY
    std::shared_ptr<JP8000Host> firmware_;
#endif
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
    std::unique_ptr<JP8000RustHost> rust_;
#endif
public:
    static constexpr bool rustOnly(){return MDLR_JP8000_RUST_ONLY!=0;}
    static constexpr bool experimentalAvailable(){return MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST!=0;}
    static std::shared_ptr<JP8000Backend> createFirmware(std::string rom,std::string ram,std::string directory){
#if MDLR_JP8000_RUST_ONLY
        (void)rom;(void)ram;(void)directory;
        throw std::runtime_error("Firmware backend is absent from this Rust-only build");
#else
        auto host=std::make_shared<JP8000Backend>();host->firmware_=JP8000Host::create(std::move(rom),std::move(ram),std::move(directory));return host;
#endif
    }
    static std::shared_ptr<JP8000Backend> createRust(){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        auto host=std::make_shared<JP8000Backend>();host->rust_=std::make_unique<JP8000RustHost>();return host;
#else
        throw std::runtime_error("Experimental Rust JP-8000 is not enabled in this build");
#endif
    }
    void setActive(bool active){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->setActive(active);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->setActive(active);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    void render48k(float* l,float* r,uint32_t frames,uint64_t hostTime=0){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->render48k(l,r,frames,hostTime);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->render48k(l,r,frames);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    bool midi(uint8_t s,uint8_t a,uint8_t b,uint32_t offset=0){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->midi(s,a,b,offset);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->midi(s,a,b,offset);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    // Semantic touch input is available only on the experimental Rust route.
    // Firmware and ordinary engines retain their existing Swift MIDI channels.
    bool touchMidi(uint8_t s,uint8_t a,uint8_t b){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->touchMidi(s,a,b);
#endif
        (void)s;(void)a;(void)b;return false;
    }
    bool midiAtHostTime(uint8_t s,uint8_t a,uint8_t b,uint64_t time){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->midiAtHostTime(s,a,b,time);
#endif
        return midi(s,a,b);
    }
    bool parameter(uint32_t id,uint32_t value){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->parameter(id,value);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->parameter(id,value);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    bool applyPatch(const uint16_t* ids,const uint16_t* values,uint32_t count){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->applyPatch(ids,values,count);
#endif
        (void)ids;(void)values;(void)count;
        return false; // Firmware patch loading retains its existing SysEx path.
    }
    bool partParameter(uint32_t part,uint32_t id,uint32_t value){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->partParameter(part,id,value);
#endif
        (void)part;(void)id;(void)value;return false;
    }
    bool applyPerformance(const uint16_t* ui,const uint16_t* uv,uint32_t un,
                          const uint16_t* li,const uint16_t* lv,uint32_t ln,
                          const uint16_t* ci,const uint16_t* cv,uint32_t cn){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->applyPerformance(ui,uv,un,li,lv,ln,ci,cv,cn);
#endif
        (void)ui;(void)uv;(void)un;(void)li;(void)lv;(void)ln;(void)ci;(void)cv;(void)cn;return false;
    }
    void setPart(uint32_t part){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->setPart(part);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->setPart(part);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    bool factoryPatch(uint32_t index){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->factoryPatch(index);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->factoryPatch(index);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    bool factoryPerformance(uint32_t index){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->factoryPerformance(index);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->factoryPerformance(index);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    bool panel(uint32_t id,bool down){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->panel(id,down);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->panel(id,down);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    void panic(){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->panic();
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->panic();
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    void setMasterVolume(float value){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->setMasterVolume(value);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->setMasterVolume(value);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    void setMono(bool value){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->setMono(value);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->setMono(value);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    void setVelocitySensitive(bool value){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->setVelocitySensitive(value);
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->setVelocitySensitive(value);
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    bool ready(){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->ready();
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->ready();
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    float peak(){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->peak();
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->peak();
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    uint32_t droppedEvents(){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->droppedEvents();
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->droppedEvents();
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    uint64_t underflows(){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->underflows();
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->underflows();
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    uint32_t queuedFrames(){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->queuedFrames();
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->queuedFrames();
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    std::string snapshotJSON(){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->snapshotJSON();
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->snapshotJSON();
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    void saveState(std::string path){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->saveState(std::move(path));
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->saveState(std::move(path));
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
    void loadState(std::string path){
#if MDLR_ENABLE_EXPERIMENTAL_JP8000_RUST
        if(rust_)return rust_->loadState(std::move(path));
#endif
#if !MDLR_JP8000_RUST_ONLY
        return firmware_->loadState(std::move(path));
#else
        throw std::logic_error("Rust-only backend was not initialized");
#endif
    }
};
