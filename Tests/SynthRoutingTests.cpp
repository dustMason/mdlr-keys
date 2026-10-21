#include "../App/SynthRouting.hpp"
#include <cassert>
#include <iostream>
#include <tuple>
#include <vector>

struct LegacyEvent {
    uint32_t engine;
    Command command;
};
struct Harness {
    SynthRouting routing;
    uint32_t legacyEngine=0;
    std::vector<LegacyEvent> legacy;
    std::vector<std::tuple<uint8_t,uint8_t,uint8_t>> jp;
    void drain() {
        routing.drain([&](Command c){
            if(c.kind==1)legacyEngine=c.a;
            legacy.push_back({legacyEngine,c});
        });
    }
    void word(uint32_t word) {
        routing.umpWord(word,[&](uint8_t s,uint8_t a,uint8_t b){jp.emplace_back(s,a,b);});
    }
};

static void stoppedQueueRecoversSelection() {
    Harness h;
    // Audio is stopped: its consumer cannot drain incoming legacy MIDI.
    for(unsigned i=0;i<2047;++i)h.word(0x20903c64);
    assert(!h.routing.selectEngine(4));
    assert(h.routing.selectedEngine()==4);
    h.drain();
    assert(h.routing.renderEngine==4);
    for(const auto& e:h.legacy)assert(e.command.kind==4); // Overflow discards notes and panics.
    h.word(0x20913e64);
    assert(h.jp.size()==1 && std::get<0>(h.jp[0])==0x91);

    // Back to a legacy engine: its parameters follow its ordered selector.
    h.legacy.clear();
    assert(h.routing.selectEngine(2));
    assert(h.routing.parameter(2,41,0.75f));
    h.drain();
    assert(h.routing.renderEngine==2 && h.legacy.size()==2);
    assert(h.legacy[0].command.kind==1 && h.legacy[0].command.a==2);
    assert(h.legacy[1].engine==2 && h.legacy[1].command.kind==2);
    assert(h.legacy[1].command.a==41 && h.legacy[1].command.value==0.75f);
}

static void droppedSelectorCannotCorruptOldPatch() {
    Harness h;
    for(unsigned i=0;i<2047;++i)h.word(0x20903c64);
    assert(!h.routing.selectEngine(3));
    // One slot becomes available before the producer sends its next parameter.
    Command discarded;assert(h.routing.commands.pop(discarded));
    assert(h.routing.parameter(3,7,0.25f));
    h.drain();
    assert(h.routing.renderEngine==3);
    for(const auto& e:h.legacy)assert(e.command.kind!=2);
    // The recovered engine accepts its next update normally.
    assert(h.routing.parameter(3,7,0.5f));h.drain();
    assert(h.legacy.back().engine==3 && h.legacy.back().command.kind==2);
    assert(h.legacy.back().command.value==0.5f);
}

static void normalCommandOrderIsPreserved() {
    Harness h;
    assert(h.routing.selectEngine(1));
    assert(h.routing.parameter(1,7,0.1f));
    h.word(0x20903c64);
    assert(h.routing.selectEngine(3));
    assert(h.routing.parameter(3,7,0.9f));
    h.drain();
    assert(h.legacy.size()==5 && h.routing.renderEngine==3);
    assert(h.legacy[0].command.kind==1 && h.legacy[0].engine==1);
    assert(h.legacy[1].command.kind==2 && h.legacy[1].engine==1);
    assert(h.legacy[1].command.value==0.1f);
    assert(h.legacy[2].command.kind==0 && h.legacy[2].engine==1);
    assert(h.legacy[3].command.kind==1 && h.legacy[3].engine==3);
    assert(h.legacy[4].command.kind==2 && h.legacy[4].engine==3);
    assert(h.legacy[4].command.value==0.9f);
}

static void queuedSwitchWinsOverUnpublishedMailbox() {
    Harness h;
    // Model the consumer running between selectEngine's queue push and store.
    assert(h.routing.commands.push({1,2,1,0}));
    h.drain();
    assert(h.routing.renderEngine==2 && h.legacy.size()==1);
    // Publishing generation 1 afterward must not perform a second reset.
    assert(h.routing.selectEngine(2));h.drain();
    assert(h.routing.renderEngine==2 && h.legacy.size()==1);
}

static void boundedDrainDoesNotOvertakeQueuedSwitch() {
    Harness h;
    for(unsigned i=0;i<2047;++i)assert(h.routing.parameter(0,7,0.1f));
    unsigned received=0;
    h.routing.drain([&](Command c){
        assert(c.kind==2);
        ++received;
        // Simulate a producer keeping the queue populated during this callback.
        if(received<=10)assert(h.routing.parameter(0,7,0.2f));
        if(received==11)assert(h.routing.selectEngine(1));
    });
    assert(received==2048 && h.routing.selectedEngine()==1);
    assert(h.routing.renderEngine==0); // Its selector is still behind older parameters.
    h.drain();
    assert(h.routing.renderEngine==1);
    assert(h.legacy.size()==10 && h.legacy.back().command.kind==1);
    for(size_t i=0;i+1<h.legacy.size();++i)
        assert(h.legacy[i].engine==0 && h.legacy[i].command.kind==2);
}

static void systemMessagesReachOnlyJP() {
    Harness h;
    const std::vector<uint8_t> statuses={0xf1,0xf2,0xf3,0xf6,0xf8,0xfa,0xfb,0xfc,0xfe};
    for(uint8_t status:statuses)h.word(0x10000000u | (uint32_t(status)<<16) | 0x1234);
    h.drain();assert(h.jp.empty() && h.legacy.empty());
    h.word(0x20913c64);h.drain();
    assert(h.legacy.size()==1 && h.legacy[0].command.kind==0);
    assert(h.legacy[0].command.a==0x91 && h.legacy[0].command.b==60);

    assert(h.routing.selectEngine(4));h.drain();h.legacy.clear();
    for(uint8_t status:statuses)h.word(0x10000000u | (uint32_t(status)<<16) | 0x1234);
    assert(h.jp.size()==statuses.size());
    for(size_t i=0;i<statuses.size();++i)
        assert(h.jp[i]==std::make_tuple(statuses[i],uint8_t(0x12),uint8_t(0x34)));
    for(uint8_t status:{0xf0,0xf4,0xf5,0xf7,0xf9,0xfd,0xff})
        h.word(0x10000000u | (uint32_t(status)<<16));
    h.word(0x30903c64); // SysEx UMP fragments are not channel voice messages.
    assert(h.jp.size()==statuses.size());h.drain();assert(h.legacy.empty());
    h.word(0x20923e64);
    assert(h.jp.back()==std::make_tuple(uint8_t(0x92),uint8_t(62),uint8_t(100)));
}

static void monologueUsesFifthRustEngine() {
    Harness h;
    assert(h.routing.selectEngine(5));
    assert(h.routing.parameter(5,9,0.7f));
    h.word(0x209f3c64);
    h.drain();
    assert(h.routing.renderEngine==5 && h.legacyEngine==4);
    assert(h.jp.empty() && h.legacy.size()==3);
    assert(h.legacy[0].command.kind==1 && h.legacy[0].command.a==4);
    assert(h.legacy[1].command.kind==2 && h.legacy[1].command.a==9);
    assert(h.legacy[1].command.value==0.7f && h.legacy[1].engine==4);
    assert(h.legacy[2].command.kind==0 && h.legacy[2].command.a==0x9f);

    assert(h.routing.selectEngine(4)); h.drain();
    h.legacy.clear();
    assert(h.routing.parameter(5,9,0.1f)); // A stale monologue edit cannot reach JP.
    h.word(0x20913d64); h.drain();
    assert(h.legacy.empty() && h.jp.size()==1);
    assert(h.routing.selectEngine(5));
    assert(h.routing.parameter(4,41,100)); // JP's namespace must not become Rust's.
    assert(h.routing.parameter(5,59,-12));
    h.drain();
    assert(h.legacy.size()==2 && h.legacy.back().command.a==59);
    assert(h.legacy.back().engine==4 && h.legacy.back().command.value==-12);
}

static void saturatedQueueRecoversMonologue() {
    Harness h;
    for(unsigned i=0;i<2047;++i)h.word(0x20903c64);
    assert(!h.routing.selectEngine(5)); h.drain();
    assert(h.routing.renderEngine==5 && h.legacyEngine==4);
    assert(h.legacy.back().command.kind==1 && h.legacy.back().command.a==4);
    assert(h.routing.parameter(5,23,.8f)); h.word(0x20803c00); h.drain();
    assert(h.legacy.back().engine==4 && h.legacy.back().command.kind==0);
    assert(h.jp.empty());
}

int main() {
    stoppedQueueRecoversSelection();
    droppedSelectorCannotCorruptOldPatch();
    normalCommandOrderIsPreserved();
    queuedSwitchWinsOverUnpublishedMailbox();
    boundedDrainDoesNotOvertakeQueuedSwitch();
    systemMessagesReachOnlyJP();
    monologueUsesFifthRustEngine();
    saturatedQueueRecoversMonologue();
    std::cout<<"PASS: saturated queue recovery, parameter ownership, command order, selection publication, JP-only UMP system routing and monologue app5-to-Rust4 routing\n";
}
