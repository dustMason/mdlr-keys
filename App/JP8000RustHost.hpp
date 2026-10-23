#pragma once
#include "JP8000Host.hpp" // Existing bounded MPSC queue and parameter metadata.
#include "JP8000RustABI.h"
#include <mach/mach_time.h>

namespace jp8000_rust_detail {
// Causal88.2k->48k conversion:128 native history samples, no future samples or
// producer queue. Nominal group delay63.5/88200=0.720ms. Coefficients are built
// before audio starts; all callback work and storage are bounded.
class Resampler {
    static constexpr unsigned Taps=128,Phases=80;
    std::array<std::array<float,Taps>,Phases> coefficients_{};
    std::array<jp8000_detail::Stereo,Taps> history_{};
    uint64_t written_=0;
    static double i0(double x){double s=1,t=1;for(unsigned k=1;k<40;++k){t*=x*x/(4.0*k*k);s+=t;if(t<1e-15*s)break;}return s;}
public:
    Resampler(){
        constexpr double pi=3.14159265358979323846,cutoff=21500.0/88200,beta=7.5;
        const double denom=i0(beta);
        for(unsigned p=0;p<Phases;++p){double total=0;
            for(unsigned t=0;t<Taps;++t){
                const double x=double(t)+double(p)/Phases-63.5,a=x/64.0;
                const double window=std::abs(a)<=1?i0(beta*std::sqrt(std::max(0.0,1-a*a)))/denom:0;
                const double sinc=std::abs(x)<1e-12?2*cutoff:std::sin(2*pi*cutoff*x)/(pi*x);
                total+=(coefficients_[p][t]=float(window*sinc));
            }
            for(auto& c:coefficients_[p])c=float(c/total);
        }
    }
    void reset() noexcept {written_=0;history_.fill({});}
    uint64_t written() const noexcept{return written_;}
    void append(float l,float r) noexcept{history_[written_++&(Taps-1)]={l,r};}
    jp8000_detail::Stereo at(uint64_t phase) const noexcept{
        const uint64_t base=phase/Phases;const auto& c=coefficients_[phase%Phases];jp8000_detail::Stereo out{};
        for(unsigned t=0;t<Taps&&t<=base;++t){const auto& x=history_[(base-t)&(Taps-1)];out.l+=x.l*c[t];out.r+=x.r*c[t];}
        return out;
    }
};
}

// A separate, explicitly experimental backend. The audio callback is the only
// Rust-state owner. Producers enqueue commands; snapshots use atomic mirrors.
// There are no firmware inputs, files, background workers, or audio prequeue.
class JP8000RustHost {
public:
    JP8000RustHost():core_(mdlr_jp8000_rust_create()){
        mach_timebase_info_data_t timebase{};mach_timebase_info(&timebase);
        hostTicksToFrames_=double(timebase.numer)/double(timebase.denom)*48000.0/1e9;
        if(!core_)throw std::runtime_error("Cannot create experimental Rust JP-8000");
        for(const auto& p:jp8000_detail::Parameters){
            capability_[p.id]=mdlr_jp8000_rust_parameter_capability(uint16_t(p.id));
            for(unsigned part=0;part<2;++part){
                const auto value=readParameter(part,p.id);
                parameters_[part][p.id].store(value,std::memory_order_relaxed);
            }
        }
        for(unsigned i=0;i<waveforms_.size();++i)waveforms_[i]=mdlr_jp8000_rust_supported_waveform(uint16_t(i))>0;
    }
    ~JP8000RustHost(){mdlr_jp8000_rust_destroy(core_);}
    JP8000RustHost(const JP8000RustHost&)=delete;
    JP8000RustHost& operator=(const JP8000RustHost&)=delete;
    void setActive(bool value) noexcept{if(active_.exchange(value)!=value)epoch_.fetch_add(1,std::memory_order_acq_rel);}
    bool midi(uint8_t s,uint8_t a,uint8_t b,uint32_t offset=0) noexcept{
        if(a>127||b>127||offset>48000*10u)return reject(1,s);
        return push({Midi,s,a,b,offset,epoch_.load(std::memory_order_acquire)});
    }
    // Touch gestures share the existing ordered queue with parameter edits.
    // Resolve channels only on the audio owner, after earlier edits commit or
    // reject. This avoids routing from an optimistic or stale UI snapshot.
    bool touchMidi(uint8_t s,uint8_t a,uint8_t b) noexcept{
        if(a>127||b>127||(s!=0x80&&s!=0x90&&!(s==0xb0&&a==64)))return reject(1,s);
        return push({TouchMidi,s,a,b,0,epoch_.load(std::memory_order_acquire)});
    }
    bool midiAtHostTime(uint8_t s,uint8_t a,uint8_t b,uint64_t time) noexcept{
        if(!time)return midi(s,a,b);
        if(a>127||b>127)return reject(1,s);
        return push({TimedMidi,uint32_t(s)|(uint32_t(a)<<8)|(uint32_t(b)<<16),uint32_t(time),uint32_t(time>>32),0,epoch_.load(std::memory_order_acquire)});
    }
    // Selected-panel edits capture their part when queued, just like the firmware
    // host. Explicit scoped APIs are preferable for independent control producers.
    bool parameter(uint32_t id,uint32_t value) noexcept{
        if(id==2018)return requestPart(value);
        if(!validParameter(id,value))return false;
        if(id>=2000)return push({Parameter,id,value,0,0,0});
        SelectionGuard guard(selectionProducer_);
        if(!guard.acquired)return reject(7,id);
        const auto selection=selection_.load(std::memory_order_acquire);
        if((selection&3)==3)return reject(7,id);
        return push({Parameter,id,value,uint32_t(selection&3),0,selection});
    }
    bool partParameter(uint32_t part,uint32_t id,uint32_t value) noexcept{
        if(part>2||id>=2000)return reject(1,id);
        if(!validParameter(id,value))return false;
        return push({Parameter,id,value,part,0,0});
    }
    // Legacy imports remain Upper/common, independent of the selected panel.
    bool applyPatch(const uint16_t* ids,const uint16_t* values,uint32_t count) noexcept{
        if(count>256||(!ids&&count)||(!values&&count))return reject(1,0);
        std::array<uint16_t,256> pi{},pv{},ci{},cv{};uint32_t np=0,nc=0;
        for(uint32_t i=0;i<count;++i){
            if(ids[i]<2000){pi[np]=ids[i];pv[np++]=values[i];}
            else {ci[nc]=ids[i];cv[nc++]=values[i];}
        }
        return applyPerformance(pi.data(),pv.data(),np,nullptr,nullptr,0,ci.data(),cv.data(),nc);
    }
    // Immutable bounded slots. Producers publish only after all three scope
    // copies are complete; the callback commits or rejects the whole transaction.
    bool applyPerformance(const uint16_t* upperIDs,const uint16_t* upperValues,uint32_t upperCount,
                          const uint16_t* lowerIDs,const uint16_t* lowerValues,uint32_t lowerCount,
                          const uint16_t* commonIDs,const uint16_t* commonValues,uint32_t commonCount) noexcept{
        const uint16_t* ids[]={upperIDs,lowerIDs,commonIDs};
        const uint16_t* values[]={upperValues,lowerValues,commonValues};
        const uint32_t counts[]={upperCount,lowerCount,commonCount};
        uint32_t requestedPart=3;
        for(unsigned scope=0;scope<3;++scope){
            if(counts[scope]>256||(!ids[scope]&&counts[scope])||(!values[scope]&&counts[scope]))return reject(1,0);
            for(uint32_t j=0;j<counts[scope];++j){const auto id=ids[scope][j];
                if(id>=capability_.size()||capability_[id]==0||(scope==2)!=(id>=2000))return reject(1,id);
                if(scope==2&&id==2018){requestedPart=values[scope][j];if(requestedPart>2)return reject(1,id);}
            }
        }
        if(!(upperCount|lowerCount|commonCount))return true;
        for(uint32_t i=0;i<patches_.size();++i){bool expected=false;
            if(!patches_[i].busy.compare_exchange_strong(expected,true,std::memory_order_acquire))continue;
            auto& patch=patches_[i];patch.selectionStamp=0;
            for(unsigned scope=0;scope<3;++scope){auto& data=patch.scopes[scope];data.count=counts[scope];
                if(data.count){std::copy_n(ids[scope],data.count,data.ids.begin());std::copy_n(values[scope],data.count,data.values.begin());}
            }
            SelectionGuard guard(selectionProducer_,requestedPart<3);
            if(!guard.acquired){patch.busy.store(false,std::memory_order_release);return reject(7,2018);}
            uint64_t previous=0;
            if(requestedPart<3){selectionsOutstanding_.fetch_add(1,std::memory_order_acq_rel);patch.selectionStamp=reserveSelection(requestedPart,previous);}
            if(push({Patch,i,0,0,0,epoch_.load(std::memory_order_acquire)}))return true;
            if(patch.selectionStamp){rollbackSelection(patch.selectionStamp,previous);selectionsOutstanding_.fetch_sub(1,std::memory_order_acq_rel);}
            patch.busy.store(false,std::memory_order_release);return false;
        }
        return reject(6,0);
    }
    void setPart(uint32_t part) noexcept{requestPart(part);}
    bool factoryPatch(uint32_t) noexcept{return reject(3,1001);}
    bool factoryPerformance(uint32_t) noexcept{return reject(3,2016);}
    bool panel(uint32_t id,bool) noexcept{return reject(3,id);}
    void saveState(std::string){reject(3,0);}
    void loadState(std::string){reject(3,0);}
    void panic() noexcept{epoch_.fetch_add(1,std::memory_order_acq_rel);}
    void setMasterVolume(float value) noexcept{if(std::isfinite(value))volume_.store(std::clamp(value,0.0f,2.0f));}
    void setMono(bool value) noexcept{mono_.store(value);}
    void setVelocitySensitive(bool value) noexcept{velocity_.store(value);}
    bool ready() const noexcept{return core_!=nullptr;}
    float peak() const noexcept{return peak_.load();}
    uint32_t droppedEvents() const noexcept{return dropped_.load();}
    uint64_t underflows() const noexcept{return 0;}
    uint32_t queuedFrames() const noexcept{return 0;}
    void render48k(float* left,float* right,uint32_t frames,uint64_t hostTime=0) noexcept{
        if(!left||!right)return;
        callbackFrames_.store(frames,std::memory_order_relaxed);
        controlsRemaining_=ControlBudget;
        const auto epoch=epoch_.load(std::memory_order_acquire);
        if(epoch!=renderEpoch_){renderEpoch_=epoch;clearPending(true);hostFrame_=generated_=0;nativeAt_=nativeCount_=0;resampler_.reset();mdlr_jp8000_rust_silence(core_);}
        drain(epoch,hostTime,frames!=0||!active_.load(std::memory_order_acquire));
        if(!active_.load(std::memory_order_acquire)){
            processDue((hostFrame_*147+79)/80);
            std::fill_n(left,frames,0);std::fill_n(right,frames,0);peak_.store(0);return;
        }
        const float volume=volume_.load(std::memory_order_relaxed),mono=mono_.load()?1.0f:0.0f;
        float peak=0;
        const uint64_t requiredNative=frames?((hostFrame_+frames-1)*147)/80+1:resampler_.written();
        for(uint32_t i=0;i<frames;++i){
            const uint64_t phase=hostFrame_*147;
            while(resampler_.written()<=phase/80){
                if(nativeAt_==nativeCount_){
                    processDue(generated_);
                    uint64_t count=std::min<uint64_t>(64,requiredNative-generated_);
                    // A due control can remain blocked by this callback's budget.
                    // Generate current-state audio rather than a zero-size chunk.
                    if(pendingCount_&&pending_[0].frame>generated_)count=std::min(count,pending_[0].frame-generated_);
                    nativeCount_=uint32_t(count);nativeAt_=0;
                    if(mdlr_jp8000_rust_render(core_,nativeLeft_.data(),nativeRight_.data(),nativeCount_)!=0){error_.store(5);nativeLeft_.fill(0);nativeRight_.fill(0);}
                    generated_+=nativeCount_;
                }
                resampler_.append(nativeLeft_[nativeAt_],nativeRight_[nativeAt_]);++nativeAt_;
            }
            auto sample=resampler_.at(phase);++hostFrame_;
            gain_+=(volume-gain_)*(1.0f/240);monoGain_+=(mono-monoGain_)*(1.0f/240);
            sample.l*=gain_;sample.r*=gain_;const float center=(sample.l+sample.r)*0.5f;
            left[i]=sample.l+(center-sample.l)*monoGain_;right[i]=sample.r+(center-sample.r)*monoGain_;
            peak=std::max(peak,std::max(std::abs(left[i]),std::abs(right[i])));
        }
        if(epoch_.load(std::memory_order_acquire)!=epoch){std::fill_n(left,frames,0);std::fill_n(right,frames,0);peak=0;}
        peak_.store(peak,std::memory_order_relaxed);
    }
    std::string snapshotJSON() const{
        for(unsigned attempt=0;attempt<4;++attempt){
            const auto revision=revision_.load(std::memory_order_acquire);if(revision&1)continue;
            Snapshot values{};
            for(unsigned part=0;part<2;++part)for(const auto& p:jp8000_detail::Parameters)
                values[part][p.id]=parameters_[part][p.id].load(std::memory_order_acquire);
            std::atomic_thread_fence(std::memory_order_acquire);
            if(revision==revision_.load(std::memory_order_relaxed))return makeSnapshot(values);
        }
        return "{\"ready\":true,\"backend\":\"rust-experimental\",\"state_syncing\":true,\"status\":\"Updating controls\"}";
    }
private:
    using Snapshot=std::array<std::array<int32_t,4096>,2>;
    std::string makeSnapshot(const Snapshot& values) const{
        std::array<std::string,2> params={"{","{"};std::string ids="[",waves="[";
        bool firstID=true,firstWave=true;std::array<bool,2> first={true,true};
        for(const auto& p:jp8000_detail::Parameters){
            if(capability_[p.id]==1){if(!firstID)ids+=',';firstID=false;ids+=std::to_string(p.id);}
            for(unsigned part=0;part<2;++part){const auto value=values[part][p.id];if(value<0)continue;
                if(!first[part])params[part]+=',';first[part]=false;
                params[part]+=jp8000_detail::quote(std::to_string(p.id))+':'+std::to_string(value);
            }
        }
        for(auto& p:params)p+='}';ids+=']';
        for(unsigned i=0;i<waveforms_.size();++i)if(waveforms_[i]){if(!firstWave)waves+=',';firstWave=false;waves+=std::to_string(i);}waves+=']';
        // Feature coverage comes from the same Rust predicates as final-state
        // validation. Keep unsupported current enum values in params unchanged.
        std::string enumValues="{";bool firstEnum=true;
        for(const auto& p:jp8000_detail::Parameters)if(p.id==2024||p.id==2025){
            if(!firstEnum)enumValues+=',';firstEnum=false;
            enumValues+=jp8000_detail::quote(std::to_string(p.id))+":";enumValues+='[';
            bool firstValue=true;for(unsigned v=p.min;v<=p.max;++v)
                if(mdlr_jp8000_rust_parameter_value_capability(uint16_t(p.id),uint16_t(v))==1){
                    if(!firstValue)enumValues+=',';firstValue=false;enumValues+=std::to_string(v);
                }
            enumValues+=']';
        }
        enumValues+='}';
        const auto error=error_.load();
        const std::string status=error==0?"Experimental Rust · supported controls only":error==3?"Unavailable in experimental Rust: firmware banks, panel buttons and SysEx persistence":error==4?"Command overflow: notes cleared":error==5?"Rust rendering failed":error==6?"Patch queue full: transaction rejected":error==7?"Panel edit deferred or concurrent; retry":error==2&&rejectedID_.load()==3009?"Remote MIDI routing is unchanged while inputs are active":"Unsupported control or MIDI message rejected";
        const auto part=std::clamp(values[0][2018],0,2);
        return "{\"ready\":true,\"state_syncing\":false,\"backend\":\"rust-experimental\",\"firmware_required\":false,\"part\":"+std::to_string(part)+",\"supported_edit_parts\":[0,1,2],\"voice_count\":8,\"lcd\":[\"JP-8000 RUST\",\"EXPERIMENTAL\"],\"patch_name\":\"Rust init\",\"upper_name\":\"Rust init\",\"lower_name\":\"Rust init\",\"params\":"+params[part==1?1:0]+",\"params_upper\":"+params[0]+",\"midi_channels\":["+std::to_string(values[0][1002])+","+std::to_string(values[1][1002])+"],\"params_lower\":"+params[1]+",\"supported_parameter_ids\":"+ids+",\"supported_parameter_values\":"+enumValues+",\"supported_waveforms\":"+waves+",\"status\":"+jp8000_detail::quote(status)+",\"operation_status\":\"idle\",\"operation_error\":\"\",\"rejected_id\":"+std::to_string(rejectedID_.load())+",\"rejected_commands\":"+std::to_string(rejected_.load())+",\"dropped_commands\":"+std::to_string(dropped_.load())+",\"callback_frames\":"+std::to_string(callbackFrames_.load())+",\"ring_frames\":0,\"underruns\":0,\"resampler_delay_ms\":0.719955,\"native_sample_rate\":88200,\"host_sample_rate\":48000}";
    }

private:
    enum Kind:uint32_t{Midi,Parameter,Patch,TimedMidi,SelectPart,TouchMidi};
    static bool isMidi(uint32_t kind) noexcept{return kind==Midi||kind==TouchMidi;}
    struct TouchRoute {uint16_t channels=0;bool held=false,remote=false;};
    // Audio-owner-only storage. Off events use their original channels even
    // after Arp/part selection changes; duplicates never overwrite the origin.
    std::array<TouchRoute,128> touchNotes_{};
    TouchRoute touchSustain_{};
    // A fail-fast producer guard makes selection reservation/publication and
    // implicit selected-panel edits indivisible. It never spins or blocks, and
    // the audio consumer never acquires it. Explicit scopes and MIDI bypass it.
    struct SelectionGuard{
        std::atomic_flag& flag;bool enabled,acquired;
        explicit SelectionGuard(std::atomic_flag& f,bool use=true) noexcept
            :flag(f),enabled(use),acquired(!use||!f.test_and_set(std::memory_order_acquire)){}
        ~SelectionGuard(){if(enabled&&acquired)flag.clear(std::memory_order_release);}
    };
    struct ScopeData{uint32_t count=0;std::array<uint16_t,256> ids{},values{};};
    struct PatchData{std::atomic<bool> busy{false};uint64_t selectionStamp=0;std::array<ScopeData,3> scopes{};};
    struct Pending{uint64_t frame=0,sequence=0;jp8000_detail::Command command{};};
    static bool later(const Pending& a,const Pending& b) noexcept{return a.frame!=b.frame?a.frame>b.frame:a.sequence>b.sequence;}
    double hostTicksToFrames_=0;
    void* core_=nullptr;
    std::array<PatchData,8> patches_{};
    std::atomic<uint64_t> revision_{0};
    std::array<std::array<std::atomic<int32_t>,4096>,2> parameters_{};
    // Producer selection is versioned so a rejected older request cannot roll
    // back a newer UI selection. Snapshots always report committed core state.
    std::atomic<uint64_t> selection_{0},selectionGeneration_{0},failedSelection_{0};
    std::atomic<uint32_t> selectionsOutstanding_{0};
    uint64_t committedSelection_=0; // Audio-consumer only.
    std::atomic_flag selectionProducer_=ATOMIC_FLAG_INIT;
    std::array<int32_t,4096> capability_{};
    std::array<bool,7> waveforms_{};
    jp8000_detail::Queue<2048> commands_;
    std::array<Pending,2048> pending_{};size_t pendingCount_=0;
    static constexpr unsigned ControlBudget=256;
    unsigned controlsRemaining_=ControlBudget; // One shared budget per callback.
    jp8000_rust_detail::Resampler resampler_;
    uint64_t hostFrame_=0,renderEpoch_=0,generated_=0,eventSequence_=0;
    std::array<float,64> nativeLeft_{},nativeRight_{};uint32_t nativeAt_=0,nativeCount_=0;
    std::atomic<uint64_t> epoch_{1};
    std::atomic<bool> active_{false},mono_{false},velocity_{true},overflow_{false};
    std::atomic<float> volume_{0.65f},peak_{0};float gain_=0.65f,monoGain_=0;
    std::atomic<uint32_t> error_{0},rejectedID_{0},rejected_{0},dropped_{0},callbackFrames_{0};
    bool reject(uint32_t error,uint32_t id) noexcept{rejectedID_.store(id);rejected_.fetch_add(1);error_.store(error);return false;}
    bool push(jp8000_detail::Command c) noexcept{
        if(commands_.push(c))return true;dropped_.fetch_add(1);overflow_.store(true,std::memory_order_release);return false;
    }
    void drain(uint64_t epoch,uint64_t hostTime,bool serviceDue) noexcept{
        if(overflow_.exchange(false)){epoch_.fetch_add(1,std::memory_order_acq_rel);mdlr_jp8000_rust_silence(core_);clearPending(true);error_.store(4);return;}
        // Make room for newly queued commands before admission. Active zero-
        // frame calls retain their existing admission-only behavior.
        if(serviceDue)processDue(generated_);
        // A full retained/due-control heap must drain before admitting a new
        // suffix. In particular, zero-frame recovery cannot discard accepted
        // selections or transactions merely because it has no commit budget.
        // A heap blocked solely by future MIDI retains its existing overflow
        // policy; this does not hide the previous dropped-selection regressions.
        const bool controlBacklog=pendingCount_&&!isMidi(pending_[0].command.kind);
        jp8000_detail::Command c;
        for(unsigned n=0;n<256;++n){
            if(controlBacklog&&pendingCount_==pending_.size())break;
            if(!commands_.pop(c))break;
            if((isMidi(c.kind)||c.kind==TimedMidi)&&c.epoch!=epoch)continue;
            if(c.kind==TimedMidi){
                const uint64_t timestamp=uint64_t(c.b)|(uint64_t(c.c)<<32);
                const double offset=hostTime&&timestamp>hostTime?double(timestamp-hostTime)*hostTicksToFrames_:0;
                if(offset>48000*10.0){reject(1,c.a&255);continue;}
                c={Midi,c.a&255,(c.a>>8)&127,(c.a>>16)&127,uint32_t(std::llround(offset)),c.epoch};
            }
            if(pendingCount_==pending_.size()){retireDroppedControl(c);dropped_.fetch_add(1);overflow_.store(true);continue;}
            const uint64_t frame=((hostFrame_+c.d)*147+79)/80;
            pending_[pendingCount_++]={frame,eventSequence_++,c};
            std::push_heap(pending_.begin(),pending_.begin()+pendingCount_,later);
        }
    }
    void processDue(uint64_t nativeFrame) noexcept{
        while(pendingCount_&&pending_[0].frame<=nativeFrame){
            const auto c=pending_[0].command;
            // Preserve the entire due-event suffix: later MIDI, selections and
            // transactions cannot overtake a deferred control.
            if(!isMidi(c.kind)&&!controlsRemaining_)break;
            std::pop_heap(pending_.begin(),pending_.begin()+pendingCount_,later);--pendingCount_;
            if(c.kind==TouchMidi){processTouch(c);}
            else if(c.kind==Midi){
                uint8_t velocity=uint8_t(c.c);if((c.a&0xf0)==0x90&&velocity&&!velocity_.load(std::memory_order_relaxed))velocity=127;
                if(mdlr_jp8000_rust_midi(core_,uint8_t(c.a),uint8_t(c.b),velocity)!=0)reject(2,c.a);
            }else {--controlsRemaining_;applyControl(c);}
        }
        settleSelection();
    }
    TouchRoute resolveTouchRoute() const noexcept{
        TouchRoute route{};route.held=true;
        // Virtual Remote input makes Arp playable even when external Remote
        // MIDI is Off. All/Off and concrete MIDI channel settings stay intact.
        if(readParameter(0,2023)==1){route.remote=true;return route;}
        const auto selected=readParameter(0,2018);
        for(unsigned part=0;part<2;++part)if(selected==2||selected==int32_t(part)){
            const auto channel=readParameter(part,1002);
            if(channel>=0&&channel<16)route.channels|=uint16_t(1u<<channel);
        }
        return route;
    }
    void processTouch(const jp8000_detail::Command& c) noexcept{
        const bool pedal=c.a==0xb0;
        const bool down=pedal?c.c>=64:c.a==0x90&&c.c!=0;
        auto& route=pedal?touchSustain_:touchNotes_[c.b];
        if(down==route.held)return;
        if(down)route=resolveTouchRoute();
        uint8_t value=down?uint8_t(c.c):0;
        if(!pedal&&down&&!velocity_.load(std::memory_order_relaxed))value=127;
        if(route.remote){
            const uint8_t status=pedal?0xb0:down?0x90:0x80;
            if(mdlr_jp8000_rust_remote_touch(core_,status,uint8_t(c.b),value)!=0)reject(2,status);
        }
        for(unsigned channel=0;channel<16;++channel)if(route.channels&(1u<<channel)){
            const uint8_t status=uint8_t((pedal?0xb0:down?0x90:0x80)|channel);
            if(mdlr_jp8000_rust_midi(core_,status,uint8_t(c.b),value)!=0)reject(2,status);
        }
        if(!down)route={};
    }
    int32_t readParameter(unsigned part,uint32_t id) const noexcept{
        return id<2000?mdlr_jp8000_rust_get_part_parameter(core_,uint8_t(part),uint16_t(id))
                      :mdlr_jp8000_rust_get_parameter(core_,uint16_t(id));
    }
    bool validParameter(uint32_t id,uint32_t value) noexcept{
        if(id>=capability_.size()||capability_[id]!=1||value>65535)return reject(1,id);
        for(const auto& p:jp8000_detail::Parameters)if(p.id==id){
            if(value<p.min||value>p.max||(id==30&&!waveforms_[value])
               ||mdlr_jp8000_rust_parameter_value_capability(uint16_t(id),uint16_t(value))!=1)return reject(1,id);
            return true;
        }
        return reject(1,id);
    }
    uint64_t reserveSelection(uint32_t part,uint64_t& previous) noexcept{
        previous=selection_.load(std::memory_order_acquire);
        for(;;){const auto stamp=(selectionGeneration_.fetch_add(4,std::memory_order_relaxed)+4)|part;
            if(selection_.compare_exchange_weak(previous,stamp,std::memory_order_acq_rel))return stamp;
        }
    }
    bool requestPart(uint32_t part) noexcept{
        if(part>2)return reject(1,2018);
        if(!validParameter(2018,part))return false;
        SelectionGuard guard(selectionProducer_);if(!guard.acquired)return reject(7,2018);
        selectionsOutstanding_.fetch_add(1,std::memory_order_acq_rel);
        uint64_t previous=0;auto stamp=reserveSelection(part,previous);
        if(push({SelectPart,part,0,0,0,stamp}))return true;
        rollbackSelection(stamp,previous);selectionsOutstanding_.fetch_sub(1,std::memory_order_acq_rel);return false;
    }
    void failedSelection(uint64_t stamp) noexcept{
        if(!stamp)return;
        // Keep the newest failure for producer rollback. Older pending commands
        // may fail after a newer request was dropped while the heap was full.
        auto failed=failedSelection_.load(std::memory_order_acquire);
        while(failed<stamp&&!failedSelection_.compare_exchange_weak(failed,stamp,std::memory_order_acq_rel)){}
        auto expected=stamp;
        selection_.compare_exchange_strong(expected,(selectionGeneration_.fetch_add(4,std::memory_order_relaxed)+4)|3);
    }
    void rollbackSelection(uint64_t stamp,uint64_t previous) noexcept{
        selection_.compare_exchange_strong(stamp,previous);
        // A consumer can retire the predecessor while this producer holds its
        // newer reservation. Leave repair to the consumer after all queued
        // selections have retired; committed state may still have a predecessor.
        if(previous&&failedSelection_.load(std::memory_order_acquire)==previous){
            auto expected=previous;
            selection_.compare_exchange_strong(expected,(selectionGeneration_.fetch_add(4,std::memory_order_relaxed)+4)|3);
        }
    }
    void settleSelection() noexcept{
        if(selectionsOutstanding_.load(std::memory_order_acquire))return;
        auto expected=selection_.load(std::memory_order_acquire);
        if((expected&3)!=3)return;
        // Reuse the identity of the successful predecessor, not the rejected
        // request. Its already queued dependent edits remain valid. New user
        // selections always receive a fresh monotonic generation.
        selection_.compare_exchange_strong(expected,committedSelection_);
    }
    void retireSelection(uint64_t stamp) noexcept{
        if(stamp)selectionsOutstanding_.fetch_sub(1,std::memory_order_acq_rel);
        settleSelection();
    }
    void retireDroppedControl(const jp8000_detail::Command& c) noexcept{
        if(c.kind==Patch){auto& patch=patches_[c.a];failedSelection(patch.selectionStamp);retireSelection(patch.selectionStamp);patch.busy.store(false,std::memory_order_release);}
        else if(c.kind==SelectPart){failedSelection(c.epoch);retireSelection(c.epoch);}
    }
    void mirrorParameter(unsigned part,uint32_t id) noexcept{
        // Only edited raw fields change readback. Avoid a whole catalog scan for
        // every fader event; common values are mirrored into both part views.
        if(id>=2000){const auto v=readParameter(0,id);for(auto& values:parameters_)values[id].store(v,std::memory_order_release);}
        else if(part==2){for(unsigned p=0;p<2;++p)parameters_[p][id].store(readParameter(p,id),std::memory_order_release);}
        else parameters_[part][id].store(readParameter(part,id),std::memory_order_release);
    }
    void refreshMirror(unsigned part,uint32_t id) noexcept{
        revision_.fetch_add(1,std::memory_order_acq_rel);mirrorParameter(part,id);
        revision_.fetch_add(1,std::memory_order_release);error_.store(0);
    }
    void refreshMirrors(const PatchData& patch) noexcept{
        revision_.fetch_add(1,std::memory_order_acq_rel);
        for(unsigned scope=0;scope<3;++scope){const auto& data=patch.scopes[scope];
            for(uint32_t i=0;i<data.count;++i)mirrorParameter(scope,data.ids[i]);
        }
        revision_.fetch_add(1,std::memory_order_release);error_.store(0);
    }
    void applyControl(const jp8000_detail::Command& c) noexcept{
        if(c.kind==Patch){
            auto& patch=patches_[c.a];const auto& u=patch.scopes[0];const auto& l=patch.scopes[1];const auto& g=patch.scopes[2];
            const auto result=mdlr_jp8000_rust_apply_performance(core_,u.ids.data(),u.values.data(),u.count,l.ids.data(),l.values.data(),l.count,g.ids.data(),g.values.data(),g.count);
            if(result==0){refreshMirrors(patch);if(patch.selectionStamp)committedSelection_=patch.selectionStamp;}else {failedSelection(patch.selectionStamp);reject(2,0);}
            retireSelection(patch.selectionStamp);
            patch.busy.store(false,std::memory_order_release);return;
        }
        if(c.kind==SelectPart){
            if(mdlr_jp8000_rust_set_parameter(core_,2018,uint16_t(c.a))==0){refreshMirror(0,2018);committedSelection_=c.epoch;}
            else {failedSelection(c.epoch);reject(2,2018);}
            retireSelection(c.epoch);return;
        }
        if(c.epoch&&c.epoch!=committedSelection_){reject(2,c.a);return;}
        int32_t result;
        const uint16_t id=uint16_t(c.a),value=uint16_t(c.b);
        if(id>=2000)result=mdlr_jp8000_rust_set_parameter(core_,id,value);
        else if(c.c==2)result=mdlr_jp8000_rust_apply_performance(core_,&id,&value,1,&id,&value,1,nullptr,nullptr,0);
        else result=mdlr_jp8000_rust_set_part_parameter(core_,uint8_t(c.c),id,value);
        if(result==0)refreshMirror(c.c,id);else reject(2,c.a);
    }
    void clearPending(bool preserveControls) noexcept{
        touchNotes_.fill({});touchSustain_={};
        // Panic cancels MIDI immediately; retained controls are committed by the
        // normal callback budget, never in this cleanup loop. All public control
        // commands have zero offset. Their monotonic admission sequence preserves
        // control order when the native clock is reset. Patch storage and selection
        // ownership remain live until each eventual atomic commit or rejection.
        size_t kept=0;
        for(size_t i=0;i<pendingCount_;++i){
            const auto item=pending_[i];
            if(isMidi(item.command.kind))continue;
            if(preserveControls){pending_[kept]=item;pending_[kept++].frame=0;}
            else retireDroppedControl(item.command);
        }
        pendingCount_=kept;
        std::make_heap(pending_.begin(),pending_.begin()+pendingCount_,later);
    }

};
