#pragma once
// One emulator-owner worker; the audio callback only reads a fixed stereo ring.
#include "jp8000.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <bitset>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <stdexcept>
#include <thread>
#include <vector>
#if defined(__APPLE__)
#include <pthread.h>
#endif

namespace jp8000_detail {
struct Command { uint32_t kind=0,a=0,b=0,c=0,d=0; uint64_t epoch=0; };
// Bounded MPSC sequence slots. Failed reservation never publishes a partial event.
template<size_t N> class Queue {
    static_assert((N&(N-1))==0);
    struct Slot { std::atomic<size_t> sequence{0}; Command command{}; };
    std::array<Slot,N> slots_{};
    alignas(64) std::atomic<size_t> write_{0};
    alignas(64) size_t read_=0;
public:
    Queue(){ for(size_t i=0;i<N;++i)slots_[i].sequence.store(i); }
    bool push(const Command& c) noexcept {
        size_t pos=write_.load(std::memory_order_relaxed);
        for(unsigned tries=0;tries<128;++tries){
            Slot& s=slots_[pos&(N-1)];
            const intptr_t delta=intptr_t(s.sequence.load(std::memory_order_acquire))-intptr_t(pos);
            if(delta==0){
                if(write_.compare_exchange_weak(pos,pos+1,std::memory_order_relaxed)){
                    s.command=c;s.sequence.store(pos+1,std::memory_order_release);return true;
                }
            } else if(delta<0)return false;
            else pos=write_.load(std::memory_order_relaxed);
        }
        return false;
    }
    bool pop(Command& c) noexcept {
        Slot& s=slots_[read_&(N-1)];
        if(s.sequence.load(std::memory_order_acquire)!=read_+1)return false;
        c=s.command;s.sequence.store(read_+N,std::memory_order_release);++read_;return true;
    }
};
struct Stereo { float l=0,r=0; };
// Rational88.2k->48k:147 input samples per80 output samples. Kaiser FIR.
// Default128-tap delay63.5/88200=0.720ms;64 samples of future input needed.
template<unsigned Taps=128,unsigned CutoffHz=21500> class Resampler {
    static constexpr unsigned Phases=80, Capacity=1024;
    std::array<std::array<float,Taps>,Phases> coefficients_{};
    std::array<Stereo,Capacity> input_{};
    uint64_t position_=0, written_=0;
    static double i0(double x){double s=1,t=1;for(unsigned k=1;k<40;++k){t*=x*x/(4.0*k*k);s+=t;if(t<1e-15*s)break;}return s;}
public:
    Resampler(){
        constexpr double pi=3.14159265358979323846, cutoff=double(CutoffHz)/88200.0, beta=7.5;
        const double denom=i0(beta);
        for(unsigned p=0;p<Phases;++p){
            double total=0;
            for(unsigned t=0;t<Taps;++t){
                const double x=double(t)-double(Taps/2-1)-double(p)/Phases;
                const double a=2.0*x/(Taps-1);
                const double window=std::abs(a)<=1?i0(beta*std::sqrt(std::max(0.0,1-a*a)))/denom:0;
                const double sinc=std::abs(x)<1e-12?2*cutoff:std::sin(2*pi*cutoff*x)/(pi*x);
                total+=(coefficients_[p][t]=float(window*sinc));
            }
            for(float& c:coefficients_[p])c=float(c/total);
        }
    }
    void reset() noexcept {position_=written_=0;input_.fill({});}
    void append(const float* l,const float* r,unsigned n) noexcept {for(unsigned i=0;i<n;++i)input_[written_++&(Capacity-1)]={l[i],r[i]};}
    bool available() const noexcept {return written_>position_/Phases+Taps/2;}
    unsigned ahead() const noexcept {return unsigned(written_-position_/Phases);}
    Stereo next() noexcept {
        const int64_t base=int64_t(position_/Phases);
        const auto& c=coefficients_[position_%Phases];
        Stereo out{};
        for(unsigned t=0;t<Taps;++t){const int64_t at=base+int(t)-int(Taps/2-1);if(at>=0){const auto& x=input_[uint64_t(at)&(Capacity-1)];out.l+=x.l*c[t];out.r+=x.r*c[t];}}
        position_+=147;return out;
    }
};
inline std::string quote(const std::string& s){
    std::string o="\"";for(unsigned char c:s){if(c=='"'||c=='\\'){o+='\\';o+=char(c);}else if(c=='\n')o+="\\n";else if(c>=32)o+=char(c);}return o+'"';
}
// Copy a complete JSON value from native snapshots; never synthesize parameter data.
inline std::string jsonValue(const std::string& json,const char* key,const char* fallback="null"){
    auto p=json.find(std::string("\"")+key+'"');if(p==std::string::npos)return fallback;
    p=json.find(':',p);if(p==std::string::npos)return fallback;
    p=json.find_first_not_of(" \t\r\n",p+1);if(p==std::string::npos)return fallback;
    const size_t start=p;int depth=0;bool str=false,esc=false;
    for(;p<json.size();++p){const char c=json[p];
        if(str){if(esc)esc=false;else if(c=='\\')esc=true;else if(c=='"'){str=false;if(depth==0)return json.substr(start,p-start+1);}continue;}
        if(c=='"'){str=true;continue;}if(c=='{'||c=='['){++depth;continue;}
        if(c=='}'||c==']'){if(depth==0)break;if(--depth==0)return json.substr(start,p-start+1);}
        if(depth==0&&(c==','||c=='\n'||c=='\r'))break;
    }
    return json.substr(start,p-start);
}
inline void removeJSONMember(std::string& json,const char* key){
    auto p=json.find(std::string("\"")+key+'"');if(p==std::string::npos)return;
    auto colon=json.find(':',p);if(colon==std::string::npos)return;
    auto valueStart=json.find_first_not_of(" \t\r\n",colon+1);if(valueStart==std::string::npos)return;
    auto end=valueStart+jsonValue(json,key).size();
    auto next=json.find_first_not_of(" \t\r\n",end);
    if(next!=std::string::npos&&json[next]==',')end=next+1;
    else{auto prior=json.find_last_not_of(" \t\r\n",p?p-1:0);if(prior!=std::string::npos&&json[prior]==',')p=prior;}
    json.erase(p,end-p);
}
struct Param { uint32_t id,min,max,width; };
static constexpr Param Parameters[] = {
    {16,0,3,1}, // Lfo1Waveform
    {17,0,127,1}, // Lfo1Rate
    {18,0,127,1}, // Lfo1Fade
    {19,0,127,1}, // Lfo2Rate
    {20,0,2,1}, // Lfo2DepthSelect
    {21,0,1,1}, // RingModulatorSwitch
    {22,0,127,1}, // CrossModulationDepth
    {23,0,127,1}, // OscillatorBalance
    {24,0,2,1}, // Lfo1AndEnvelopeDestination
    {25,0,127,1}, // OscLfo1Depth
    {26,0,127,1}, // PitchLfo2Depth
    {27,0,127,1}, // PitchEnvelopeDepth
    {28,0,127,1}, // PitchEnvelopeAttackTime
    {29,0,127,1}, // PitchEnvelopeDecayTime
    {30,0,6,1}, // Osc1Waveform
    {31,0,127,1}, // Osc1Control1
    {32,0,127,1}, // Osc1Control2
    {33,0,2,1}, // Osc2Waveform
    {34,0,1,1}, // Osc2SyncSwitch
    {35,0,50,1}, // Osc2Range
    {36,0,100,1}, // Osc2FineWide
    {37,0,127,1}, // Osc2Control1
    {38,0,127,1}, // Osc2Control2
    {39,0,2,1}, // FilterType
    {40,0,1,1}, // CutoffSlope
    {41,0,127,1}, // CutoffFrequency
    {42,0,127,1}, // Resonance
    {43,0,127,1}, // CutoffFrequencyKeyFollow
    {44,0,127,1}, // FilterLfo1Depth
    {45,0,127,1}, // FilterLfo2Depth
    {46,0,127,1}, // FilterEnvelopeDepth
    {47,0,127,1}, // FilterEnvelopeAttackTime
    {48,0,127,1}, // FilterEnvelopeDecayTime
    {49,0,127,1}, // FilterEnvelopeSustainLevel
    {50,0,127,1}, // FilterEnvelopeReleaseTime
    {51,0,127,1}, // AmpLevel
    {52,0,127,1}, // AmpLfo1Depth
    {53,0,127,1}, // AmpLfo2Depth
    {54,0,127,1}, // AmpEnvelopeAttackTime
    {55,0,127,1}, // AmpEnvelopeDecayTime
    {56,0,127,1}, // AmpEnvelopeSustainLevel
    {57,0,127,1}, // AmpEnvelopeReleaseTime
    {58,0,2,1}, // AutoPanManualPanSwitch
    {59,0,127,1}, // ToneControlBass
    {60,0,127,1}, // ToneControlTreble
    {61,0,11,1}, // ChorusType
    {62,0,127,1}, // ChorusLevel
    {63,0,4,1}, // DelayType
    {64,0,127,1}, // DelayTime
    {65,0,127,1}, // DelayFeedback
    {66,0,127,1}, // DelayLevel
    {67,0,24,1}, // BendRangeUp
    {68,0,24,1}, // BendRangeDown
    {69,0,1,1}, // PortamentoSwitch
    {70,0,127,1}, // PortamentoTime
    {71,0,1,1}, // MonoSwitch
    {72,0,1,1}, // LegatoSwitch
    {73,0,4,1}, // OscillatorShift
    {74,0,254,2}, // ControlLfo1Rate
    {76,0,254,2}, // ControlLfo1Fade
    {78,0,254,2}, // ControlLfo2Rate
    {80,0,254,2}, // ControlCrossModulationDepth
    {82,0,254,2}, // ControlOscillatorBalance
    {84,0,254,2}, // ControlPitchLfo1Depth
    {86,0,254,2}, // ControlPitchLfo2Depth
    {88,0,254,2}, // ControlPitchEnvelopeDepth
    {90,0,254,2}, // ControlPitchEnvelopeAttackTime
    {92,0,254,2}, // ControlPitchEnvelopeDecayTime
    {94,0,254,2}, // ControlOsc1Control1
    {96,0,254,2}, // ControlOsc1Control2
    {98,77,177,2}, // ControlOsc2Range
    {100,27,227,2}, // ControlOsc2FineWide
    {102,0,254,2}, // ControlOsc2Control1
    {104,0,254,2}, // ControlOsc2Control2
    {106,0,254,2}, // ControlCutoffFrequency
    {108,0,254,2}, // ControlResonance
    {110,0,254,2}, // ControlCutoffFreqKeyFollow
    {112,0,254,2}, // ControlFilterLfo1Depth
    {114,0,254,2}, // ControlFilterLfo2Depth
    {116,0,254,2}, // ControlFilterEnvDepth
    {118,0,254,2}, // ControlFilterEnvAttackTime
    {120,0,254,2}, // ControlFilterEnvDecayTime
    {122,0,254,2}, // ControlFilterEnvSustainLevel
    {124,0,254,2}, // ControlFilterEnvReleaseTime
    {126,0,254,2}, // ControlAmpLevel
    {256,0,254,2}, // ControlAmpLfo1Depth
    {258,0,254,2}, // ControlAmpLfo2Depth
    {260,0,254,2}, // ControlAmpEnvAttackTime
    {262,0,254,2}, // ControlAmpEnvDecayTime
    {264,0,254,2}, // ControlAmpEnvSustainLevel
    {266,0,254,2}, // ControlAmpEnvReleaseTime
    {268,0,254,2}, // ControlToneControlBass
    {270,0,254,2}, // ControlToneControlTreble
    {272,0,254,2}, // ControlMultiEffectsLevel
    {274,0,254,2}, // ControlDelayTime
    {276,0,254,2}, // ControlDelayFeedback
    {278,0,254,2}, // ControlDelayLevel
    {280,0,1,1}, // MorphBendAssign
    {281,0,254,2}, // ControlPortamentoTime
    {283,0,1,1}, // VelocitySwitch
    {284,0,254,2}, // VelocityLfo1Rate
    {286,0,254,2}, // VelocityLfo1Fade
    {288,0,254,2}, // VelocityLfo2Rate
    {290,0,254,2}, // VelocityCrossModulationDepth
    {292,0,254,2}, // VelocityOscillatorBalance
    {294,0,254,2}, // VelocityPitchLfo1Depth
    {296,0,254,2}, // VelocityPitchLfo2Depth
    {298,0,254,2}, // VelocityPitchEnvelopeDepth
    {300,0,254,2}, // VelocityPitchEnvelopeAttackTime
    {302,0,254,2}, // VelocityPitchEnvelopeDecayTime
    {304,0,254,2}, // VelocityOsc1Control1
    {306,0,254,2}, // VelocityOsc1Control2
    {308,77,177,2}, // VelocityOsc2Range
    {310,27,227,2}, // VelocityOsc2FineWide
    {312,0,254,2}, // VelocityOsc2Control1
    {314,0,254,2}, // VelocityOsc2Control2
    {316,0,254,2}, // VelocityCutoffFrequency
    {318,0,254,2}, // VelocityResonance
    {320,0,254,2}, // VelocityCutoffFreqKeyFollow
    {322,0,254,2}, // VelocityFilterLfo1Depth
    {324,0,254,2}, // VelocityFilterLfo2Depth
    {326,0,254,2}, // VelocityFilterEnvDepth
    {328,0,254,2}, // VelocityFilterEnvAttackTime
    {330,0,254,2}, // VelocityFilterEnvDecayTime
    {332,0,254,2}, // VelocityFilterEnvSusLevel
    {334,0,254,2}, // VelocityFilterEnvReleaseTime
    {336,0,254,2}, // VelocityAmpLevel
    {338,0,254,2}, // VelocityAmpLfo1Depth
    {340,0,254,2}, // VelocityAmpLfo2Depth
    {342,0,254,2}, // VelocityAmpEnvAttackTime
    {344,0,254,2}, // VelocityAmpEnvDecayTime
    {346,0,254,2}, // VelocityAmpEnvSustainLevel
    {348,0,254,2}, // VelocityAmpEnvReleaseTime
    {350,0,254,2}, // VelocityToneControlBass
    {352,0,254,2}, // VelocityToneControlTreble
    {354,0,254,2}, // VelocityMultiEffectsLevel
    {356,0,254,2}, // VelocityDelayTime
    {358,0,254,2}, // VelocityDelayFeedback
    {360,0,254,2}, // VelocityDelayLevel
    {362,0,254,2}, // VelocityPortamentoTime
    {1000,0,2,1}, // PatchBank
    {1001,0,127,1}, // PatchNo
    {1002,0,16,1}, // MidiChannel
    {1003,0,48,1}, // PartTranspose
    {1004,0,10,1}, // DelaySync
    {1005,0,22,1}, // LFO1Sync
    {1006,0,23,1}, // ChorusSyncRate
    {2016,0,2,1}, // KeyMode
    {2017,0,127,1}, // SplitPoint
    {2018,0,2,1}, // PanelSelect
    {2019,0,100,1}, // PartDetune
    {2020,0,1,1}, // OutputAssign
    {2021,0,2,1}, // ArpDestination
    {2022,0,4,1}, // voiceAssignKeyboard
    {2023,0,1,1}, // ArpSwitch
    {2024,0,4,1}, // ArpMode
    {2025,0,89,1}, // ArpBeatPattern
    {2026,0,3,1}, // ArpRange
    {2027,0,1,1}, // ArpHold
    {2028,0,2,1}, // PedalAssign
    {2029,0,1,1}, // IndividualTriggerSwitch
    {2030,0,2,1}, // IndividualTriggerDestination
    {2031,0,15,1}, // IndividualTriggerSourceChannel
    {2032,0,128,2}, // IndividualTriggerSourceNote
    {2034,20,250,2}, // Tempo
    {3004,0,1,1}, // MidiSync
    {3009,0,17,1}, // RemoteControlChannel
    {3010,0,100,1}, // MasterTune
};
}

class JP8000Host {
public:
    static std::shared_ptr<JP8000Host> create(std::string rom,std::string baselineRAM,std::string stateDirectory){
        auto h=std::shared_ptr<JP8000Host>(new JP8000Host(std::move(rom),std::move(baselineRAM),std::move(stateDirectory)));
        h->ioWorker_=std::thread([ptr=h.get()]{ptr->runIO();});h->worker_=std::thread([ptr=h.get()]{ptr->run();});return h;
    }
    ~JP8000Host(){quit_.store(true);if(worker_.joinable())worker_.join();ioQuit_.store(true);if(ioWorker_.joinable())ioWorker_.join();}
    JP8000Host(const JP8000Host&)=delete;JP8000Host& operator=(const JP8000Host&)=delete;
    void setActive(bool active) noexcept {
        if(active_.load()==active)return;
        epoch_.fetch_add(1,std::memory_order_acq_rel);primed_.store(0);active_.store(active,std::memory_order_release);
    }
    void render48k(float* l,float* r,uint32_t frames) noexcept {
        if(!l||!r)return;
        callbackFrames_.store(frames,std::memory_order_relaxed);
        const uint32_t target=std::min<uint32_t>(RingCapacity-128,std::max<uint32_t>(192,frames+64));
        targetFrames_.store(target,std::memory_order_relaxed);
        const uint64_t epoch=epoch_.load(std::memory_order_acquire);
        uint64_t rd=read_.load(std::memory_order_relaxed),wr=write_.load(std::memory_order_acquire);
        while(rd!=wr&&ring_[rd&(RingCapacity-1)].epoch!=epoch)++rd;
        if(!active_.load(std::memory_order_acquire)||!qualified_.load(std::memory_order_acquire)||primed_.load(std::memory_order_acquire)!=epoch){
            read_.store(rd,std::memory_order_release);gainSmooth_=volume_.load(std::memory_order_relaxed);monoSmooth_=mono_.load(std::memory_order_relaxed)?1.0f:0.0f;std::fill_n(l,frames,0);std::fill_n(r,frames,0);peak_.store(0);return;
        }
        const float volume=volume_.load(std::memory_order_relaxed);const bool mono=mono_.load(std::memory_order_relaxed);
        uint32_t taken=0;float peak=0;
        while(taken<frames&&rd!=wr){const auto& x=ring_[rd&(RingCapacity-1)];++rd;
            if(x.epoch!=epoch)continue;
            gainSmooth_+=(volume-gainSmooth_)*(1.0f/240);monoSmooth_+=((mono?1.0f:0.0f)-monoSmooth_)*(1.0f/240);
            float left=x.sample.l*gainSmooth_,right=x.sample.r*gainSmooth_;const float center=(left+right)*0.5f;left+=(center-left)*monoSmooth_;right+=(center-right)*monoSmooth_;
            l[taken]=left;r[taken]=right;peak=std::max(peak,std::max(std::abs(left),std::abs(right)));++taken;
        }
        read_.store(rd,std::memory_order_release);
        if(taken<frames){underflows_.fetch_add(1,std::memory_order_relaxed);missingFrames_.fetch_add(frames-taken,std::memory_order_relaxed);std::fill(l+taken,l+frames,0);std::fill(r+taken,r+frames,0);}
        if(epoch_.load(std::memory_order_acquire)!=epoch){std::fill_n(l,frames,0);std::fill_n(r,frames,0);peak=0;}
        rendered_.fetch_add(frames,std::memory_order_relaxed);peak_.store(peak,std::memory_order_relaxed);
    }
    bool midi(uint8_t s,uint8_t a,uint8_t b,uint32_t offset48k=0) noexcept {return push({Midi,s,a,b,offset48k,epoch_.load()});}
    bool parameter(uint32_t id,uint32_t value) noexcept {
        for(const auto& p:jp8000_detail::Parameters)if(p.id==id){if(value<p.min||value>p.max)return false;if(id==2018)return requestPart(value);return push({Parameter,id,value,p.width,part_.load(),epoch_.load()});}return false;
    }
    void setPart(uint32_t part) noexcept {if(part<=2)requestPart(part);}
    bool factoryPatch(uint32_t index) noexcept {return push({Patch,index,part_.load()});}
    bool factoryPerformance(uint32_t index) noexcept {return push({Performance,index});}
    bool panel(uint32_t id,bool down) noexcept {return push({Panel,id,uint32_t(down),0,0,epoch_.load()});}
    void panic() noexcept {epoch_.fetch_add(1);primed_.store(0);panicPending_.store(true,std::memory_order_release);}
    void setMasterVolume(float value) noexcept {if(std::isfinite(value))volume_.store(std::clamp(value,0.0f,2.0f));}
    void setMono(bool mono) noexcept {mono_.store(mono);}
    void setVelocitySensitive(bool enabled) noexcept {velocity_.store(enabled);}
    bool ready() const noexcept {return qualified_.load()&&firmwareReady_.load();}
    float peak() const noexcept {return peak_.load();}
    uint32_t droppedEvents() const noexcept {return dropped_.load();}
    uint64_t underflows() const noexcept {return underflows_.load();}
    uint32_t queuedFrames() const noexcept {const auto w=write_.load(),r=read_.load();return uint32_t(w>=r?w-r:0);}
    std::string snapshotJSON() const {std::lock_guard<std::mutex> lock(snapshotMutex_);return snapshot_;}
    void saveState(std::string path){queueJob(false,std::move(path));}
    void loadState(std::string path){queueJob(true,std::move(path));}
private:
    enum Kind:uint32_t {Midi,Parameter,Patch,Performance,Panel,SelectPart};
    static constexpr uint32_t RingCapacity=8192;
    struct RingFrame {jp8000_detail::Stereo sample;uint64_t epoch=0;};
    struct PendingParameter {jp8000_detail::Command command{};bool valid=false;std::chrono::steady_clock::time_point next{};};
    struct Job {bool load=false;std::string path;};
    struct IOJob {bool load=false,visible=false;std::string path;std::vector<uint8_t> bytes;uint64_t operation=0;};
    struct IOResult {bool load=false,visible=false,ok=false;std::vector<uint8_t> bytes;std::string error;uint64_t operation=0;};
    std::string rom_,baseline_,directory_;
    std::thread worker_,ioWorker_;
    std::atomic<bool> ioQuit_{false};
    std::mutex ioMutex_;std::vector<IOJob> ioJobs_;std::vector<IOResult> ioResults_;
    std::atomic<bool> quit_{false},active_{false},qualified_{false},firmwareReady_{false},panicPending_{false},mono_{false},velocity_{true};
    std::atomic<uint64_t> epoch_{1},primed_{0},underflows_{0},missingFrames_{0},rendered_{0};
    std::atomic<uint64_t> partVersion_{0},failedPartVersion_{~uint64_t(0)};uint64_t appliedPartVersion_=0;
    float gainSmooth_=0.65f,monoSmooth_=0; // Audio consumer owns these.
    std::atomic<uint32_t> part_{0},dropped_{0},callbackFrames_{128},targetFrames_{192};
    std::atomic<float> volume_{0.65f},peak_{0},speed_{0};
    alignas(64) std::atomic<uint64_t> read_{0};
    alignas(64) std::atomic<uint64_t> write_{0};
    std::array<RingFrame,RingCapacity> ring_{};
    jp8000_detail::Queue<2048> commands_;
    mutable std::mutex snapshotMutex_;
    std::string snapshot_="{\"ready\":false,\"state_syncing\":true,\"status\":\"Booting firmware\"}";
    std::mutex jobsMutex_;std::vector<Job> jobs_;
    jp8000_t* core_=nullptr;
    jp8000_stats_t nativeStats_{};
    jp8000_detail::Resampler<> resampler_;
    std::array<float,64> nativeLeft_{},nativeRight_{};
    std::bitset<256> pressed_;
    std::string status_="Booting firmware",operation_="idle",operationError_;
    uint64_t operationID_=0,epochStart_=0,loadOperation_=0,loadingOperation_=0;
    std::string autosaveError_;double snapshotMaxUs_=0;std::atomic<uint32_t> persistenceRejected_{0};
    bool dirty_=false,loadReading_=false,qualificationPending_=false;uint64_t localEpoch_=0;
    std::array<PendingParameter,768> pendingParameters_{};size_t parameterCursor_=0;double parameterCredits_=2;
    std::chrono::steady_clock::time_point parameterCreditTime_=std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point lastChange_{},lastSnapshot_{},lastQualification_{};
    static_assert(std::atomic<uint64_t>::is_always_lock_free&&std::atomic<float>::is_always_lock_free);
    JP8000Host(std::string rom,std::string baseline,std::string dir):rom_(std::move(rom)),baseline_(std::move(baseline)),directory_(std::move(dir)){}
    bool push(jp8000_detail::Command c) noexcept {if(commands_.push(c))return true;dropped_.fetch_add(1);epoch_.fetch_add(1);primed_.store(0);panicPending_.store(true);return false;}
    void queueJob(bool load,std::string path){std::lock_guard<std::mutex> lock(jobsMutex_);if(jobs_.size()<16)jobs_.push_back({load,std::move(path)});else persistenceRejected_.fetch_add(1);}
    bool requestPart(uint32_t part) noexcept {part_.store(part);const uint64_t version=partVersion_.fetch_add(1)+1;if(push({SelectPart,part,0,0,0,version}))return true;failedPartVersion_.store(version);return false;}
    bool check(int result){if(result==0)return true;status_=jp8000_last_error(core_);return false;}
    void changed(){dirty_=true;lastChange_=std::chrono::steady_clock::now();}
    void sendParameter(const jp8000_detail::Command& c){
        const uint32_t region=c.a/1000,offset=c.a%1000;
        const auto send=[&](uint32_t scope){check(jp8000_parameter(core_,jp8000_scope(scope),offset,c.b,c.c));};
        if(region<2){const uint32_t base=region==0?0:2;if(c.d!=1)send(base);if(c.d!=0)send(base+1);}
        else send(region==2?4:5);changed();
    }
    void flushParameters(bool force){
        const auto now=std::chrono::steady_clock::now();
        // One DT1 parameter takes13–14 serial bytes. Cap aggregate traffic at100
        // messages/sec, leaving most DIN bandwidth for notes and firmware queries.
        parameterCredits_=std::min(2.0,parameterCredits_+std::chrono::duration<double>(now-parameterCreditTime_).count()*100.0);parameterCreditTime_=now;
        const auto start=parameterCursor_;
        for(size_t i=0;i<pendingParameters_.size();++i){const size_t index=(start+i)%pendingParameters_.size();auto& p=pendingParameters_[index];
            if(!p.valid||(!force&&now<p.next))continue;
            const double cost=p.command.a<2000&&p.command.d==2?2:1;
            if(!force&&parameterCredits_<cost)continue;
            sendParameter(p.command);p.valid=false;p.next=now+std::chrono::milliseconds(40);parameterCredits_=force?0:parameterCredits_-cost;parameterCursor_=(index+1)%pendingParameters_.size();
        }
    }
    void processCommands(){
        if(loadReading_)return;
        if(panicPending_.exchange(false)){jp8000_panic(core_);}
        jp8000_detail::Command c;unsigned count=0;
        while(count++<2048&&commands_.pop(c)){
            switch(c.kind){
            case Midi:
                if(c.epoch!=localEpoch_||!active_.load())break;
                if(!velocity_.load()&&(c.a&0xf0)==0x90&&c.c)c.c=127;
                if((c.a&0xf0)==0xc0)flushParameters(true);
                check(jp8000_midi(core_,uint8_t(c.a),uint8_t(c.b),uint8_t(c.c),uint32_t((uint64_t(c.d)*147+79)/80)));break;
            case SelectPart:flushParameters(true);check(jp8000_parameter(core_,JP8000_PERFORMANCE,18,c.a,1));appliedPartVersion_=c.epoch;changed();break;
            case Parameter:{
                size_t index=0;for(const auto& p:jp8000_detail::Parameters){if(p.id==c.a)break;++index;}
                index=index*3+(c.a<2000?std::min(c.d,2u):0u);
                if(index<pendingParameters_.size()){pendingParameters_[index].command=c;pendingParameters_[index].valid=true;changed();}break;}
            case Patch:flushParameters(true);if(c.b!=1)check(jp8000_factory_patch(core_,c.a,0));if(c.b!=0)check(jp8000_factory_patch(core_,c.a,1));changed();break;
            case Performance:flushParameters(true);check(jp8000_factory_performance(core_,c.a));changed();break;
            case Panel:flushParameters(true);if(c.a<pressed_.size()){check(jp8000_panel(core_,c.a,int(c.b)));pressed_[c.a]=bool(c.b);changed();}break;
            }
        }
        flushParameters(false);
    }
    void refreshStats(){if(jp8000_stats(core_,&nativeStats_)==0)firmwareReady_.store(nativeStats_.ready!=0);}
    bool renderNative(){
        const auto before=std::chrono::steady_clock::now();const uint64_t fallbacks=nativeStats_.aot_fallbacks;
        if(!check(jp8000_render(core_,nativeLeft_.data(),nativeRight_.data(),64)))return false;
        refreshStats();
        const double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-before).count();
        if(nativeStats_.aot_fallbacks>fallbacks&&seconds>(64.0/88200)/1.25){
            qualified_.store(false);primed_.store(0);status_="DSP program needs faster native coverage";
        }
        resampler_.append(nativeLeft_.data(),nativeRight_.data(),64);return true;
    }
    bool qualify(){
        lastQualification_=std::chrono::steady_clock::now();
        std::array<float,512> l{},r{};
        const auto start=std::chrono::steady_clock::now();
        for(unsigned i=0;i<16&&!quit_.load();++i)if(!check(jp8000_render(core_,l.data(),r.data(),512)))return false;
        const double elapsed=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
        const float speed=float((8192.0/88200)/elapsed);speed_.store(speed);refreshStats();resampler_.reset();
        const bool ok=nativeStats_.ready&&!nativeStats_.state_syncing&&nativeStats_.aot_hits>0&&speed>=1.25f;
        qualificationPending_=nativeStats_.state_syncing;qualified_.store(ok);status_=ok?"Ready · native firmware":"Waiting for complete state or realtime native speed";return ok;
    }
    static std::vector<uint8_t> readFile(const std::string& path){
        std::ifstream f(path,std::ios::binary|std::ios::ate);if(!f)throw std::runtime_error("Cannot open state file");
        const auto n=f.tellg();if(n<=0||n>4*1024*1024)throw std::runtime_error("Invalid state file size");
        std::vector<uint8_t> bytes(size_t(n),uint8_t{});f.seekg(0);if(!f.read(reinterpret_cast<char*>(bytes.data()),n))throw std::runtime_error("Cannot read complete state file");return bytes;
    }
    bool applyLoaded(const std::vector<uint8_t>& data){
        if(!check(jp8000_load_state(core_,data.data(),data.size()))){operation_="error";operationError_=status_;return false;}
        changed();epoch_.fetch_add(1);qualificationPending_=true;qualified_.store(false);primed_.store(0);resampler_.reset();operation_="loading";operationError_.clear();return true;
    }
    bool queueIO(IOJob job){
        std::lock_guard<std::mutex> lock(ioMutex_);
        if(!job.visible&&!job.load){for(auto& old:ioJobs_)if(!old.visible&&!old.load&&old.path==job.path){old=std::move(job);return true;}}
        if(ioJobs_.size()>=8)return false;ioJobs_.push_back(std::move(job));return true;
    }
    bool captureSave(const std::string& path,bool visible){
        const size_t size=jp8000_save_state(core_,nullptr,0);if(!size)return false;
        if(size>4*1024*1024){if(visible){operation_="error";operationError_="State exceeds size limit";}return false;}
        std::vector<uint8_t> data(size);if(jp8000_save_state(core_,data.data(),size)!=size)return false;
        return queueIO({false,visible,path,std::move(data),operationID_});
    }
    void runIO(){
        for(;;){
            IOJob job;bool have=false;
            {std::lock_guard<std::mutex> lock(ioMutex_);if(!ioJobs_.empty()){job=std::move(ioJobs_.front());ioJobs_.erase(ioJobs_.begin());have=true;}}
            if(!have){if(ioQuit_.load())return;std::this_thread::sleep_for(std::chrono::milliseconds(2));continue;}
            IOResult result;result.load=job.load;result.visible=job.visible;result.operation=job.operation;
            try{
#ifdef JP8000_HOST_TEST_IO_DELAY_MS
                std::this_thread::sleep_for(std::chrono::milliseconds(JP8000_HOST_TEST_IO_DELAY_MS));
#endif
                if(job.load)result.bytes=readFile(job.path);
                else{
                    const auto dest=std::filesystem::path(job.path);std::filesystem::create_directories(dest.parent_path());
                    const auto temporary=dest.string()+".tmp";std::ofstream f(temporary,std::ios::binary|std::ios::trunc);
                    if(!f||!f.write(reinterpret_cast<const char*>(job.bytes.data()),std::streamsize(job.bytes.size())))throw std::runtime_error("Cannot write state file");
                    f.flush();if(!f)throw std::runtime_error("Cannot flush state file");f.close();std::filesystem::rename(temporary,dest);
                }
                result.ok=true;
            }catch(const std::exception& e){result.error=e.what();}
            {std::lock_guard<std::mutex> lock(ioMutex_);ioResults_.push_back(std::move(result));}
        }
    }
    void publish(){
        const auto started=std::chrono::steady_clock::now();
        std::string native="{}";
        if(core_){const auto n=jp8000_snapshot_json(core_,nullptr,0);if(n&&n<1024*1024){std::vector<char> data(n);if(jp8000_snapshot_json(core_,data.data(),n)==n)native=data.data();}}
        const auto end=native.find_last_of('}');if(end==std::string::npos)native="{";else native.resize(end);
        if(!nativeStats_.state_syncing&&(appliedPartVersion_==partVersion_.load()||failedPartVersion_.load()==partVersion_.load())){
            const auto actual=jp8000_detail::jsonValue(jp8000_detail::jsonValue(native,"params_upper","{}"),"2018");
            if(actual=="0"||actual=="1"||actual=="2")part_.store(uint32_t(actual[0]-'0'));
        }
        const uint32_t part=part_.load();const auto upper=jp8000_detail::jsonValue(native,"upper_name","\"\"");const auto lower=jp8000_detail::jsonValue(native,"lower_name","\"\"");
        std::string name=part==1?lower:upper;if(part==2&&upper.size()>1&&lower.size()>1)name=upper.substr(0,upper.size()-1)+" / "+lower.substr(1);
        const auto params=jp8000_detail::jsonValue(native,part==1?"params_lower":"params_upper","{}");
        for(const char* key:{"ready","part","params"})jp8000_detail::removeJSONMember(native,key);
        if(native.size()>1)native+=',';
        native+="\"ready\":"+std::string(ready()?"true":"false")+",\"part\":"+std::to_string(part)+",\"params\":"+params+",\"patch_name\":"+name;
        native+=",\"status\":"+jp8000_detail::quote(status_)+",\"operation_status\":"+jp8000_detail::quote(operation_)+",\"operation_error\":"+jp8000_detail::quote(operationError_);
        native+=",\"operation_id\":"+std::to_string(operationID_)+",\"autosave_error\":"+jp8000_detail::quote(autosaveError_);
        native+=",\"realtime_factor\":"+std::to_string(speed_.load())+",\"ring_frames\":"+std::to_string(queuedFrames())+",\"callback_frames\":"+std::to_string(callbackFrames_.load());
        native+=",\"snapshot_max_us\":"+std::to_string(snapshotMaxUs_);
        native+=",\"underruns\":"+std::to_string(underflows_.load())+",\"missing_frames\":"+std::to_string(missingFrames_.load())+",\"dropped_commands\":"+std::to_string(dropped_.load())+",\"resampler_delay_ms\":0.719955}";
        {std::lock_guard<std::mutex> lock(snapshotMutex_);snapshot_=std::move(native);}lastSnapshot_=std::chrono::steady_clock::now();snapshotMaxUs_=std::max(snapshotMaxUs_,std::chrono::duration<double,std::micro>(lastSnapshot_-started).count());
    }
    void run(){
#if defined(__APPLE__)
        pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE,0);
#endif
        try{
            char error[1024]{};core_=jp8000_create(rom_.c_str(),baseline_.c_str(),error,sizeof(error));
            if(!core_)throw std::runtime_error(error[0]?error:"Firmware startup failed");
            if(jp8000_native_sample_rate()!=88200)throw std::runtime_error("Unexpected native sample rate");
            const std::string automatic=(std::filesystem::path(directory_)/"auto-last-state.syx").string();
            if(std::filesystem::exists(automatic)){try{applyLoaded(readFile(automatic));}catch(const std::exception& e){operation_="error";operationError_=e.what();}}
            std::string pendingSave;auto saveDeadline=std::chrono::steady_clock::time_point{};
            bool loading=operation_=="loading";
            qualify();publish();
            while(!quit_.load()){
                const auto now=std::chrono::steady_clock::now();const uint64_t epoch=epoch_.load();
                if(epoch!=localEpoch_){localEpoch_=epoch;epochStart_=write_.load();jp8000_panic(core_);panicPending_.store(false);for(unsigned i=0;i<pressed_.size();++i)if(pressed_[i])jp8000_panel(core_,i,0);pressed_.reset();resampler_.reset();primed_.store(0);
                    // Drain the emulated MIDI serial stream before accepting a new active epoch.
                    // This makes all-sound-off reach firmware before newly rendered audio is exposed.
                    std::array<float,1024> l{},r{};for(unsigned i=0;i<8&&!quit_.load();++i)check(jp8000_render(core_,l.data(),r.data(),1024));refreshStats();
                }
                processCommands();
                std::vector<Job> jobs;{std::lock_guard<std::mutex> lock(jobsMutex_);jobs.swap(jobs_);}
                for(const auto& job:jobs){flushParameters(true);++operationID_;operationError_.clear();if(job.load){operation_="loading";loading=false;loadOperation_=operationID_;loadReading_=true;qualificationPending_=true;qualified_.store(false);primed_.store(0);if(!queueIO({true,true,job.path,{},operationID_})){loadReading_=false;operation_="error";operationError_="Persistence queue is full";}}else{pendingSave=job.path;operation_="saving";saveDeadline=now+std::chrono::seconds(10);}}
                std::vector<IOResult> results;{std::lock_guard<std::mutex> lock(ioMutex_);results.swap(ioResults_);}
                for(auto& result:results){
                    if(!result.visible){autosaveError_=result.error;if(!result.ok){dirty_=true;lastChange_=now;}continue;}
                    if(result.load){
                        if(result.operation!=loadOperation_)continue;
                        loadReading_=false;
                        if(!result.ok){operation_="error";operationError_=result.error;continue;}
                        const auto previous=operation_;loading=applyLoaded(result.bytes);loadingOperation_=result.operation;
                        if(loading&&result.operation!=operationID_)operation_=previous;
                    }else if(result.operation==operationID_){operation_=result.ok?"saved":"error";operationError_=result.error;}
                }
                if(persistenceRejected_.exchange(0)){++operationID_;operation_="error";operationError_="Persistence request queue is full";}
                refreshStats();
                if(loading&&!nativeStats_.state_syncing&&nativeStats_.ready){loading=false;if(loadingOperation_==operationID_)operation_="loaded";}
                if(!pendingSave.empty()&&!loadReading_&&!loading){
                    if(captureSave(pendingSave,true)||operation_=="error")pendingSave.clear();
                    else if(now>saveDeadline){pendingSave.clear();operation_="error";operationError_="Firmware state readback did not complete";}
                }
                if(dirty_&&!loadReading_&&!loading&&!nativeStats_.state_syncing&&nativeStats_.ready&&now-lastChange_>std::chrono::milliseconds(750)){if(captureSave(automatic,false))dirty_=false;}
                const bool needsState=nativeStats_.state_syncing||!pendingSave.empty()||loading;
                if(!loadReading_&&!qualified_.load()&&(active_.load()||needsState||qualificationPending_)&&now-lastQualification_>std::chrono::milliseconds(200))qualify();
                bool produced=false;
                if(active_.load()&&qualified_.load()){
                    const uint64_t w=write_.load(std::memory_order_relaxed),r=read_.load(std::memory_order_acquire);const uint32_t target=targetFrames_.load();
                    if(w-std::max(r,epochStart_)<target&&w-r<RingCapacity-64){
                        for(unsigned i=0;i<32&&!quit_.load()&&epoch_.load()==localEpoch_;++i){
                            if(!resampler_.available()&&!renderNative())throw std::runtime_error(status_);
                            if(!qualified_.load())break;
                            const auto at=write_.load(std::memory_order_relaxed);ring_[at&(RingCapacity-1)]={resampler_.next(),localEpoch_};write_.store(at+1,std::memory_order_release);produced=true;
                        }
                    }
                    if(write_.load()-std::max(read_.load(),epochStart_)>=target&&qualified_.load())primed_.store(localEpoch_,std::memory_order_release);
                }else if(needsState){std::array<float,512> l{},r{};check(jp8000_render(core_,l.data(),r.data(),512));refreshStats();}
                if(now-lastSnapshot_>=std::chrono::milliseconds(100)&&(!active_.load()||!qualified_.load()||write_.load()-std::max(read_.load(),epochStart_)>=targetFrames_.load()))publish();
                if(!produced)std::this_thread::sleep_for(active_.load()?std::chrono::microseconds(100):std::chrono::microseconds(2000));
            }
            jp8000_panic(core_);if(dirty_)captureSave(automatic,false);
        }catch(const std::exception& e){status_=e.what();qualified_.store(false);publish();}
        if(core_){jp8000_destroy(core_);core_=nullptr;}
    }
};
