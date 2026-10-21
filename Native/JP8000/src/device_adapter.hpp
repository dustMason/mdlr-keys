// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "jeLib/je8086.h"
#include "jeLib/rom.h"
#include "jeLib/state.h"
#include "synthLib/audioTypes.h"
struct NativeCreateParams { std::vector<uint8_t> romData; std::string romName; };
namespace jeLib {
// A single producer owns the whole board. No BoardThread, device IO, worker mutex or host gain.
class NativeDevice {
public:
 NativeDevice(const NativeCreateParams& p,const std::vector<uint8_t>& ram):board(p.romData,ram){}
 Je8086& getJe8086(){return board;}
 void setMasterVolume(float){} // fixed unity DAC conversion below
 void process(const synthLib::TAudioInputs&,const synthLib::TAudioOutputs& out,size_t frames,const std::vector<synthLib::SMidiEvent>& in,std::vector<synthLib::SMidiEvent>& events){
  size_t event=0;
  for(size_t i=0;i<frames;++i){
   while(event<in.size()&&in[event].offset<=i){board.addMidiEvent(in[event]);++event;}
   const auto f=board.renderSample();
   out[0][i]=float(int32_t(uint32_t(f.first)<<8)>>8)*(1.0f/8388608.0f);
   out[1][i]=float(int32_t(uint32_t(f.second)<<8)>>8)*(1.0f/8388608.0f);
  }
  board.readMidiOut(events); state.receive(events);
 }
 bool getState(std::vector<uint8_t>& out,int)const{
  synthLib::SMidiEvent system;std::vector<synthLib::SMidiEvent> performance;
  if(!state.createSystemDump(system)||!state.createTempPerformanceDumps(performance))return false;
  out.assign(system.sysex.begin(),system.sysex.end());for(const auto& p:performance)out.insert(out.end(),p.sysex.begin(),p.sysex.end());return true;
 }
 Je8086 board; State state;
};
}
