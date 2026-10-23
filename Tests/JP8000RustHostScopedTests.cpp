// Scoped host integration against the ordinary native Rust static archive.
// C++ operator-new instrumentation only; Rust allocation instrumentation is unavailable.
#define MDLR_JP8000_RUST_ONLY 1
#include "JP8000Backend.hpp"
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <new>
#include <thread>
static thread_local bool track=false;
static std::atomic<size_t> allocations{0};
void* operator new(size_t n){if(track)++allocations;if(auto p=std::malloc(n))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept{std::free(p);}
// Source-only white-box access for deterministic producer interleavings. No
// testing branch or pause hook is added to the production host implementation.
template<class T,typename T::type Member> struct Access{friend typename T::type access(T){return Member;}};
struct FlagTag{using type=std::atomic_flag JP8000RustHost::*;friend type access(FlagTag);};
struct SelectionTag{using type=std::atomic<uint64_t> JP8000RustHost::*;friend type access(SelectionTag);};
struct FailedTag{using type=std::atomic<uint64_t> JP8000RustHost::*;friend type access(FailedTag);};
struct GenerationTag{using type=std::atomic<uint64_t> JP8000RustHost::*;friend type access(GenerationTag);};
struct RollbackTag{using type=void(JP8000RustHost::*)(uint64_t,uint64_t) noexcept;friend type access(RollbackTag);};
template struct Access<FlagTag,&JP8000RustHost::selectionProducer_>;
template struct Access<SelectionTag,&JP8000RustHost::selection_>;
template struct Access<FailedTag,&JP8000RustHost::failedSelection_>;
template struct Access<GenerationTag,&JP8000RustHost::selectionGeneration_>;
template struct Access<RollbackTag,&JP8000RustHost::rollbackSelection>;
static unsigned cases=0;
static int field(const std::string& s,const char* scope,unsigned id){
    return std::stoi(jp8000_detail::jsonValue(jp8000_detail::jsonValue(s,scope,"{}"),std::to_string(id).c_str(),"-999"));
}
static int value(const std::string& s,const char* key){return std::stoi(jp8000_detail::jsonValue(s,key,"-999"));}
static void render(JP8000Backend& h,unsigned n=128){std::array<float,512> l{},r{};assert(n<=l.size());h.render48k(l.data(),r.data(),n);for(unsigned i=0;i<n;++i)assert(std::isfinite(l[i])&&std::isfinite(r[i]));}
static auto make(){auto h=JP8000Backend::createRust();h->setActive(true);return h;}
static void scopedQueue(){
    auto h=make();h->setPart(0);assert(h->parameter(41,31));h->setPart(1);assert(h->parameter(41,95));h->setPart(2);assert(h->parameter(42,64));render(*h);
    const auto s=h->snapshotJSON();assert(value(s,"part")==2);assert(field(s,"params_upper",41)==31);assert(field(s,"params_lower",41)==95);
    assert(field(s,"params_upper",42)==64&&field(s,"params_lower",42)==64);assert(field(s,"params",41)==31);
    h->setPart(1);render(*h);assert(field(h->snapshotJSON(),"params",41)==95);
    assert(h->partParameter(0,41,45));assert(h->partParameter(1,41,90));render(*h);
    const auto t=h->snapshotJSON();assert(field(t,"params_upper",41)==45&&field(t,"params_lower",41)==90);
    assert(!h->partParameter(3,41,90));assert(!h->partParameter(1,2018,0));
    assert(t.find("\"supported_edit_parts\":[0,1,2]")!=std::string::npos);++cases;
}
static void transaction(){
    auto h=make(),control=make();
    const uint16_t pi[]={30,41,54,55,56,57,1002},uv[]={5,127,0,0,127,32,0},lv[]={6,80,0,0,127,32,1},ci[]={2016,2018,3009},cv[]={1,1,17};
    for(auto x:{h,control}){assert(x->applyPerformance(pi,uv,7,pi,lv,7,ci,cv,3));assert(x->midi(0x91,60,100));render(*x);}
    const auto before=h->snapshotJSON();assert(field(before,"params_upper",30)==5&&field(before,"params_lower",30)==6);assert(value(before,"part")==1);assert(before.find("\"midi_channels\":[0,1]")!=std::string::npos);
    // Same-part selection in a rejected transaction must not strand later UI edits.
    const uint16_t ui[]={41},us[]={33},li[]={30},ls[]={9},gi[]={2018,2019},gs[]={1,75};
    assert(h->applyPerformance(ui,us,1,li,ls,1,gi,gs,2));
    std::array<float,256> a{},b{},c{},d{};h->render48k(a.data(),b.data(),256);control->render48k(c.data(),d.data(),256);assert(a==c&&b==d);
    auto rejected=h->snapshotJSON();assert(value(rejected,"rejected_commands")==1);assert(value(rejected,"part")==1);assert(field(rejected,"params_upper",41)==127&&field(rejected,"params_lower",30)==6);assert(field(rejected,"params_upper",2019)==50);
    assert(h->parameter(41,91));render(*h);assert(field(h->snapshotJSON(),"params_lower",41)==91);
    assert(!h->applyPerformance(gi,gs,2,nullptr,nullptr,0,nullptr,nullptr,0));
    assert(!h->applyPerformance(nullptr,nullptr,0,nullptr,nullptr,0,ui,us,1));
    assert(!h->applyPerformance(nullptr,nullptr,1,nullptr,nullptr,0,nullptr,nullptr,0));
    assert(!h->applyPerformance(ui,us,257,nullptr,nullptr,0,nullptr,nullptr,0));++cases;
}
static void rejectedSelectionDoesNotRouteLaterQueuedEdits(){
    auto h=make();const uint16_t li[]={30},bad[]={9},ci[]={2018},cv[]={1};
    assert(h->applyPerformance(nullptr,nullptr,0,li,bad,1,ci,cv,1));
    assert(h->parameter(41,15)); // It was intended for the rejected Lower selection.
    render(*h);auto s=h->snapshotJSON();assert(value(s,"part")==0);assert(value(s,"rejected_commands")==2);
    assert(field(s,"params_upper",41)==127&&field(s,"params_lower",41)==127);
    assert(h->parameter(41,81));render(*h);s=h->snapshotJSON();assert(field(s,"params_upper",41)==81&&field(s,"params_lower",41)==127);++cases;
}
static void legacyUpperImport(){
    auto h=make();h->setPart(1);render(*h);const uint16_t ids[]={41,2034},vs[]={71,132};
    assert(h->applyPatch(ids,vs,2));render(*h);auto s=h->snapshotJSON();assert(value(s,"part")==1);assert(field(s,"params_upper",41)==71&&field(s,"params_lower",41)==127);assert(field(s,"params_lower",2034)==132);++cases;
}
static void lowerAudio(){
    auto h=make();h->setPart(1);assert(h->partParameter(1,30,5));assert(h->midi(0x91,60,100));
    std::array<float,256> l{},r{};float peak=0;for(unsigned j=0;j<40;++j){h->render48k(l.data(),r.data(),256);for(auto x:l)peak=std::max(peak,std::abs(x));}
    assert(peak>1e-4f);assert(value(h->snapshotJSON(),"rejected_commands")==0);++cases;
}
static void slotsAndEpoch(){
    auto h=make();const uint16_t ids[]={41};
    for(uint16_t i=0;i<8;++i){uint16_t v=20+i;assert(h->applyPerformance(nullptr,nullptr,0,ids,&v,1,nullptr,nullptr,0));}
    uint16_t v=88;assert(!h->applyPerformance(nullptr,nullptr,0,ids,&v,1,nullptr,nullptr,0));render(*h);assert(field(h->snapshotJSON(),"params_lower",41)==27);
    assert(h->applyPerformance(nullptr,nullptr,0,ids,&v,1,nullptr,nullptr,0));h->panic();render(*h);assert(field(h->snapshotJSON(),"params_lower",41)==88);
    h->setActive(false);h->setPart(1);assert(h->parameter(41,99));render(*h);h->setActive(true);render(*h);assert(field(h->snapshotJSON(),"params_lower",41)==99);++cases;
}
static void realtimeAllocation(){
    auto h=make();const uint16_t pi[]={30,31},u[]={0,127},l[]={6,64},ci[]={2016},cv[]={1};
    allocations.store(0);track=true;
    for(unsigned i=0;i<48;++i){
        assert(h->applyPerformance(pi,u,2,pi,l,2,ci,cv,1));
        assert(h->partParameter(i&1,41,32+i));assert(h->midi(uint8_t(0x90|(i&1)),uint8_t(48+i%24),100));
        render(*h,256);assert(h->midi(uint8_t(0x80|(i&1)),uint8_t(48+i%24),0));render(*h,256);
    }
    track=false;assert(allocations.load()==0);++cases;
}
static void concurrentSnapshots(){
    auto h=make();std::atomic<bool> finished=false;
    std::thread audio([&]{track=true;for(unsigned i=0;i<600;++i)render(*h,64);track=false;finished.store(true);});
    std::thread a([&]{for(unsigned i=0;i<400;++i)assert(h->partParameter(0,41,i%128));});
    std::thread b([&]{for(unsigned i=0;i<400;++i)assert(h->partParameter(1,41,127-i%128));});
    while(!finished.load()){const auto s=h->snapshotJSON();assert(s.find("\"backend\":\"rust-experimental\"")!=std::string::npos);}
    a.join();b.join();audio.join();for(unsigned i=0;i<5;++i)render(*h,64);
    const auto s=h->snapshotJSON();assert(field(s,"params_upper",41)==399%128);assert(field(s,"params_lower",41)==127-399%128);assert(allocations.load()==0);++cases;
}
static void overlappingSelectionProducerIsRejectedWithoutBlocking(){
    auto h=std::make_unique<JP8000RustHost>();h->setActive(true);
    auto& flag=h.get()->*access(FlagTag{});auto& selection=h.get()->*access(SelectionTag{});
    assert(!flag.test_and_set());selection.store(5); // Reserved Lower, not queued.
    std::thread other([&]{assert(!h->parameter(41,7));assert(!h->parameter(2018,2));assert(h->partParameter(1,41,61));assert(h->midi(0x90,60,100));});
    other.join();selection.store(0);flag.clear();std::array<float,64> l{},r{};h->render48k(l.data(),r.data(),64);
    const auto state=h->snapshotJSON();assert(field(state,"params_upper",41)==127&&field(state,"params_lower",41)==61);assert(value(state,"part")==0);++cases;
}
static void rollbackDoesNotRestoreRetiredOrReusedSelection(){
    auto h=std::make_unique<JP8000RustHost>();h->setActive(true);
    (h.get()->*access(SelectionTag{})).store(9);(h.get()->*access(FailedTag{})).store(5);(h.get()->*access(GenerationTag{})).store(8);
    (h.get()->*access(RollbackTag{}))(9,5); // Callback retired5 while9 was reserved.
    assert(((h.get()->*access(SelectionTag{})).load()&3)==3);
    assert(!h->parameter(41,7));
    assert(h->parameter(2018,1));assert(h->parameter(41,83));std::array<float,64> l{},r{};h->render48k(l.data(),r.data(),64);
    const auto state=h->snapshotJSON();assert(value(state,"part")==1&&field(state,"params_lower",41)==83);++cases;
}
static void laterSelectionSurvivesEarlierFailure(){
    auto h=make();const uint16_t ids[]={30},bad[]={9},ci[]={2018},cv[]={1};
    assert(h->applyPerformance(nullptr,nullptr,0,ids,bad,1,ci,cv,1));h->setPart(2);assert(h->parameter(41,98));render(*h);
    const auto s=h->snapshotJSON();assert(value(s,"part")==2&&field(s,"params_upper",41)==98&&field(s,"params_lower",41)==98);++cases;
}
static void pendingOverflowRetiresBothSelectionKinds(){
    for(bool patch:{false,true}){
        auto h=make();for(unsigned i=0;i<2048;++i)assert(h->midi(0x90,60,100,9*48000));
        for(unsigned i=0;i<8;++i)render(*h,64);
        if(patch){const uint16_t ci[]={2018},cv[]={1};assert(h->applyPerformance(nullptr,nullptr,0,nullptr,nullptr,0,ci,cv,1));}
        else assert(h->parameter(2018,1));
        assert(h->parameter(41,17));render(*h,64);render(*h,64);render(*h,64);
        assert(h->parameter(41,89));render(*h,64);const auto s=h->snapshotJSON();assert(h->droppedEvents()>0);
        assert(value(s,"part")==0&&field(s,"params_upper",41)==89&&field(s,"params_lower",41)==127);
        h->setPart(1);assert(h->parameter(41,79));render(*h,64);assert(field(h->snapshotJSON(),"params_lower",41)==79);
    }
    ++cases;
}
static void acceptedPredecessorSurvivesDroppedSuccessor(){
    for(bool patch:{false,true})for(unsigned parameters:{0u,1u}){
        auto h=make();for(unsigned i=0;i<2047-parameters;++i)assert(h->midi(0x90,60,100,9*48000));
        for(unsigned i=0;i<8;++i)render(*h,64);
        assert(h->parameter(2018,1));
        if(parameters)assert(h->parameter(41,65));
        if(patch){const uint16_t ci[]={2018},cv[]={2};assert(h->applyPerformance(nullptr,nullptr,0,nullptr,nullptr,0,ci,cv,1));}
        else assert(h->parameter(2018,2));
        render(*h,64);assert(value(h->snapshotJSON(),"part")==1);
        if(parameters)assert(field(h->snapshotJSON(),"params_lower",41)==65);
        assert(h->parameter(41,77));for(unsigned i=0;i<3;++i)render(*h,64);
        auto s=h->snapshotJSON();assert(value(s,"part")==1&&field(s,"params_lower",41)==77&&field(s,"params_upper",41)==127);
    }
    ++cases;
}
int main(){acceptedPredecessorSurvivesDroppedSuccessor();overlappingSelectionProducerIsRejectedWithoutBlocking();rollbackDoesNotRestoreRetiredOrReusedSelection();laterSelectionSurvivesEarlierFailure();pendingOverflowRetiresBothSelectionKinds();scopedQueue();transaction();rejectedSelectionDoesNotRouteLaterQueuedEdits();legacyUpperImport();lowerAudio();slotsAndEpoch();realtimeAllocation();concurrentSnapshots();
 std::cout<<"{\"passed\":true,\"cases\":"<<cases<<",\"firmware_linked\":false,\"firmware_inputs\":[],\"cpp_callback_allocations\":"<<allocations.load()<<",\"rust_callback_allocation_instrumentation\":false,\"rust_callback_allocations\":null,\"allocation_test_transactions\":48,\"allocation_test_stereo_frames\":24576,\"physical_latency_measured\":false}\n";
}
