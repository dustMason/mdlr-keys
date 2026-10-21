#include "synthLib/midiRateLimiter.h"
#include "synthLib/midiBufferParser.h"
#include <cassert>
#include <iostream>
#include <vector>
int main(){std::vector<uint8_t> bytes;synthLib::MidiRateLimiter wire([&](uint8_t b){bytes.push_back(b);});wire.disableRateLimit();
for(const auto&e:std::vector<synthLib::SMidiEvent>{{synthLib::MidiEventSource::Host,0xf1,0x7f,0},{synthLib::MidiEventSource::Host,0xf2,1,2},{synthLib::MidiEventSource::Host,0xf3,3,0},{synthLib::MidiEventSource::Host,0xf6,0,0},{synthLib::MidiEventSource::Host,0xf8,0,0},{synthLib::MidiEventSource::Host,0xfa,0,0},{synthLib::MidiEventSource::Host,0xfb,0,0},{synthLib::MidiEventSource::Host,0xfc,0,0},{synthLib::MidiEventSource::Host,0xfe,0,0},{synthLib::MidiEventSource::Host,0x90,60,100},{synthLib::MidiEventSource::Host,0xf8,0,0},{synthLib::MidiEventSource::Host,0x90,64,110},{synthLib::MidiEventSource::Host,0x80,60,0}})wire.write(synthLib::SMidiEvent(e));wire.processSample();
const std::vector<uint8_t> expected={0xf1,0x7f,0xf2,1,2,0xf3,3,0xf6,0xf8,0xfa,0xfb,0xfc,0xfe,0x90,60,100,0xf8,64,110,0x80,60,0};if(bytes!=expected){std::cerr<<"wire mismatch:";for(auto b:bytes)std::cerr<<' '<<std::hex<<unsigned(b);return 1;}std::cout<<"PASS: exact system/common/channel MIDI bytes, realtime preserves running status\n";}
