#include "../main/boards/common/local_speech_gate.h"
#include <cassert>
int main(){LocalSpeechGate g;auto stale=g.Generation();assert(g.AllowsServer(stale));g.Begin();assert(!g.AllowsServer(g.Generation()));assert(!g.AllowsServer(stale));g.End();assert(!g.AllowsServer(stale));assert(g.AllowsServer(g.Generation()));}
