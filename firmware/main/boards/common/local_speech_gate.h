#pragma once
#include <atomic>
#include <cstdint>
// A generation retires server events already received before local ownership.
class LocalSpeechGate {
public:
 bool Active()const{return active_.load();}
 uint32_t Generation()const{return generation_.load();}
 bool AllowsServer(uint32_t epoch)const{return !Active() && epoch==Generation();}
 void Begin(){active_.store(true);generation_.fetch_add(1);}
 void End(){active_.store(false);}
private:
 std::atomic<bool> active_{false};
 std::atomic<uint32_t> generation_{0};
};
