#ifdef NDEBUG
#error "The contract fixture requires assertions; compile with -UNDEBUG"
#endif
// Headless test: never opens an audio or MIDI device.
#if !defined(JP8000_HOST_TEST_IO_DELAY_MS) || JP8000_HOST_TEST_IO_DELAY_MS != 500
#error "Compile this test with -DJP8000_HOST_TEST_IO_DELAY_MS=500"
#endif
#include "../App/JP8000Host.hpp"
#include <cassert>
#include <cstdlib>
#include <iostream>
static thread_local bool inCallback=false;
static std::atomic<unsigned> callbackAllocations{0};
void* operator new(std::size_t size){if(inCallback)++callbackAllocations;if(auto p=std::malloc(size))return p;throw std::bad_alloc();}
void operator delete(void* p) noexcept{std::free(p);}
void operator delete(void* p,std::size_t) noexcept{std::free(p);}
// Deterministic contract fixture only. Actual firmware benchmarking is separate.
struct jp8000 {uint64_t frames=0;float signal=0;unsigned pending=0;uint32_t value=0,part=0;};
static std::atomic<unsigned> midiCount{0},parameterMessages{0},lastMidiStatus{0},lastMidiData2{0};
static std::atomic<uint64_t> touchedParameters{0};
extern "C" {
jp8000_t* jp8000_create(const char*,const char*,char*,size_t){return new jp8000;}
void jp8000_destroy(jp8000_t*h){delete h;}
uint32_t jp8000_native_sample_rate(){return 88200;}
int jp8000_ready(jp8000_t*){return 1;}
int jp8000_stats(jp8000_t*h,jp8000_stats_t*s){*s={h->frames*4,0,h->frames,1,h->pending?1:0};return 0;}
int jp8000_render(jp8000_t*h,float*l,float*r,uint32_t n){std::fill_n(l,n,h->signal);std::fill_n(r,n,h->signal*.5f);h->frames+=n;h->pending=n>=h->pending?0:h->pending-n;return 0;}
int jp8000_midi(jp8000_t*h,uint8_t status,uint8_t,uint8_t value,uint32_t){++midiCount;lastMidiData2.store(value);lastMidiStatus.store(status);h->signal=(status&0xf0)==0x90&&value?0.5f:0;return 0;}
int jp8000_parameter(jp8000_t*h,jp8000_scope scope,uint32_t offset,uint32_t v,uint32_t){++parameterMessages;if(offset<64)touchedParameters.fetch_or(uint64_t(1)<<offset);if(scope==JP8000_PERFORMANCE&&offset==18)h->part=v;else h->value=v;h->pending=400;return 0;}
int jp8000_factory_patch(jp8000_t*h,uint32_t,uint32_t){h->pending=400;return 0;}
int jp8000_factory_performance(jp8000_t*h,uint32_t){h->pending=400;return 0;}
int jp8000_panel(jp8000_t*h,uint32_t,int){h->pending=15000;return 0;}
int jp8000_panic(jp8000_t*h){h->signal=0;return 0;}
size_t jp8000_snapshot_json(jp8000_t*h,char*out,size_t cap){const std::string s="{\"ready\":true,\"state_syncing\":"+std::string(h->pending?"true":"false")+",\"params_upper\":{\"2018\":"+std::to_string(h->part)+",\"106\":"+std::to_string(h->value)+"},\"params_lower\":{\"106\":22},\"upper_name\":\"Up\",\"lower_name\":\"Down\",\"midi_channels\":[0,1]}";if(cap>=s.size()+1)std::memcpy(out,s.c_str(),s.size()+1);return s.size()+1;}
size_t jp8000_save_state(jp8000_t*h,uint8_t*out,size_t cap){if(h->pending)return 0;if(cap>=4){out[0]=0xf0;out[1]=uint8_t(h->value);out[2]=0;out[3]=0xf7;}return 4;}
int jp8000_load_state(jp8000_t*h,const uint8_t*b,size_t n){if(n!=4||b[0]!=0xf0)return -1;h->value=b[1];h->pending=400;return 0;}
const char* jp8000_last_error(jp8000_t*){return "fixture error";}
}
static void waitUntil(auto predicate,unsigned ms=5000){const auto end=std::chrono::steady_clock::now()+std::chrono::milliseconds(ms);while(!predicate()){assert(std::chrono::steady_clock::now()<end);std::this_thread::sleep_for(std::chrono::milliseconds(1));}}
int main(int argc,char**argv){
    if(argc!=2){std::cerr<<"usage: JP8000HostFixtureTests NEW_STATE_DIRECTORY\n";return 1;}
    const std::string directory=argv[1];
    if(std::filesystem::exists(directory)){std::cerr<<"Use a fresh state directory\n";return 1;}
    // MPSC exactly-once/in-order per producer with simultaneous publication.
    jp8000_detail::Queue<256> q;std::array<std::thread,4> threads;constexpr unsigned count=5000;
    for(unsigned t=0;t<threads.size();++t)threads[t]=std::thread([&,t]{for(unsigned i=0;i<count;++i)while(!q.push({0,t,i}))std::this_thread::yield();});
    std::array<unsigned,4> next{};unsigned total=0;jp8000_detail::Command c;
    while(total<4*count){if(q.pop(c)){assert(c.a<4&&c.b==next[c.a]++);++total;}else std::this_thread::yield();}
    for(auto&t:threads)t.join();
    auto h=JP8000Host::create("fixture","fixture",directory);waitUntil([&]{return h->ready();});h->setActive(true);
    std::array<float,128> l{},r{};
    auto callback=[&]{inCallback=true;h->render48k(l.data(),r.data(),128);inCallback=false;};
    waitUntil([&]{return h->queuedFrames()>=192;});
    auto deadline=std::chrono::steady_clock::now();
    auto tick=[&]{callback();deadline+=std::chrono::microseconds(2667);std::this_thread::sleep_until(deadline);};
    for(unsigned i=0;i<12;++i)tick();
    h->midi(0x90,60,100);unsigned latency=0;
    for(;latency<1024;latency+=128){tick();if(std::abs(l[127])>0.1f)break;}
    assert(latency<512);assert(midiCount>0);
    h->setVelocitySensitive(false);
    for(auto status:{0xf8,0xfa,0xfc,0xf2}){h->midi(uint8_t(status),19,11);waitUntil([&]{return lastMidiStatus.load()==unsigned(status);});assert(lastMidiData2.load()==11);}
    h->midi(0x90,60,42);waitUntil([&]{return lastMidiStatus.load()==0x90;});assert(lastMidiData2.load()==127);
    deadline=std::chrono::steady_clock::now();
    const auto baselineUnderflows=h->underflows();for(unsigned i=0;i<60;++i)tick();assert(h->underflows()==baselineUnderflows);
    h->saveState(directory+"/during-stream.syx");for(unsigned i=0;i<300;++i)tick();assert(h->underflows()==baselineUnderflows);
    h->setActive(false);callback();for(float x:l)assert(x==0);
    h->setActive(true);callback();waitUntil([&]{return h->queuedFrames()>=192;});callback();for(float x:l)assert(x==0); // heldnote did not survive
    h->setActive(false);assert(h->parameter(106,73));h->setPart(1);
    h->saveState(directory+"/explicit.syx");waitUntil([&]{const auto snapshot=h->snapshotJSON();return snapshot.find("\"operation_status\":\"saved\"")!=std::string::npos&&snapshot.find("\"operation_id\":2")!=std::string::npos;});
    assert(std::filesystem::file_size(directory+"/explicit.syx")==4);
    h->saveState(directory+"/explicit.syx");waitUntil([&]{return h->snapshotJSON().find("\"operation_id\":3")!=std::string::npos;});
    h->loadState(directory+"/explicit.syx");waitUntil([&]{return h->snapshotJSON().find("\"operation_status\":\"loaded\"")!=std::string::npos;});
    h->loadState(directory+"/does-not-exist.syx");waitUntil([&]{return h->snapshotJSON().find("\"operation_status\":\"error\"")!=std::string::npos;});waitUntil([&]{return h->ready();});
    assert(callbackAllocations==0);
    h->setActive(false);h->setPart(0);std::this_thread::sleep_for(std::chrono::milliseconds(200));
    parameterMessages.store(0);touchedParameters.store(0);const auto floodStart=std::chrono::steady_clock::now();
    for(unsigned i=0;i<120;++i){for(unsigned id:{41u,42u,43u,44u,23u,25u,26u,31u,32u,51u})assert(h->parameter(id,90+i%38));std::this_thread::sleep_until(floodStart+std::chrono::microseconds(8333*(i+1)));}
    const double floodSeconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-floodStart).count();assert(parameterMessages.load()<=unsigned(std::ceil(floodSeconds*100))+2);uint64_t expected=0;for(unsigned id:{41u,42u,43u,44u,23u,25u,26u,31u,32u,51u})expected|=uint64_t(1)<<id;assert((touchedParameters.load()&expected)==expected);
    const auto messages=parameterMessages.load();h.reset();
    // Measure the actual128-tap resampler's steady sine amplitude, not a parallel formula.
    std::cout<<"{\"parameter_messages_in_flood\":"<<messages<<",\"flood_seconds\":"<<floodSeconds<<",\"mpsc_events\":"<<total<<",\"callback_allocations\":0,\"event_latency_frames_upper_bound\":"<<latency+128<<",\"steady_underruns\":0,\"sine_response_db\":{";
    bool first=true;
    for(double hz:{1000.,16000.,18000.,20000.,20500.,22000.,24000.,26000.,30000.,40000.}){
        jp8000_detail::Resampler<> rs;uint64_t input=0;double energy=0;
        for(unsigned output=0;output<12000;++output){while(!rs.available()){float a[64];for(unsigned i=0;i<64;++i)a[i]=float(std::sin(2*3.14159265358979323846*hz*(input++)/88200));rs.append(a,a,64);}auto s=rs.next();if(output>=2000)energy+=s.l*s.l;}
        if(!first)std::cout<<',';first=false;std::cout<<'"'<<hz<<"\":"<<10*std::log10(energy/10000*2);
    }
    std::cout<<"}}\n";
}
