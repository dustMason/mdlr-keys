// Actual ordinary Rust archive; no firmware and no custom Rust allocator symbols.
#define MDLR_JP8000_RUST_ONLY 1
#include "JP8000RustHost.hpp"
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <new>
static bool track=false;static size_t allocations=0;
void* operator new(size_t n){if(track)++allocations;if(auto p=std::malloc(n))return p;throw std::bad_alloc();}
void operator delete(void* p)noexcept{std::free(p);}
template<class T,typename T::type Member>struct Access{friend typename T::type access(T){return Member;}};
struct Budget{using type=unsigned JP8000RustHost::*;friend type access(Budget);};
struct Pending{using type=size_t JP8000RustHost::*;friend type access(Pending);};
template struct Access<Budget,&JP8000RustHost::controlsRemaining_>;
template struct Access<Pending,&JP8000RustHost::pendingCount_>;
static std::array<float,256> l{},r{};
static unsigned cases=0;
static unsigned render(JP8000RustHost& h,unsigned block){track=true;h.render48k(l.data(),r.data(),block);track=false;assert(allocations==0);for(unsigned i=0;i<block;++i)assert(std::isfinite(l[i])&&std::isfinite(r[i]));const auto n=256-(h.*access(Budget{}));assert(n<=256);return n;}
static int field(const std::string& s,const char* scope,unsigned id){return std::stoi(jp8000_detail::jsonValue(jp8000_detail::jsonValue(s,scope,"{}"),std::to_string(id).c_str(),"-999"));}
static int value(const std::string&s,const char*key){return std::stoi(jp8000_detail::jsonValue(s,key,"-999"));}
static auto host(){auto h=std::make_unique<JP8000RustHost>();h->setActive(true);render(*h,64);return h;}
static void stage(JP8000RustHost&h){for(unsigned i=0;i<8;++i)assert(render(h,0)==0);assert((h.*access(Pending{}))==2048);}
static void both_backlog(unsigned block){
 auto h=host();for(unsigned i=0;i<2048;++i)assert(h->partParameter(2,41,i/256*16+i%16));stage(*h);h->panic();
 for(unsigned pass=0;pass<8;++pass){assert(render(*h,block)==256);const auto s=h->snapshotJSON();assert(field(s,"params_upper",41)==int(pass*16+15)&&field(s,"params_lower",41)==int(pass*16+15));assert((h.get()->*access(Pending{}))==2048-(pass+1)*256);for(unsigned i=0;i<block;++i)assert(l[i]==0&&r[i]==0);}
 assert(h->droppedEvents()==0&&value(h->snapshotJSON(),"rejected_commands")==0);++cases;
}
static void selections_new_notes_and_atomic_rejection(){
 auto h=host();for(unsigned i=0;i<255;++i)assert(h->partParameter(0,41,64));
 assert(h->parameter(2018,1));assert(h->parameter(31,71));
 const uint16_t ui[]={41},uv[]={30},li[]={30},lv[]={9},ci[]={2018},cv[]={2};
 assert(h->applyPerformance(ui,uv,1,li,lv,1,ci,cv,1));assert(h->parameter(31,72));
 assert(h->parameter(2018,0));assert(h->parameter(31,73));
 const uint16_t good[]={79},lower[]={31},select[]={1};assert(h->applyPerformance(nullptr,nullptr,0,lower,good,1,ci,select,1));assert(h->parameter(51,111));
 for(unsigned i=263;i<2048;++i)assert(h->partParameter(0,41,64));stage(*h);h->panic();
 assert(h->parameter(31,99));assert(h->partParameter(0,31,88));assert(h->midi(0x91,60,100));
 for(unsigned pass=0;pass<8;++pass){assert(render(*h,64)==256);for(unsigned i=0;i<64;++i)assert(l[i]==0&&r[i]==0);}
 auto s=h->snapshotJSON();assert(value(s,"part")==1&&field(s,"params_upper",31)==73&&field(s,"params_lower",31)==79&&field(s,"params_upper",41)==64);
 assert(value(s,"rejected_commands")==2);assert(render(*h,64)==2);s=h->snapshotJSON();assert(field(s,"params_upper",31)==88&&field(s,"params_lower",31)==99);
 float peak=0;for(unsigned n=0;n<80;++n){render(*h,64);for(unsigned i=0;i<64;++i)peak=std::max(peak,std::abs(l[i]));}assert(peak>1e-4f&&h->droppedEvents()==0);++cases;
}
static void repeat_panic_and_queued_suffix(){
 auto h=host();for(unsigned i=0;i<2048;++i)assert(h->partParameter(0,41,64));stage(*h);
 assert(h->parameter(2018,1));assert(h->parameter(41,89));
 for(unsigned pass=0;pass<8;++pass){assert(h->midi(0x90,60,100));h->panic();assert(render(*h,0)==0);assert(render(*h,64)==256);for(unsigned i=0;i<64;++i)assert(l[i]==0&&r[i]==0);}
 assert(render(*h,64)==2);const auto s=h->snapshotJSON();assert(value(s,"part")==1&&field(s,"params_lower",41)==89&&h->droppedEvents()==0);++cases;
}
static void partial_recovery_space(){
 for(bool patch:{false,true}){
  auto h=host();for(unsigned i=0;i<2047;++i)assert(h->partParameter(0,41,64));
  for(unsigned i=0;i<8;++i)assert(render(*h,0)==0);assert((h.get()->*access(Pending{}))==2047);
  h->panic();assert(render(*h,0)==0);assert(h->parameter(2018,1));
  if(patch){const uint16_t ci[]={2018},cv[]={2};assert(h->applyPerformance(nullptr,nullptr,0,nullptr,nullptr,0,ci,cv,1));}
  else assert(h->parameter(2018,2));
  assert(h->parameter(41,99));assert(render(*h,0)==0);assert((h.get()->*access(Pending{}))==2048);
  for(unsigned i=0;i<8;++i)assert(render(*h,64)==256);
  assert(value(h->snapshotJSON(),"part")==1);assert(render(*h,64)==2);auto s=h->snapshotJSON();
  assert(value(s,"part")==2&&field(s,"params_upper",41)==99&&field(s,"params_lower",41)==99&&h->droppedEvents()==0);++cases;
 }
}
int main(){for(unsigned block:{64u,128u,256u})both_backlog(block);selections_new_notes_and_atomic_rejection();repeat_panic_and_queued_suffix();partial_recovery_space();std::cout<<"{\"passed\":true,\"cases\":"<<cases<<",\"control_budget\":256,\"full2048_staging_asserted\":true,\"cpp_callback_allocations\":"<<allocations<<",\"rust_callback_allocation_instrumentation\":false,\"rust_callback_allocations\":null,\"firmware_inputs\":[]}\n";}
