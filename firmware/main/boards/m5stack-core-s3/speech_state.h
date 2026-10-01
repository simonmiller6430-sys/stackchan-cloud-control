#pragma once
#include <string>
#include <deque>
#include <vector>
#include <utility>
#include <cstdint>
// Main application task owns this state. Retired ids prevent delayed jobs restarting.
class SpeechState {
public:
 std::string id;
 unsigned accepted=0, output=0, seq=0;
 bool active=false, finished=false;
 std::vector<std::pair<size_t,size_t>> frames;
 bool Begin(const std::string& p,bool idle) {
  if(active || !idle || p.size()<9 || p.size()>520) return false;
  if(p.substr(0,8).find_first_not_of("0123456789abcdef")!=std::string::npos)return false;
  // Reject malformed UTF-8, NUL, overlong sequences, surrogate and out-of-range codepoints.
  for(size_t i=8;i<p.size();) {
   unsigned char c=p[i++]; unsigned n=0, v=0, min=0;
   if(c<128) {if(!c)return false;continue;}
   if(c>=0xc2&&c<=0xdf){n=1;v=c&31;min=128;}
   else if(c>=0xe0&&c<=0xef){n=2;v=c&15;min=2048;}
   else if(c>=0xf0&&c<=0xf4){n=3;v=c&7;min=65536;}else return false;
   if(i+n>p.size())return false;
   while(n--) {unsigned char x=p[i++];if((x&0xc0)!=0x80)return false;v=(v<<6)|(x&63);}
   if(v<min||v>0x10ffff||(v>=0xd800&&v<=0xdfff))return false;
  }
  auto key=p.substr(0,8); for(auto& old:retired_) if(old==key)return false;
  id=key; accepted=output=seq=0; active=true; finished=false; return true;
 }
 bool Batch(const std::string& p) {
  frames.clear(); if(!active || finished || p.size()<14 || p.size()>1837 || p.substr(0,8)!=id)return false;
  auto u=[&p](size_t i){return static_cast<unsigned char>(p[i]);};
  unsigned offset=(u(8)<<8)|u(9), count=u(10);
  if(offset!=accepted || count<1 || count>12 || offset+count>2000)return false;
  size_t pos=11;
  for(unsigned i=0;i<count;i++) { if(pos+2>p.size())return false; size_t n=(u(pos)<<8)|u(pos+1);pos+=2; if(n<1||n>1000||pos+n>p.size())return false;frames.emplace_back(pos,n);pos+=n; }
  if(pos!=p.size()) {frames.clear();return false;} accepted+=count;return true;
 }
 bool Finish(const std::string& p){if(!active||finished||p!=id||!accepted)return false;finished=true;return true;}
 bool Output(){if(!active||output>=accepted)return false;return ++output==1;}
 bool Ready()const{return active&&finished&&accepted&&output==accepted;}
 bool Cancel(const std::string& p){if(!active||p!=id)return false;Retire();return true;}
 void Retire(){if(active){retired_.push_back(id);if(retired_.size()>64)retired_.pop_front();}active=false;frames.clear();}
private: std::deque<std::string> retired_;
};
