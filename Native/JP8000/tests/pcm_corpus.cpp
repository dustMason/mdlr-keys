#include <fstream>
#include <chrono>
#include <iostream>
#include "jeLib/je8086.h"
#include "jeLib/rom.h"
#include "jeLib/state.h"
#include "json.hpp"
std::vector<uint8_t> read(const char*p){std::ifstream f(p,std::ios::binary);if(!f)throw std::runtime_error(p);return {std::istreambuf_iterator<char>(f),{}};}
int main(int argc,char**argv){if(argc!=4)return 2;const auto start=std::chrono::steady_clock::now();auto rom=read(argv[1]);jeLib::Je8086 board(rom,read(argv[2]));std::ofstream raw(argv[3],std::ios::binary);uint64_t frames=0,native=0,fallback=0;unsigned phaseIndex=0;nlohmann::json settled=nlohmann::json::array();auto counters=[&](){uint64_t n=0,f=0;board.forEachEsp([&](const auto&c){auto s=c.statistics();n+=s.native;f+=s.interpreted;});return std::pair(n,f);};auto run=[&](unsigned count){auto before=counters();for(unsigned i=0;i<count;++i){if(i==count-1024)before=counters();auto s=board.renderSample();int32_t data[]={s.first,s.second};raw.write((const char*)data,sizeof(data));++frames;}auto after=counters();settled.push_back({{"phase",phaseIndex++},{"aot_hits",after.first-before.first},{"fallbacks",after.second-before.second}});};auto midi=[&](uint8_t status,uint8_t a,uint8_t b){synthLib::SMidiEvent e(synthLib::MidiEventSource::Host);e.a=status;e.b=a;e.c=b;board.addMidiEvent(e);};run(88200*4);for(int n:{48,52,55,59,60,64,67,71})midi(0x90,n,100);run(22050);jeLib::Rom image(rom,"jp8000");std::vector<std::vector<jeLib::Rom::Preset>> banks;image.getPresets(banks);
for(int i=0;i<128;++i){for(auto part:{jeLib::PerformanceData::PatchUpper,jeLib::PerformanceData::PatchLower})for(auto msg:banks.at(i/64).at(i%64)){jeLib::State::setAddress(msg,0x01000000u|uint32_t(part));jeLib::State::updateChecksum(msg);synthLib::SMidiEvent e(synthLib::MidiEventSource::Editor);e.sysex=msg;board.addMidiEvent(e);}run(29400);}
for(int i=0;i<64;++i){for(auto msg:banks.at(2).at(i)){jeLib::State::setAddress(msg,0x01000000u|(jeLib::State::getAddress(msg)&0xffffu));jeLib::State::updateChecksum(msg);synthLib::SMidiEvent e(synthLib::MidiEventSource::Editor);e.sysex=msg;board.addMidiEvent(e);}run(44100);}
struct Sweep{unsigned group,wire,max;};const Sweep sweep[]={{0,30,6},{0,33,2},{0,21,1},{0,34,1},{0,39,2},{0,40,1},{0,61,11},{0,63,4},{2,16,2},{2,22,4}};
for(auto c:sweep)for(unsigned value=0;value<=c.max;++value){for(unsigned part=0;part<(c.group==2?1u:2u);++part){uint32_t base=c.group==2?0x01000000u:part?0x01004200u:0x01004000u;auto msg=jeLib::State::createHeader(jeLib::SysexByte::CommandIdDataSet1,jeLib::SysexByte::DeviceIdDefault,jeLib::State::toAddress(base|c.wire));jeLib::State::addParameter(msg,false,value);jeLib::State::createFooter(msg);synthLib::SMidiEvent e(synthLib::MidiEventSource::Editor);e.sysex=msg;board.addMidiEvent(e);}run(22050);}

#define CROSS_RUN(count,phase) run(count)
 // Cover normal structural combinations, not just one-dimensional control sweeps.
 auto setPatch=[&](unsigned wire,unsigned value){for(unsigned part=0;part<2;++part){auto msg=jeLib::State::createHeader(jeLib::SysexByte::CommandIdDataSet1,jeLib::SysexByte::DeviceIdDefault,jeLib::State::toAddress((part?0x01004200u:0x01004000u)|wire));jeLib::State::addParameter(msg,false,value);jeLib::State::createFooter(msg);synthLib::SMidiEvent e(synthLib::MidiEventSource::Editor);e.sysex=msg;board.addMidiEvent(e);}};
 unsigned combination=0;
 for(unsigned osc1=0;osc1<7;++osc1)for(unsigned osc2=0;osc2<3;++osc2)for(unsigned ring=0;ring<2;++ring)for(unsigned sync=0;sync<2;++sync)for(unsigned filter=0;filter<3;++filter)for(unsigned slope=0;slope<2;++slope){
  setPatch(30,osc1);setPatch(33,osc2);setPatch(21,ring);setPatch(34,sync);setPatch(39,filter);setPatch(40,slope);
  CROSS_RUN(88200/4,"voice-combination-"+std::to_string(combination++));
 }
 for(unsigned chorus=0;chorus<12;++chorus)for(unsigned delay=0;delay<5;++delay){setPatch(61,chorus);setPatch(63,delay);CROSS_RUN(88200/4,"effect-combination-"+std::to_string(chorus)+"-"+std::to_string(delay));}

#undef CROSS_RUN
board.forEachEsp([&](const auto&chip){auto s=chip.statistics();native+=s.native;fallback+=s.interpreted;});double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();std::ofstream(std::string(argv[3])+".settled.json")<<settled.dump(2);std::cout<<"{\"frames\":"<<frames<<",\"seconds\":"<<seconds<<",\"aot_hits\":"<<native<<",\"fallbacks\":"<<fallback<<"}\n";
}
