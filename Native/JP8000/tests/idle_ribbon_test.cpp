// No firmware required: construct boards with zero-filled, size-only ROM placeholders.
// Never step a CPU/DSP, render audio, or open a device. Run against the proposed native archive.
#include "jeLib/je8086.h"
#include "jeLib/rom.h"
#include <array>
#include <cstdio>
#include <stdexcept>
#include <vector>
template<class Tag, typename Tag::type Member> struct Expose { friend typename Tag::type member(Tag) { return Member; } };
struct FadersMember {using type=jeLib::devices::Faders jeLib::Je8086::*;friend type member(FadersMember);};
template struct Expose<FadersMember,&jeLib::Je8086::m_faders>;
struct ValuesMember {using type=std::array<int,64> jeLib::devices::Faders::*;friend type member(ValuesMember);};
template struct Expose<ValuesMember,&jeLib::devices::Faders::m_values>;
static void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
int main(){
 try{
  const std::vector<uint8_t> ram(jeLib::Je8086::RamSize,0);
  for(bool rack:{false,true}){
   jeLib::Je8086 board(std::vector<uint8_t>(rack?jeLib::Rom::RomSizeRack:jeLib::Rom::RomSizeKeyboard,0),ram);
   require(board.isRack()==rack,"incorrect board type");
   auto& faders=board.*member(FadersMember{});auto& values=faders.*member(ValuesMember{});
   for(unsigned index=0;index<values.size();++index)require(values[index]==(!rack&&index==jeLib::devices::kFader_Ribbon2?0:512),"unexpected default physical ADC input");
   faders.reset();
   require(values[jeLib::devices::kFader_Ribbon2]==(rack?512:0),"ADC reset changed the idle input");
   faders.setFader(jeLib::devices::kFader_Ribbon2,700);faders.reset();
   require(values[jeLib::devices::kFader_Ribbon2]==700,"ADC reset must preserve an explicit physical input");
  }
  std::puts("keyboard idle input, rack defaults and reset persistence passed");return 0;
 }catch(const std::exception& e){std::fprintf(stderr,"%s\n",e.what());return 1;}
}
