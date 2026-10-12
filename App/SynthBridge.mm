#import "SynthBridge.h"
#import "DSP.h"
#import "CommandQueue.hpp"
#import <AVFoundation/AVFoundation.h>
#import <CoreMIDI/CoreMIDI.h>
#include <memory>
#include <vector>
#include <algorithm>
#include <cmath>

struct RenderCore {
    void *synth=mdlr_create();
    CommandQueue commands;
    std::atomic<float> peak{0};
    ~RenderCore(){mdlr_destroy(synth);}
    void render(AudioBufferList *abl,uint32_t frames) {
        if(abl->mNumberBuffers!=2 || !abl->mBuffers[0].mData || !abl->mBuffers[1].mData){
            for(uint32_t b=0;b<abl->mNumberBuffers;b++)if(abl->mBuffers[b].mData)memset(abl->mBuffers[b].mData,0,abl->mBuffers[b].mDataByteSize);
            return;
        }
        Command c; uint32_t consumed=0;
        bool overflow=commands.overflow.exchange(false);
        while(consumed++<2048 && commands.pop(c)) {
            // After overflow drop queued MIDI events so a lost note-off cannot stick.
            if(!overflow || c.kind!=0)mdlr_command(synth,c.kind,c.a,c.b,c.value);
        }
        if(overflow)mdlr_command(synth,4,0,0,0);
        auto *l=(float *)abl->mBuffers[0].mData,*r=(float *)abl->mBuffers[1].mData;
        mdlr_render(synth,l,r,frames,48000);
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
}
- (instancetype)init {
    if((self=[super init])) {
        _core=std::make_shared<RenderCore>(); _audio=[AVAudioEngine new];
        _status=@"Audio stopped"; _midiSources=@"No MIDI keyboard connected";
        auto core=_core;
        AVAudioFormat *format=[[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:2];
        _source=[[AVAudioSourceNode alloc] initWithFormat:format renderBlock:^OSStatus(BOOL *silent,const AudioTimeStamp *time,AVAudioFrameCount frames,AudioBufferList *out){
            core->render(out,frames);*silent=NO;return noErr;
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
                    if(type==2)core->commands.push({0,(word>>16)&255,(word>>8)&127,float(word&127)});
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
    if(![_audio startAndReturnError:&error]){_status=error.localizedDescription;return NO;}
    _status=@"Playing · 48 kHz stereo";return YES;
}
- (void)stop { _wanted=NO;[self panic];[_audio stop];_status=@"Audio stopped"; }
- (void)audioChanged:(NSNotification *)n {
    dispatch_async(dispatch_get_main_queue(),^{if(self->_wanted){[self->_audio stop];[self panic];[self start];}});
}
#if TARGET_OS_IOS
- (void)interrupted:(NSNotification *)n {
    dispatch_async(dispatch_get_main_queue(),^{
        auto type=[n.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
        if(type==AVAudioSessionInterruptionTypeBegan){[self panic];[self->_audio pause];self->_status=@"Audio interrupted";}
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
- (uint32_t)droppedEvents{return _core->commands.dropped.load();}
- (void)selectEngine:(NSInteger)e{_core->commands.push({1,(uint32_t)e,0,0});}
- (void)setParameter:(NSInteger)p value:(float)v{_core->commands.push({2,(uint32_t)p,0,v});}
- (void)setMasterVolume:(float)v{_core->commands.push({3,0,0,v});}
- (void)setVelocitySensitive:(BOOL)enabled{_core->commands.push({5,(uint32_t)enabled,0,0});}
- (void)setMonoOutput:(BOOL)enabled{_monoOutput=enabled;_core->commands.push({6,(uint32_t)enabled,0,0});}
- (void)sendStatus:(uint8_t)s data1:(uint8_t)a data2:(uint8_t)b{_core->commands.push({0,s,a,float(b)});}
- (void)panic{_core->commands.push({4,0,0,0});}
- (void)dealloc{[[NSNotificationCenter defaultCenter] removeObserver:self];[_audio stop];if(_input)MIDIPortDispose(_input);if(_client)MIDIClientDispose(_client);}
@end
