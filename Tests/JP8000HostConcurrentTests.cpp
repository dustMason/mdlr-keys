// Headless test: never opens an audio or MIDI device.
#if !defined(JP8000_HOST_TEST_IO_DELAY_MS) || JP8000_HOST_TEST_IO_DELAY_MS != 500
#error "Compile this test with -DJP8000_HOST_TEST_IO_DELAY_MS=500"
#endif
#include "../App/JP8000Host.hpp"
#include <iostream>
#include <cstdlib>
static thread_local bool inCallback=false;
static std::atomic<unsigned> callbackAllocations{0};
void*operator new(size_t n){if(inCallback)++callbackAllocations;if(void*p=std::malloc(n))return p;throw std::bad_alloc();}
void operator delete(void*p)noexcept{std::free(p);}void operator delete(void*p,size_t)noexcept{std::free(p);}
using Clock=std::chrono::steady_clock;
static void require(bool b,const std::string&m){if(!b)throw std::runtime_error(m);}
struct Pump {
    std::shared_ptr<JP8000Host> h;std::atomic<bool> quit{false};std::thread thread;
    std::atomic<uint64_t> frames{0},callbackMaxNs{0},maxLateNs{0};
    std::atomic<float> lastPeak{0},peak{0},threshold{-1};
    std::atomic<int64_t> firstSound{-1};std::atomic<uint64_t> eventBase{0};
    Pump(std::shared_ptr<JP8000Host> host):h(std::move(host)){thread=std::thread([this]{run();});}
    ~Pump(){quit.store(true);if(thread.joinable())thread.join();}
    void run(){
#if defined(__APPLE__)
        pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE,0);
#endif
        std::array<float,128> l{},r{};auto due=Clock::now();
        while(!quit.load()){
            auto before=Clock::now();const auto late=std::chrono::duration_cast<std::chrono::nanoseconds>(before-due).count();if(late>0)maxLateNs.store(std::max(maxLateNs.load(),uint64_t(late)));
            inCallback=true;h->render48k(l.data(),r.data(),128);inCallback=false;
            const auto ns=std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now()-before).count();callbackMaxNs.store(std::max(callbackMaxNs.load(),uint64_t(ns)));
            const uint64_t at=frames.load();float p=0;for(unsigned i=0;i<128;++i){p=std::max(p,std::abs(l[i])+std::abs(r[i]));if(threshold.load()>0&&firstSound.load()<0&&std::abs(l[i])+std::abs(r[i])>threshold.load())firstSound.store(int64_t(at+i-eventBase.load()));}
            lastPeak.store(p);peak.store(std::max(peak.load(),p));frames.store(at+128);due+=std::chrono::nanoseconds(2666667);
            std::this_thread::sleep_until(due-std::chrono::microseconds(100));while(Clock::now()<due)std::atomic_signal_fence(std::memory_order_seq_cst);
        }
    }
};
static void wait(auto predicate,const std::shared_ptr<JP8000Host>&h,unsigned seconds=15){const auto end=Clock::now()+std::chrono::seconds(seconds);while(!predicate()){require(Clock::now()<end,"timeout: "+h->snapshotJSON());std::this_thread::sleep_for(std::chrono::milliseconds(2));}}
int main(int argc,char**argv){try{
    require(argc==4,"usage ROM RAM state-directory");const auto start=Clock::now();const std::string dir=argv[3];require(!std::filesystem::exists(dir),"Use a fresh state directory");auto h=JP8000Host::create(argv[1],argv[2],dir);wait([&]{return h->ready();},h,40);const double boot=std::chrono::duration<double>(Clock::now()-start).count();
    Pump pump(h);h->setActive(true);std::this_thread::sleep_for(std::chrono::milliseconds(150));const auto u0=h->underflows();
    auto coherent=[&](unsigned id,unsigned value){auto s=h->snapshotJSON();return jp8000_detail::jsonValue(s,"state_syncing")=="false"&&jp8000_detail::jsonValue(jp8000_detail::jsonValue(s,"params_upper"),std::to_string(id).c_str())==std::to_string(value);};
    h->setPart(0);h->parameter(41,111);wait([&]{return coherent(41,111);},h);
    const auto baseline=h->snapshotJSON();std::ofstream(dir+"-baseline.json")<<baseline;auto channels=jp8000_detail::jsonValue(baseline,"midi_channels","[0,1]");unsigned channel=unsigned(std::stoi(channels.substr(1)));if(channel>15)channel=0;
    h->saveState(dir+"/explicit.syx");wait([&]{return jp8000_detail::jsonValue(h->snapshotJSON(),"operation_status")=="\"saving\"";},h);
    std::atomic<bool> floodQuit{false};std::thread flood([&]{unsigned i=0;auto due=Clock::now();while(!floodQuit.load()){for(unsigned id:{41u,42u,43u,44u,23u,25u,26u,31u,32u,51u})h->parameter(id,id==42?i%20:90+i%38);++i;due+=std::chrono::microseconds(8333);std::this_thread::sleep_until(due);}});
    std::this_thread::sleep_for(std::chrono::milliseconds(100));const float baselineNoise=pump.lastPeak.load();pump.eventBase.store(pump.frames.load());pump.threshold.store(std::max(1e-4f,baselineNoise*5));h->midi(uint8_t(0x90|channel),60,127);
    std::this_thread::sleep_for(std::chrono::milliseconds(700));h->midi(uint8_t(0x80|channel),60,0);floodQuit.store(true);flood.join();wait([&]{return jp8000_detail::jsonValue(h->snapshotJSON(),"operation_status")=="\"saved\"";},h);
    require(pump.firstSound.load()>=0,"real firmware note not detected above background");require(std::filesystem::file_size(dir+"/explicit.syx")==625,"incomplete save");
    std::this_thread::sleep_for(std::chrono::milliseconds(500));const auto streamed=h->snapshotJSON();const auto underruns=h->underflows()-u0;const auto normalOnset=pump.firstSound.load();
    h->setActive(false);h->loadState(dir+"/explicit.syx");wait([&]{return jp8000_detail::jsonValue(h->snapshotJSON(),"operation_status")=="\"loaded\"";},h);require(coherent(41,111),"firmware cutoff restore mismatch");
    h->setPart(2);wait([&]{return coherent(2018,2)&&jp8000_detail::jsonValue(h->snapshotJSON(),"part")=="2";},h);
    h->parameter(2018,1);wait([&]{return coherent(2018,1)&&jp8000_detail::jsonValue(h->snapshotJSON(),"part")=="1";},h);
    h->panel(128,true);h->panel(128,false);wait([&]{return coherent(2018,0)&&jp8000_detail::jsonValue(h->snapshotJSON(),"part")=="0";},h);
    std::array<int64_t,3> switchOnsets{};
    for(auto& onset:switchOnsets){
        h->setActive(false);std::this_thread::sleep_for(std::chrono::milliseconds(100));
        pump.threshold.store(-1);pump.firstSound.store(-1);pump.eventBase.store(pump.frames.load());pump.threshold.store(std::max(1e-4f,baselineNoise*5));
        h->setActive(true);h->midi(uint8_t(0x90|channel),60,127);
        wait([&]{return pump.firstSound.load()>=0;},h);onset=pump.firstSound.load();
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    h->setActive(false);std::this_thread::sleep_for(std::chrono::milliseconds(100));
    require(pump.lastPeak.load()==0,"inactive callback leaked stale audio");
    require(callbackAllocations.load()==0,"callback allocated");
    std::ofstream(dir+"-final.json")<<h->snapshotJSON();
    std::cout<<"{\"switch_onset_frames\":["<<switchOnsets[0]<<','<<switchOnsets[1]<<','<<switchOnsets[2]<<"],\"boot_seconds\":"<<boot<<",\"frames\":"<<pump.frames.load()<<",\"callback_max_us\":"<<pump.callbackMaxNs.load()/1000.0<<",\"callback_max_lateness_us\":"<<pump.maxLateNs.load()/1000.0<<",\"callback_allocations\":0,\"note_on_frame_upper_bound\":"<<normalOnset<<",\"note_on_ms_upper_bound\":"<<normalOnset/48.0<<",\"background_peak\":"<<baselineNoise<<",\"stream_underruns\":"<<underruns<<",\"peak\":"<<pump.peak.load()<<",\"disk_stall_ms\":500,\"drag_events_per_second\":1200,\"save_bytes\":625,\"cutoff_restored\":111,\"part_readback_tests\":3,\"snapshot\":"<<streamed<<"}\n";
    return underruns?2:0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
