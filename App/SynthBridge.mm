#import "SynthBridge.h"
#import "DSP.h"
#import "SynthRouting.hpp"
#import "JP8000Backend.hpp"
#import <AVFoundation/AVFoundation.h>
#import <CoreMIDI/CoreMIDI.h>
#include <memory>
#include <vector>
#include <algorithm>
#include <cmath>

struct RenderCore {
    void *synth=mdlr_create();
    SynthRouting routing;
    std::shared_ptr<JP8000Backend> jp;
    std::atomic<float> peak{0};
    void midi(uint8_t status,uint8_t a,uint8_t b) {
        routing.midi(status,a,b,[this](uint8_t s,uint8_t a,uint8_t b){if(jp)jp->midi(s,a,b);});
    }
    void umpWord(uint32_t word,uint64_t hostTime=0) {
        routing.umpWord(word,[this,hostTime](uint8_t s,uint8_t a,uint8_t b){if(jp)jp->midiAtHostTime(s,a,b,hostTime);});
    }
    ~RenderCore(){mdlr_destroy(synth);}
    void render(AudioBufferList *abl,uint32_t frames,uint64_t hostTime) {
        if(abl->mNumberBuffers!=2 || !abl->mBuffers[0].mData || !abl->mBuffers[1].mData){
            for(uint32_t b=0;b<abl->mNumberBuffers;b++)if(abl->mBuffers[b].mData)memset(abl->mBuffers[b].mData,0,abl->mBuffers[b].mDataByteSize);
            return;
        }
        routing.drain([this](Command c){mdlr_command(synth,c.kind,c.a,c.b,c.value);});
        auto *l=(float *)abl->mBuffers[0].mData,*r=(float *)abl->mBuffers[1].mData;
        if(routing.renderEngine==4 && jp)jp->render48k(l,r,frames,hostTime);
        else mdlr_render(synth,l,r,frames,48000);
        float p=0;for(uint32_t i=0;i<frames;i++)p=std::max(p,std::max(std::abs(l[i]),std::abs(r[i])));
        peak.store(p,std::memory_order_relaxed);
    }
};

@implementation SynthBridge {
    std::shared_ptr<RenderCore> _core;
    AVAudioEngine *_audio;
    AVAudioSourceNode *_source;
    MIDIClientRef _client;
    MIDIPortRef _input;
    std::vector<MIDIEndpointRef> _connected;
    NSString *_status;
    NSString *_midiSources;
    BOOL _wanted;
    BOOL _monoOutput;
    NSString *_jpSavedPatch;
}
- (instancetype)init {
    if((self=[super init])) {
        _core=std::make_shared<RenderCore>(); _audio=[AVAudioEngine new];
        NSString *backend=NSProcessInfo.processInfo.environment[@"MDLR_JP8000_BACKEND"] ?: [NSUserDefaults.standardUserDefaults stringForKey:@"JP8000Backend"];
        if(JP8000Backend::experimentalAvailable() && (JP8000Backend::rustOnly() || [backend isEqualToString:@"rust"])){
            // This branch never discovers or reads private firmware/state inputs.
            _core->jp=JP8000Backend::createRust();
            _jpSavedPatch=@"";
        }else{
            NSBundle *bundle=NSBundle.mainBundle;
            NSString *rom=[bundle pathForResource:@"jp8000_v1.05" ofType:@"bin" inDirectory:@"JP8000"];
            NSString *ram=[bundle pathForResource:@"ram_dump" ofType:@"bin" inDirectory:@"JP8000"];
            NSURL *support=[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
            NSURL *state=[support URLByAppendingPathComponent:@"mdlr/JP8000" isDirectory:YES];
            _jpSavedPatch=[[state URLByAppendingPathComponent:@"saved-patch.syx"] path];
            _core->jp=JP8000Backend::createFirmware(rom.UTF8String ?: "",ram.UTF8String ?: "",state.path.UTF8String ?: "");
        }
        _status=@"Audio stopped"; _midiSources=@"No MIDI keyboard connected";
        auto core=_core;
        AVAudioFormat *format=[[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:2];
        _source=[[AVAudioSourceNode alloc] initWithFormat:format renderBlock:^OSStatus(BOOL *silent,const AudioTimeStamp *time,AVAudioFrameCount frames,AudioBufferList *out){
            core->render(out,frames,time&&(time->mFlags&kAudioTimeStampHostTimeValid)?time->mHostTime:0);*silent=NO;return noErr;
        }];
        [_audio attachNode:_source];[_audio connect:_source to:_audio.mainMixerNode format:format];
        __weak SynthBridge *weakSelf=self;
        OSStatus err=MIDIClientCreateWithBlock(CFSTR("mdlr"),&_client,^(const MIDINotification *n){
            dispatch_async(dispatch_get_main_queue(),^{[weakSelf refreshMIDI];});
        });
        if(!err)err=MIDIInputPortCreateWithProtocol(_client,CFSTR("Keyboard input"),kMIDIProtocol_1_0,&_input,^(const MIDIEventList *list,void *context){
            const MIDIEventPacket *p=&list->packet[0];
            static const uint8_t lengths[16]={1,1,1,2,2,4,1,1,2,2,2,3,3,4,4,4};
            for(uint32_t i=0;i<list->numPackets;i++){
                for(uint32_t j=0;j<p->wordCount;){
                    uint32_t word=p->words[j],type=word>>28;
                    core->umpWord(word,p->timeStamp);
                    j+=lengths[type];
                }
                p=MIDIEventPacketNext(p);
            }
        });
        if(err)_midiSources=[NSString stringWithFormat:@"MIDI unavailable (%d)",(int)err];else [self refreshMIDI];
        [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(audioChanged:) name:AVAudioEngineConfigurationChangeNotification object:_audio];
#if TARGET_OS_IOS
        [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(interrupted:) name:AVAudioSessionInterruptionNotification object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(routeChanged:) name:AVAudioSessionRouteChangeNotification object:nil];
#endif
    }
    return self;
}
- (void)refreshMIDI {
    if(!_input)return;
    std::vector<MIDIEndpointRef> sources;
    NSMutableArray<NSString *> *names=[NSMutableArray new];
    for(ItemCount i=0;i<MIDIGetNumberOfSources();i++){
        auto endpoint=MIDIGetSource(i);if(!endpoint)continue;
        if(std::find(_connected.begin(),_connected.end(),endpoint)==_connected.end()){
            OSStatus result=MIDIPortConnectSource(_input,endpoint,nullptr);
            if(result)continue;
        }
        sources.push_back(endpoint);CFStringRef name=nullptr;
        MIDIObjectGetStringProperty(endpoint,kMIDIPropertyDisplayName,&name);
        [names addObject:name?CFBridgingRelease(name):@"MIDI input"];
    }
    for(auto endpoint:_connected)if(std::find(sources.begin(),sources.end(),endpoint)==sources.end()){
        MIDIPortDisconnectSource(_input,endpoint);[self panic];
    }
    _connected=std::move(sources);
    _midiSources=names.count?[names componentsJoinedByString:@" · "]:@"No MIDI keyboard connected";
}
- (BOOL)start {
    _wanted=YES;if(_audio.isRunning)return YES;NSError *error=nil;
#if TARGET_OS_IOS
    AVAudioSession *session=AVAudioSession.sharedInstance;
    if(![session setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeDefault options:0 error:&error] ||
       ![session setPreferredSampleRate:48000 error:&error] || ![session setPreferredIOBufferDuration:128.0/48000.0 error:&error] || ![session setActive:YES error:&error]){
        _status=error.localizedDescription;return NO;
    }
#endif
    [_audio prepare];
    _core->jp->setActive(_core->routing.selectedEngine()==4);
    if(![_audio startAndReturnError:&error]){_core->jp->setActive(false);_status=error.localizedDescription;return NO;}
    _status=@"Playing · 48 kHz stereo";return YES;
}
- (void)stop { _wanted=NO;[self panic];[_audio stop];_core->jp->setActive(false);_status=@"Audio stopped"; }
- (void)audioChanged:(NSNotification *)n {
    dispatch_async(dispatch_get_main_queue(),^{if(self->_wanted){[self->_audio stop];self->_core->jp->setActive(false);[self panic];[self start];}});
}
#if TARGET_OS_IOS
- (void)interrupted:(NSNotification *)n {
    dispatch_async(dispatch_get_main_queue(),^{
        auto type=[n.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
        if(type==AVAudioSessionInterruptionTypeBegan){[self panic];[self->_audio pause];self->_core->jp->setActive(false);self->_status=@"Audio interrupted";}
        else if(self->_wanted && ([n.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue]&AVAudioSessionInterruptionOptionShouldResume)){[self start];}
    });
}
- (void)routeChanged:(NSNotification *)n {
    if([n.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue]==AVAudioSessionRouteChangeReasonOldDeviceUnavailable)
        dispatch_async(dispatch_get_main_queue(),^{[self stop];});
}
#endif
- (BOOL)running{return _audio.isRunning;}
- (NSString *)status{if(_audio.isRunning)return _monoOutput ? @"Playing · 48 kHz mono":@"Playing · 48 kHz stereo";return _status;}
- (NSString *)midiSources{return _midiSources;}
- (float)peak{return _core->peak.load(std::memory_order_relaxed);}
- (uint32_t)droppedEvents{return _core->routing.commands.dropped.load()+_core->jp->droppedEvents();}
- (void)selectEngine:(NSInteger)e {
    if(e<0 || e>5)return;
    [self panic];
    _core->routing.selectEngine((uint32_t)e);
    _core->jp->setActive(e==4 && _audio.isRunning);
}
- (void)setParameter:(NSInteger)p value:(float)v {
    if(p<0 || !std::isfinite(v))return;
    const uint32_t engine=_core->routing.selectedEngine();
    if(engine==4)_core->jp->parameter((uint32_t)p,(uint32_t)std::max(0.0f,std::round(v)));
    else _core->routing.parameter(engine,(uint32_t)p,v);
}
- (void)setMasterVolume:(float)v{_core->routing.commands.push({3,0,0,v});_core->jp->setMasterVolume(v);}
- (void)setVelocitySensitive:(BOOL)enabled{_core->routing.commands.push({5,(uint32_t)enabled,0,0});_core->jp->setVelocitySensitive(enabled);}
- (void)setMonoOutput:(BOOL)enabled{_monoOutput=enabled;_core->routing.commands.push({6,(uint32_t)enabled,0,0});_core->jp->setMono(enabled);}
- (void)sendStatus:(uint8_t)s data1:(uint8_t)a data2:(uint8_t)b{_core->midi(s,a,b);}
- (BOOL)sendJPTouchStatus:(uint8_t)s data1:(uint8_t)a data2:(uint8_t)b {
    return _core->routing.selectedEngine()==4 && _core->jp->touchMidi(s,a,b);
}
- (void)panic{_core->routing.commands.push({4,0,0,0});_core->jp->panic();}
- (NSString *)jpSnapshot{auto text=_core->jp->snapshotJSON();return [[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding] ?: @"{}";}
- (void)jpSelectPart:(NSInteger)part{if(part>=0 && part<=2)_core->jp->setPart((uint32_t)part);}
- (void)jpLoadPatch:(NSInteger)index{if(index>=0 && index<128)_core->jp->factoryPatch((uint32_t)index);}
- (void)jpLoadPerformance:(NSInteger)index{if(index>=0 && index<64)_core->jp->factoryPerformance((uint32_t)index);}
- (void)jpPressPanel:(NSInteger)button {
    if(button<0 || button>255)return;
    _core->jp->panel((uint32_t)button,true);
    // The worker schedules release after the firmware's keyboard scan sees down.
    _core->jp->panel((uint32_t)button,false);
}
- (void)jpSavePatch{_core->jp->saveState(_jpSavedPatch.UTF8String ?: "");}
- (void)jpRestorePatch{_core->jp->loadState(_jpSavedPatch.UTF8String ?: "");}
- (void)dealloc{[[NSNotificationCenter defaultCenter] removeObserver:self];[_audio stop];_core->jp->setActive(false);if(_input)MIDIPortDispose(_input);if(_client)MIDIClientDispose(_client);}
@end
