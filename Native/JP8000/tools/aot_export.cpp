// Private build-time exporter. Never linked into iPad runtime.
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
#include <sstream>
#include <iomanip>
#include "json.hpp"
#include "jeLib/je8086.h"
#include "jeLib/rom.h"
#include "jeLib/state.h"
#include "custom_chips/esp/esp_jit_arm64.h"
using Json=nlohmann::json;
std::filesystem::path destination;
std::ofstream assembly;
std::vector<uint8_t> lastCode;
template<int N> class ExportArm64 : public esp::AotArm64Isa<N> {
protected:
 using Base=esp::AotArm64Isa<N>;using Assembler=typename Base::Assembler;using Base::Base;
 static esp::KernelFn finish(asmjit::JitRuntime& runtime,asmjit::CodeHolder& code,Assembler& a,bool failed) {
   auto fn=Base::finish(runtime,code,a,failed);lastCode.clear();
   if(fn)lastCode.assign(reinterpret_cast<uint8_t*>(fn),reinterpret_cast<uint8_t*>(fn)+code.codeSize());
   return fn;
 }
};
std::vector<uint8_t> read(const char* path){std::ifstream f(path,std::ios::binary);if(!f)throw std::runtime_error(path);return {std::istreambuf_iterator<char>(f),{}};}
Json records=Json::array();
std::map<std::vector<uint32_t>,unsigned> known;
// Exact normalized program identity. Full 2x1024 structures plus scheduling/configuration.
// Live operands remain read from the current machine; generation/hash alone are never keys.
template<int N> std::vector<uint32_t> key(const esp::ProgramSnapshot& p){std::vector<uint32_t> k{N,384,p.memoryMode,p.compress,p.staticBus,p.conditionalBranches,p.spacing};for(int c=0;c<2;c++)for(int i=0;i<esp::PRAM_WORDS;i++)k.push_back(esp::structureOf(p.words[c][i])|(c==1 && i<esp::PRAM_SIZE?p.words[c][i]&0x0c000000u:0));return k;}
template<int N> void capture(const esp::Dispatcher<N>& chip, const std::string& phase){
 if(!chip.kernelReady())return;
 auto snapshot=esp::ProgramSnapshot::take(chip.interpreter());auto k=key<N>(snapshot);
 if(known.count(k))return;
 asmjit::JitRuntime rt;auto fn=esp::JitEmitter<ExportArm64<N>>::compile(rt,snapshot,384);
 if(!fn)throw std::runtime_error("Cannot export validated kernel");
 const unsigned id=records.size();known[k]=id;
 assembly<<".globl _jp_aot_"<<id<<"\n.p2align 2\n_jp_aot_"<<id<<":\n";
 for(size_t i=0;i<lastCode.size();i+=4){uint32_t w;std::memcpy(&w,lastCode.data()+i,4);assembly<<".long 0x"<<std::hex<<w<<std::dec<<'\n';}
 auto file=destination/("kernel-"+std::to_string(id)+".bin");std::ofstream raw(file,std::ios::binary);raw.write(reinterpret_cast<char*>(lastCode.data()),lastCode.size());
 records.push_back({{"id",id},{"eram_bits",N},{"clocks",384},{"code_bytes",lastCode.size()},{"phase",phase},{"key",k}});
 rt.release(fn);
 std::cerr<<"export "<<id<<" N="<<N<<" bytes="<<lastCode.size()<<" "<<phase<<'\n';
}
int main(int argc,char**argv){if(argc!=4)return 2;if(std::string(argv[1])=="--factory-ram"){auto ram=jeLib::Je8086::createFactoryRam(read(argv[2]));std::ofstream out(argv[3],std::ios::binary);out.write(reinterpret_cast<const char*>(ram.data()),ram.size());return out?0:1;}destination=argv[3];std::filesystem::create_directories(destination);assembly.open(destination/"kernels.S");assembly<<".section __TEXT,__text,regular,pure_instructions\n";
 auto rom=read(argv[1]);for(bool held:{false,true}){jeLib::Je8086 board(rom,read(argv[2]));
 auto run=[&](unsigned n,std::string phase){for(unsigned i=0;i<n;i++){board.renderSample();if((i%2048)==2047)board.forEachEsp([&](const auto& c){capture(c,phase);});}board.forEachEsp([&](const auto& c){capture(c,phase);});};
 run(88200*4,held?"played-boot":"idle-boot");
 if(held){for(unsigned note:{48,52,55,59,60,64,67,71}){synthLib::SMidiEvent event(synthLib::MidiEventSource::Host);event.a=0x90;event.b=note;event.c=100;board.addMidiEvent(event);}run(22050,"held-chord");}
 // Coverage includes all128 ROM patches in both parts, with firmware serial
 // delivery and settling. Patches remain private user firmware data.
 jeLib::Rom image(rom,"jp8000");std::vector<std::vector<jeLib::Rom::Preset>> banks;image.getPresets(banks);
 for(int index=0;index<128;index++){
   for(auto part:{jeLib::PerformanceData::PatchUpper,jeLib::PerformanceData::PatchLower}){
     for(auto message:banks.at(index/64).at(index%64)){
       jeLib::State::setAddress(message,static_cast<uint32_t>(jeLib::AddressArea::PerformanceTemp)|static_cast<uint32_t>(part));jeLib::State::updateChecksum(message);
       synthLib::SMidiEvent event(synthLib::MidiEventSource::Editor);event.sysex=message;board.addMidiEvent(event);
     }
   }
   run(88200/3,"patch-"+std::to_string(index));
 }
 for(int index=0;index<64;++index){
  for(auto message:banks.at(2).at(index)){jeLib::State::setAddress(message,0x01000000u|(jeLib::State::getAddress(message)&0xffffu));jeLib::State::updateChecksum(message);synthLib::SMidiEvent event(synthLib::MidiEventSource::Editor);event.sysex=message;board.addMidiEvent(event);}
  run(88200/2,"performance-"+std::to_string(index));
 }
 // Finite structural switches that can rewrite ESP microprograms. Each is sent to both parts.
 struct Sweep{unsigned group,wire,max;};
 const Sweep sweep[]={ {0,30,6},{0,33,2},{0,21,1},{0,34,1},{0,39,2},{0,40,1},{0,61,11},{0,63,4},{2,16,2},{2,22,4} };
 for(const auto& c:sweep)for(unsigned value=0;value<=c.max;++value){
  for(unsigned part=0;part<(c.group==2?1u:2u);++part){const uint32_t base=c.group==2?0x01000000u:part?0x01004200u:0x01004000u;auto message=jeLib::State::createHeader(jeLib::SysexByte::CommandIdDataSet1,jeLib::SysexByte::DeviceIdDefault,jeLib::State::toAddress(base|c.wire));jeLib::State::addParameter(message,false,value);jeLib::State::createFooter(message);synthLib::SMidiEvent event(synthLib::MidiEventSource::Editor);event.sysex=message;board.addMidiEvent(event);}
  run(88200/4,"sweep-"+std::to_string(c.group)+"-"+std::to_string(c.wire)+"-"+std::to_string(value));
 }
 // Cover normal structural combinations, not just one-dimensional control sweeps.
 auto setPatch=[&](unsigned wire,unsigned value){for(unsigned part=0;part<2;++part){auto msg=jeLib::State::createHeader(jeLib::SysexByte::CommandIdDataSet1,jeLib::SysexByte::DeviceIdDefault,jeLib::State::toAddress((part?0x01004200u:0x01004000u)|wire));jeLib::State::addParameter(msg,false,value);jeLib::State::createFooter(msg);synthLib::SMidiEvent e(synthLib::MidiEventSource::Editor);e.sysex=msg;board.addMidiEvent(e);}};
 unsigned combination=0;
 for(unsigned osc1=0;osc1<7;++osc1)for(unsigned osc2=0;osc2<3;++osc2)for(unsigned ring=0;ring<2;++ring)for(unsigned sync=0;sync<2;++sync)for(unsigned filter=0;filter<3;++filter)for(unsigned slope=0;slope<2;++slope){
  setPatch(30,osc1);setPatch(33,osc2);setPatch(21,ring);setPatch(34,sync);setPatch(39,filter);setPatch(40,slope);
  run(88200/4,"voice-combination-"+std::to_string(combination++));
 }
 for(unsigned chorus=0;chorus<12;++chorus)for(unsigned delay=0;delay<5;++delay){setPatch(61,chorus);setPatch(63,delay);run(88200/4,"effect-combination-"+std::to_string(chorus)+"-"+std::to_string(delay));}

 } // fresh idle and held-chord corpus passes
 std::ofstream output(destination/"kernels.json");output<<records.dump(2)<<'\n';
}
