// Synthetic ABI fixture. No firmware, private files, native emulator or audio device.
#define MDLR_JP8000_RUST_ONLY 1
#include "JP8000Backend.hpp"
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <new>
static bool countAllocations=false;
static size_t allocations=0;
void* operator new(size_t n){if(countAllocations)++allocations;if(auto p=std::malloc(n))return p;throw std::bad_alloc();}
void operator delete(void* p)noexcept{std::free(p);}
struct Mock {uint64_t frame=0;bool gate=false;uint8_t lastVelocity=0;int32_t params[4096]{},lower[4096]{};uint64_t on=~0ull,off=~0ull;};
static Mock* latest=nullptr;
extern "C" {
void* mdlr_jp8000_rust_create(){auto p=new Mock;latest=p;p->params[30]=5;p->params[51]=127;std::copy_n(p->params,4096,p->lower);p->lower[1002]=1;return p;}
void mdlr_jp8000_rust_destroy(void* p){delete static_cast<Mock*>(p);}
int32_t mdlr_jp8000_rust_parameter_capability(uint16_t id){return id==30||id==31||id==51||id==1002||id==2018?1:0;}
int32_t mdlr_jp8000_rust_parameter_value_capability(uint16_t id,uint16_t){return mdlr_jp8000_rust_parameter_capability(id);}
int32_t mdlr_jp8000_rust_supported_waveform(uint16_t value){return value==0||value==5;}
int32_t mdlr_jp8000_rust_set_parameter(void* p,uint16_t id,uint16_t value){if(!mdlr_jp8000_rust_parameter_capability(id)||value==13)return -1;static_cast<Mock*>(p)->params[id]=value;return 0;}
int32_t mdlr_jp8000_rust_apply_patch(void* p,const uint16_t* ids,const uint16_t* values,uint32_t count){
    for(uint32_t i=0;i<count;++i)if(!mdlr_jp8000_rust_parameter_capability(ids[i])||values[i]==13)return -1;
    for(uint32_t i=0;i<count;++i)static_cast<Mock*>(p)->params[ids[i]]=values[i];return 0;
}
int32_t mdlr_jp8000_rust_get_parameter(void* p,uint16_t id){return mdlr_jp8000_rust_parameter_capability(id)?static_cast<Mock*>(p)->params[id]:-1;}
int32_t mdlr_jp8000_rust_set_part_parameter(void* p,uint8_t part,uint16_t id,uint16_t value){
    if(part>1||id>=2000||!mdlr_jp8000_rust_parameter_capability(id)||value==13)return -1;
    auto& v=*static_cast<Mock*>(p);(part?v.lower:v.params)[id]=value;return 0;
}
int32_t mdlr_jp8000_rust_get_part_parameter(const void* p,uint8_t part,uint16_t id){
    if(part>1||id>=2000||!mdlr_jp8000_rust_parameter_capability(id))return -1;
    const auto& v=*static_cast<const Mock*>(p);return (part?v.lower:v.params)[id];
}
int32_t mdlr_jp8000_rust_apply_performance(void* p,const uint16_t* ui,const uint16_t* uv,uint32_t un,
    const uint16_t* li,const uint16_t* lv,uint32_t ln,const uint16_t* ci,const uint16_t* cv,uint32_t cn){
    const uint16_t* ids[]={ui,li,ci};const uint16_t* vs[]={uv,lv,cv};const uint32_t ns[]={un,ln,cn};
    for(unsigned s=0;s<3;++s)for(uint32_t i=0;i<ns[s];++i)
        if(!mdlr_jp8000_rust_parameter_capability(ids[s][i])||vs[s][i]==13)return -1;
    auto& v=*static_cast<Mock*>(p);
    for(unsigned s=0;s<3;++s)for(uint32_t i=0;i<ns[s];++i)(s==1?v.lower:v.params)[ids[s][i]]=vs[s][i];
    return 0;
}
void mdlr_jp8000_rust_silence(void* p){auto& v=*static_cast<Mock*>(p);v.gate=false;v.frame=0;}
int32_t mdlr_jp8000_rust_midi(void* p,uint8_t status,uint8_t,uint8_t velocity){auto& v=*static_cast<Mock*>(p);v.lastVelocity=velocity;v.gate=(status&0xf0)==0x90&&velocity;if(v.gate)v.on=v.frame;else v.off=v.frame;return 0;}
int32_t mdlr_jp8000_rust_remote_touch(void* p,uint8_t s,uint8_t a,uint8_t b){return mdlr_jp8000_rust_midi(p,s,a,b);}
int32_t mdlr_jp8000_rust_render(void* p,float* l,float* r,uint32_t frames){auto& v=*static_cast<Mock*>(p);for(uint32_t i=0;i<frames;++i){l[i]=r[i]=v.gate?.5f:0;++v.frame;}return 0;}
}
static std::array<float,1024> run(unsigned block){
    auto host=JP8000Backend::createRust();host->setActive(true);assert(host->parameter(31,64));
    assert(host->midi(0x90,60,100,17));assert(host->midi(0x80,60,0,111));
    std::array<float,1024> l{},r{};countAllocations=true;
    for(unsigned at=0;at<l.size();){auto n=std::min<unsigned>(block,l.size()-at);host->render48k(l.data()+at,r.data()+at,n);at+=n;}
    countAllocations=false;assert(allocations==0);assert(l==r);assert(latest->on==32&&latest->off==204);
    for(unsigned i=0;i<17;++i)assert(l[i]==0);assert(l[80]>.3f);
    assert(!host->parameter(61,7));assert(!host->parameter(30,1));assert(!host->factoryPatch(1));
    const auto snapshot=host->snapshotJSON();assert(snapshot.find("rust-experimental")!=std::string::npos);assert(snapshot.find("\"ring_frames\":0")!=std::string::npos);
    assert(host->parameter(31,13));host->render48k(l.data(),r.data(),16);assert(latest->params[31]==64);
    assert(host->snapshotJSON().find("\"31\":64")!=std::string::npos);
    const uint16_t ids[]={30,31},bad[]={0,13},good[]={0,65};
    assert(host->applyPatch(ids,bad,2));host->render48k(l.data(),r.data(),16);
    assert(latest->params[30]==5&&latest->params[31]==64);
    assert(host->applyPatch(ids,good,2));host->render48k(l.data(),r.data(),16);
    assert(latest->params[30]==0&&latest->params[31]==65);
    host->setActive(false);assert(host->parameter(31,66));host->setActive(true);
    host->render48k(l.data(),r.data(),16);assert(latest->params[31]==66);
    host->panic();host->render48k(l.data(),r.data(),16);for(unsigned i=0;i<16;++i)assert(l[i]==0);
    return l;
}
int main(){
    const auto baseline=run(1);for(unsigned block:{7,64,128,257,1024})assert(run(block)==baseline);
    auto host=JP8000Backend::createRust();host->setActive(true);
    for(unsigned i=0;i<3000;++i)host->midi(0x90,60,100);
    std::array<float,128> l{},r{};
    for(unsigned n=0;n<12;++n){host->render48k(l.data(),r.data(),128);for(float x:l)assert(x==0);}
    assert(host->droppedEvents()>0);assert(host->midi(0x90,60,100));host->render48k(l.data(),r.data(),128);assert(l[100]>.3f);
    auto timed=JP8000Backend::createRust();timed->setActive(true);
    mach_timebase_info_data_t tb{};mach_timebase_info(&tb);const uint64_t base=1000000000,millisecond=1000000ull*tb.denom/tb.numer;
    assert(timed->midiAtHostTime(0x90,60,100,base+millisecond));
    assert(timed->midiAtHostTime(0x80,60,0,base+2*millisecond));
    countAllocations=true;timed->render48k(l.data(),r.data(),128,base);countAllocations=false;
    assert(latest->on==89&&latest->off==177&&allocations==0);
    auto velocityHost=JP8000Backend::createRust();velocityHost->setActive(true);
    velocityHost->setVelocitySensitive(false);
    assert(velocityHost->midi(0x90,60,42));velocityHost->render48k(l.data(),r.data(),128);
    assert(latest->gate&&latest->lastVelocity==127);
    assert(velocityHost->midi(0x90,60,0));velocityHost->render48k(l.data(),r.data(),128);
    assert(!latest->gate&&latest->lastVelocity==0);
    velocityHost->setVelocitySensitive(true);
    assert(velocityHost->midi(0x90,60,42));velocityHost->render48k(l.data(),r.data(),128);
    assert(latest->gate&&latest->lastVelocity==42);
    std::cout<<"{\"passed\":true,\"firmware_linked\":false,\"allocation_count_in_render\":0,\"partition_sizes\":[1,7,64,128,257,1024],\"event_native_frames\":[32,204],\"overflow_clears_notes\":true,\"atomic_patch_rejection\":true,\"activation_preserves_controls\":true,\"timestamp_native_frames\":[89,177],\"disabled_velocity_matches_firmware\":true}\n";
}
