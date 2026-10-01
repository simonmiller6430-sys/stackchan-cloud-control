#include "../main/boards/m5stack-core-s3/speech_state.h"
#include <cassert>
#include <iostream>
std::string batch(std::string id, int offset) { return id + char(offset>>8)+char(offset)+char(1)+char(0)+char(1)+char(42); }
int main() {
 SpeechState s;
 assert(!s.Begin("bad", true));
 assert(!s.Begin("12345678"+std::string(513,'a'), true));
 assert(!s.Begin("12345678text", false));
 assert(!s.Begin("ABCDEFGHtext",true));
 assert(!s.Begin(std::string("12345678")+char(0xff),true));
 assert(s.Begin("12345678text", true));
 assert(!s.Begin("87654321x", true));
 assert(!s.Batch(batch("12345678",1)));
 assert(!s.Batch(batch("87654321",0)));
 assert(s.Batch(batch("12345678",0)));
 assert(!s.Batch(batch("12345678",0)));
 assert(!s.Batch(batch("12345678",1)+"x"));
 assert(!s.Finish("12345678x"));
 assert(s.Finish("12345678"));
 assert(!s.Batch(batch("12345678",1)));
 assert(!s.Ready());
 assert(s.Output()); assert(s.Ready());
 s.Retire(); assert(!s.Begin("12345678text",true));
 assert(s.Begin("87654321text",true));
 assert(!s.Cancel("12345678")); assert(s.Cancel("87654321"));
 assert(!s.Begin("87654321text",true));
 SpeechState limit; assert(limit.Begin("aaaaaaaaok",true));
 assert(!limit.Finish("aaaaaaaa"));
 for(int i=0;i<2000;i++) assert(limit.Batch(batch("aaaaaaaa",i)));
 assert(!limit.Batch(batch("aaaaaaaa",2000)));
 assert(limit.Finish("aaaaaaaa"));
 for(int i=0;i<2000;i++) {limit.Output(); if(i<1999)assert(!limit.Ready());}
 assert(limit.Ready());
 SpeechState utf; assert(!utf.Begin(std::string("bbbbbbbb")+char(0xc0)+char(0x80),true));
 assert(!utf.Begin(std::string("bbbbbbbb")+char(0xed)+char(0xa0)+char(0x80),true));
 assert(utf.Begin(std::string("bbbbbbbb")+char(0xe4)+char(0xb8)+char(0xad),true));
 std::cout << "speech state bounds/order/replay/output/cancel passed\n";
}
