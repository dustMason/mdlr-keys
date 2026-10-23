// Headless real-core integration: link only libmdlr_ipad_dsp.a, never JP firmware.
#define MDLR_JP8000_RUST_ONLY 1
#include "JP8000Backend.hpp"
#include <cassert>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <new>
static thread_local bool countAllocations=false;
static size_t allocations=0;
void* operator new(size_t n){if(countAllocations)++allocations;if(auto p=std::malloc(n))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept{std::free(p);}
static auto makeHost(bool supersaw=false){
    auto host=JP8000Backend::createRust();
    const uint16_t ids[]={30,31,32,41,42,54,55,56,57};
    const uint16_t values[]={uint16_t(supersaw?0:5),uint16_t(supersaw?127:0),uint16_t(supersaw?127:0),127,0,0,0,127,32};
    assert(host->applyPatch(ids,values,9));host->setActive(true);
    return host;
}
static std::vector<float> render(unsigned block){
    auto host=makeHost();const uint8_t notes[]={48,52,55,59,60,64,67,71};
    for(auto note:notes){assert(host->midi(0x90,note,100,17));assert(host->midi(0x80,note,0,24000));}
    std::vector<float> l(48000),r(48000);countAllocations=true;
    for(unsigned at=0;at<l.size();){const auto n=std::min<unsigned>(block,l.size()-at);host->render48k(l.data()+at,r.data()+at,n);at+=n;}
    countAllocations=false;assert(allocations==0&&l==r);float peak=0;for(auto x:l){assert(std::isfinite(x));peak=std::max(peak,std::abs(x));}assert(peak>1e-4f);
    for(unsigned i=0;i<17;++i)assert(l[i]==0);
    return l;
}
static void rejection(){
    auto host=makeHost();std::array<float,128> l{},r{};host->render48k(l.data(),r.data(),128);
    const uint16_t ids[]={41,30},bad[]={80,9};assert(host->applyPatch(ids,bad,2));
    host->render48k(l.data(),r.data(),128);auto snapshot=host->snapshotJSON();
    assert(snapshot.find("\"41\":127")!=std::string::npos&&snapshot.find("\"30\":5")!=std::string::npos);
    assert(!host->parameter(30,9));
    const uint16_t waveMix[]={32,30},super[]={64,0},saw[]={0,5};
    assert(host->applyPatch(waveMix,super,2));host->render48k(l.data(),r.data(),128);
    assert(host->snapshotJSON().find("\"32\":64")!=std::string::npos);
    assert(host->applyPatch(waveMix,saw,2));host->render48k(l.data(),r.data(),128);
    assert(host->snapshotJSON().find("\"32\":0")!=std::string::npos);
    host->setActive(false);assert(host->parameter(41,80));host->setActive(true);
    host->render48k(l.data(),r.data(),128);assert(host->snapshotJSON().find("\"41\":80")!=std::string::npos);
}
static void benchmark(){
    using Clock=std::chrono::steady_clock;
    struct Patch{const char* name;uint16_t wave;std::vector<std::pair<uint16_t,uint16_t>> extra;};
    const Patch cases[]={
        {"supersaw",0,{}},{"triangle-modulation",1,{}},{"noise",2,{}},{"feedback",3,{}},
        {"square",4,{}},{"saw",5,{}},{"triangle",6,{}},
        {"feedback-osc2-ring-fm",3,{{21,1},{22,127},{23,64},{33,0},{35,50},{36,100},{37,127},{38,127},{41,80},{42,127}}},
        {"square-osc2-shape-lfo",4,{{16,2},{17,127},{21,1},{22,127},{23,64},{33,0},{35,50},{36,100},{37,127},{38,127},{41,80},{42,127}}},
        {"saw-osc2-sync",5,{{23,64},{33,0},{34,1},{35,50},{36,100},{37,127},{38,127},{41,80},{42,127}}},
        {"supersaw-lfo-fade",0,{{18,116},{25,96},{44,80},{52,80},{57,96}}}
    };
    std::cout<<"\"callback_benchmark\":[";bool first=true;
    for(const auto& patch:cases){
        std::vector<uint16_t> ids={30,31,32},values={patch.wave,127,uint16_t(patch.wave==5?0:127)};
        for(const auto& [id,value]:patch.extra){ids.push_back(id);values.push_back(value);}
        bool supported=mdlr_jp8000_rust_supported_waveform(patch.wave)>0;
        for(auto id:ids)supported=supported&&mdlr_jp8000_rust_parameter_capability(id)==1;
        if(!supported){if(!first)std::cout<<',';first=false;std::cout<<"{\"case\":\""<<patch.name<<"\",\"skipped\":true,\"reason\":\"Required capability is not advertised\"}";continue;}
        for(unsigned block:{64u,128u,256u}){
            auto host=makeHost();assert(host->applyPatch(ids.data(),values.data(),uint32_t(ids.size())));
            for(uint8_t note:{48,52,55,59,60,64,67,71})assert(host->midi(0x90,note,100));
            std::array<float,256> l{},r{};for(unsigned i=0;i<100;++i)host->render48k(l.data(),r.data(),block);
            assert(host->snapshotJSON().find("\"rejected_commands\":0")!=std::string::npos);
            std::array<double,3000> times{};countAllocations=true;
            for(auto& us:times){const auto begin=Clock::now();host->render48k(l.data(),r.data(),block);us=std::chrono::duration<double,std::micro>(Clock::now()-begin).count();}
            countAllocations=false;assert(allocations==0);for(unsigned i=0;i<block;++i)assert(std::isfinite(l[i])&&std::isfinite(r[i]));
            const double budget=block*1e6/48000.0;const auto missed=std::count_if(times.begin(),times.end(),[budget](double value){return value>budget;});
            std::sort(times.begin(),times.end());if(!first)std::cout<<',';first=false;
            std::cout<<"{\"case\":\""<<patch.name<<"\",\"wave\":"<<patch.wave<<",\"physical_slots\":8,\"midi_held_keys\":8,\"voices\":"<<(patch.wave==3?1:8)<<",\"frames\":"<<block<<",\"p50_us\":"<<times[1500]<<",\"p99_us\":"<<times[2970]<<",\"max_us\":"<<times.back()<<",\"budget_us\":"<<budget<<",\"missed_deadlines\":"<<missed<<'}';
        }
    }
    std::cout<<"],\"cpp_callback_allocations\":"<<allocations<<",\"host_sample_rate\":48000,\"native_sample_rate\":88200,\"callbacks_per_case\":3000,\"resampler_included\":true";
}

int main(int argc,char** argv){
    if(argc==2&&std::string(argv[1])=="--benchmark"){std::cout<<'{';benchmark();std::cout<<"}\n";return 0;}
    rejection();const auto baseline=render(1);for(unsigned block:{7,64,128,257,1024})assert(render(block)==baseline);
    std::cout<<"{\"passed\":true,\"firmware_linked\":false,\"firmware_inputs\":[],\"cpp_callback_allocations\":"<<allocations<<",\"partition_sizes\":[1,7,64,128,257,1024],\"atomic_patch_rejection\":true,\"activation_preserves_controls\":true}\n";
}
