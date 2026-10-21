#include "jp8000.h"
#include <array>
#include <fstream>
#include <iostream>
#include <stdexcept>
int main(int argc,char**argv){if(argc!=4)return 2;char err[1024];auto*h=jp8000_create(argv[1],argv[2],err,sizeof(err));if(!h)throw std::runtime_error(err);auto check=[&](int n){if(n)throw std::runtime_error(jp8000_last_error(h));};std::array<float,128>l{},r{};auto render=[&](unsigned frames,std::ofstream*out=nullptr){for(unsigned i=0;i<frames;i+=128){unsigned n=std::min(128u,frames-i);check(jp8000_render(h,l.data(),r.data(),n));if(out)for(unsigned k=0;k<n;++k){float v=(l[k]+r[k])*0.5f;out->write((char*)&v,4);}}};
const unsigned settings[][2]={{21,0},{22,0},{23,127},{25,64},{26,64},{27,64},{34,0},{35,25},{36,50},{37,0},{38,0},{39,2},{40,0},{41,127},{42,0},{43,64},{44,64},{45,64},{46,64},{51,127},{52,64},{53,64},{54,0},{55,0},{56,127},{57,0},{59,64},{60,64},{62,0},{65,0},{66,0},{69,0},{71,0},{73,2}};
for(const auto&s:settings)check(jp8000_parameter(h,JP8000_PATCH_UPPER,s[0],s[1],1));check(jp8000_parameter(h,JP8000_PERFORMANCE,16,0,1));render(88200);
check(jp8000_parameter(h,JP8000_PATCH_UPPER,33,1,1));
check(jp8000_parameter(h,JP8000_SYSTEM,4,1,1));check(jp8000_parameter(h,JP8000_SYSTEM,9,0,1));
for(auto setting:std::initializer_list<std::array<unsigned,2>>{{21,0},{23,1},{24,0},{25,0},{26,0},{27,0}})check(jp8000_parameter(h,JP8000_PERFORMANCE,setting[0],setting[1],1));render(88200);
for(unsigned status:{0xf1,0xf2,0xf3,0xf6})check(jp8000_midi(h,status,status==0xf1?0x10:0,0,0));
check(jp8000_midi(h,0xfa,0,0,0));for(unsigned note:{60,64,67})check(jp8000_midi(h,0x90,note,100,0));
for(unsigned phase=0;phase<4;++phase){std::ofstream out(std::string(argv[3])+"-"+std::to_string(phase)+".f32",std::ios::binary);if(phase==2)check(jp8000_midi(h,0xfc,0,0,0));if(phase==3){for(unsigned note:{60,64,67})check(jp8000_midi(h,0x80,note,0,0));check(jp8000_midi(h,0xfb,0,0,0));for(unsigned note:{60,64,67})check(jp8000_midi(h,0x90,note,100,0));}const unsigned rate=phase==3?96:48;for(unsigned tick=0;tick<rate*2;++tick){if(phase==1||phase==3)check(jp8000_midi(h,0xf8,0,0,0));render(((tick+1)*88200/rate)-(tick*88200/rate),&out);}}
check(jp8000_midi(h,0xfe,0,0,0));render(128);if(jp8000_midi(h,0xf4,0,0,0)==0||jp8000_midi(h,0xf0,0,0,0)==0||jp8000_midi(h,0xf2,128,0,0)==0)throw std::runtime_error("invalid MIDI accepted");
jp8000_destroy(h);}
