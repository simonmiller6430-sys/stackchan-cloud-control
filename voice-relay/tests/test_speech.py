import sys, unittest, threading, time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
class SpeechTests(unittest.TestCase):
 def test_feature_exists(self):
  import importlib.util
  self.assertIsNotNone(importlib.util.find_spec('speech_service'))
 def test_cancel_synthesis_holds_admission_and_uploads_nothing(self):
  from speech_service import SpeechService
  gate=threading.Event(); entered=threading.Event(); calls=[]; lock=threading.Lock()
  def synth(text): entered.set(); gate.wait(2); return [b'a']
  svc=SpeechService(lambda c,p,timeout_s: calls.append(c) or {'ok':True},synth,'a'*64,voice_lock=lock)
  job=svc.start('你好','same'); entered.wait(1)
  self.assertEqual(job['id'],svc.start('你好','same')['id'])
  with self.assertRaises(RuntimeError): svc.start('不同','same')
  svc.cancel(job['id']); self.assertFalse(svc.snapshot(job['id'])['settled'])
  with self.assertRaises(RuntimeError): svc.start('第二条')
  gate.set()
  for _ in range(100):
   if svc.snapshot(job['id'])['settled']: break
   time.sleep(.01)
  self.assertEqual(calls,[]); self.assertTrue(svc.snapshot(job['id'])['cancel_confirmed']); self.assertFalse(lock.locked())
 def test_upload_ack_does_not_complete(self):
  from speech_service import SpeechService
  sent=threading.Event()
  def control(c,p,timeout_s):
   if c==13: sent.set()
   return {'ok':True}
  svc=SpeechService(control,lambda t:[b'a'],'a'*64,timeout_s=.1)
  job=svc.start('hello'); sent.wait(1)
  self.assertNotEqual(svc.snapshot(job['id'])['status'],'done')
  time.sleep(.3); self.assertEqual(svc.snapshot(job['id'])['status'],'failed')
 def test_validation(self):
  from speech_service import validate_text,validate_key
  for text in ['', 'x'*1001, 'a\x00', 'a\x7f']:
   with self.assertRaises(ValueError): validate_text(text)
  self.assertEqual(validate_text('你'*1000),'你'*1000)
  with self.assertRaises(ValueError): validate_key('中文')
if __name__=='__main__': unittest.main()

class SpeechEventTests(unittest.TestCase):
 def seal(self,uid,seq,kind,aad=b'stackchan-speech-event-v1'):
  import hmac,hashlib,json
  from cryptography.hazmat.primitives.ciphers.aead import AESGCM
  iv=b'0'*12; secret='a'*64
  body=iv+AESGCM(hashlib.sha256(secret.encode()).digest()).encrypt(iv,json.dumps(dict(id=uid,seq=seq,kind=kind)).encode(),aad)
  return hmac.new(secret.encode(),body,hashlib.sha256).digest()[:16]+body
 def test_signed_done_only_and_replay_protection(self):
  from speech_service import SpeechService
  import relay_protocol as proto
  sent=threading.Event()
  def control(c,p,timeout_s):
   if c==13: sent.set()
   return {'ok':True}
  svc=SpeechService(control,lambda t:[b'a'],'a'*64)
  uid=svc.start('hello')['id']; sent.wait(1)
  wrong=self.seal(uid,1,'done',b'stackchan-chat-event-v1')
  svc.on_event(wrong); self.assertNotEqual(svc.snapshot(uid)['status'],'done')
  svc.on_event(self.seal(uid,1,'playing')); self.assertEqual(svc.snapshot(uid)['status'],'playing')
  svc.on_event(self.seal(uid,1,'done')); self.assertEqual(svc.snapshot(uid)['status'],'playing')
  svc.on_event(self.seal(uid,2,'done'))
  for _ in range(100):
   if svc.snapshot(uid)['settled']: break
   time.sleep(.01)
  self.assertEqual(svc.snapshot(uid)['status'],'done'); self.assertTrue(svc.snapshot(uid)['settled'])
 def test_cancel_ack_is_not_signed_confirmation(self):
  from speech_service import SpeechService
  sent=threading.Event(); calls=[]
  def control(c,p,timeout_s):
   calls.append(c)
   if c==13: sent.set()
   return {'ok':True}
  svc=SpeechService(control,lambda t:[b'a'],'a'*64,cancel_wait_s=.05)
  uid=svc.start('hello')['id']; sent.wait(1); svc.cancel(uid)
  for _ in range(100):
   if svc.snapshot(uid)['settled']: break
   time.sleep(.01)
  self.assertEqual(calls.count(14),1); self.assertFalse(svc.snapshot(uid)['cancel_confirmed'])
  svc.on_event(self.seal(uid,1,'cancelled')); self.assertTrue(svc.snapshot(uid)['cancel_confirmed'])
 def test_long_audio_clear_error(self):
  from speech_service import SpeechService
  calls=[]
  svc=SpeechService(lambda *a,**k:calls.append(a),lambda t:[b'a']*2001,'a'*64)
  uid=svc.start('hello')['id']
  for _ in range(100):
   if svc.snapshot(uid)['settled']: break
   time.sleep(.01)
  self.assertEqual(svc.snapshot(uid)['error'],'too_long'); self.assertEqual(calls,[])

class PipelineTests(unittest.TestCase):
 def test_bounded_ordered_pipeline(self):
  from speech_service import SpeechService
  pending=[]; offsets=[]; peak=[0]; finished=threading.Event()
  def submit(c,p):
   self.assertEqual(c,12); offsets.append(int.from_bytes(p[8:10],'big'))
   rid=str(len(offsets)); pending.append(rid); peak[0]=max(peak[0],len(pending)); return rid
  def wait(rid,timeout_s):
   self.assertEqual(pending.pop(0),rid); return {'ok':True}
  def control(c,p,timeout_s):
   if c==13: self.assertEqual(pending,[]); finished.set()
   return {'ok':True}
  svc=SpeechService(control,lambda t:[b'a'*180]*36,'a'*64,submit=submit,wait=wait)
  uid=svc.start('hello')['id']; self.assertTrue(finished.wait(4))
  self.assertGreater(peak[0],1); self.assertLessEqual(peak[0],4)
  self.assertEqual(offsets,[0,8,16,24,32]); svc.cancel(uid)

class HttpTests(unittest.TestCase):
 def setUp(self):
  from http.server import ThreadingHTTPServer
  from types import SimpleNamespace
  import server
  from speech_service import SpeechService
  self.gate=threading.Event()
  svc=SpeechService(lambda *a,**kw:{'ok':True},lambda t:self.gate.wait(2) or [b'a'],'a'*64)
  self.relay=SimpleNamespace(speech=svc,service=svc,config={'relay_token':'b'*32,'device_control_secret':'a'*64,'robot_mac':'123456'},ready=True,link=SimpleNamespace(connected=threading.Event()))
  self.relay.link.connected.set()
  svc.available=self.relay.link.connected.is_set
  class H(server.Handler): pass
  H.relay=self.relay
  self.http=ThreadingHTTPServer(('127.0.0.1',0),H)
  threading.Thread(target=self.http.serve_forever,daemon=True).start()
 def tearDown(self):
  self.gate.set(); self.http.shutdown(); self.http.server_close()
 def request(self,path,body=None,method='POST',length=None):
  import http.client,json
  c=http.client.HTTPConnection('127.0.0.1',self.http.server_port)
  raw=json.dumps(body).encode() if body is not None else b'{}'
  headers={'Authorization':'Bearer '+'b'*32,'Content-Type':'application/json'}
  if length is not None: headers['Content-Length']=length
  c.request(method,path,raw,headers); r=c.getresponse(); status=r.status; data=json.loads(r.read()); c.close(); return status,data
 def test_http_status_validation_idempotency_and_cancel(self):
  status,j=self.request('/speak',{'text':'你'*1000,'idempotency_key':'same'})
  self.assertEqual(status,202)
  self.assertEqual(self.request('/speak',{'text':'你'*1000,'idempotency_key':'same'})[1]['id'],j['id'])
  self.assertEqual(self.request('/speak',{'text':'other','idempotency_key':'same'})[0],409)
  self.assertEqual(self.request('/speak',{'text':'a\x00'})[0],400)
  self.assertEqual(self.request('/speak/00000000',method='GET')[0],404)
  self.assertEqual(self.request('/speak/'+j['id']+'/cancel')[0],200)
  self.assertEqual(self.request('/speak',{'text':'x'},length='-1')[0],400)
 def test_unavailable_is_generic503(self):
  self.relay.link.connected.clear()
  self.assertEqual(self.request('/speak',{'text':'hello'})[0],503)
 def test_health_has_no_credentials(self):
  _,j=self.request('/healthz',method='GET')
  self.assertTrue(j['speech_supported']); self.assertNotIn('a'*64,str(j)); self.assertNotIn('b'*32,str(j))

class AdmissionTests(unittest.TestCase):
 def test_chat_and_speech_share_admission(self):
  from speech_service import SpeechService
  from chat_service import ChatService
  lock=threading.Lock(); entered=threading.Event(); gate=threading.Event()
  def synth(t): entered.set(); gate.wait(2); return [b'a']
  speech=SpeechService(lambda *a,**k:{'ok':True},synth,'a'*64,voice_lock=lock)
  chat=ChatService(lambda *a,**k:{'ok':True},synth,'a'*64,voice_lock=lock)
  uid=speech.start('hello')['id']; entered.wait(1)
  with self.assertRaises(RuntimeError): chat.start('hello')
  speech.cancel(uid); gate.set()
  for _ in range(100):
   if speech.snapshot(uid)['settled']: break
   time.sleep(.01)
  self.assertFalse(lock.locked())
 def test_missing_begin_ack_aborts_once(self):
  from speech_service import SpeechService
  calls=[]
  def control(c,p,timeout_s): calls.append(c); return {'ok':False,'status':'timeout'}
  svc=SpeechService(control,lambda t:[b'a'],'a'*64,cancel_wait_s=.05)
  uid=svc.start('hello')['id']
  for _ in range(100):
   if svc.snapshot(uid)['settled']: break
   time.sleep(.01)
  self.assertEqual(calls,[11,14]); self.assertFalse(svc.snapshot(uid)['cancel_confirmed'])

class CancelAdmissionTests(unittest.TestCase):
 seal=SpeechEventTests.seal
 def test_cancel_wait_holds_admission_until_signed_confirmation(self):
  from speech_service import SpeechService
  finished=threading.Event(); aborted=threading.Event(); lock=threading.Lock()
  def control(c,p,timeout_s):
   if c==13: finished.set()
   if c==14: aborted.set()
   return {'ok':True}
  svc=SpeechService(control,lambda t:[b'a'],'a'*64,voice_lock=lock)
  uid=svc.start('hello')['id']; finished.wait(1); svc.cancel(uid); aborted.wait(1)
  self.assertFalse(svc.snapshot(uid)['settled']); self.assertTrue(lock.locked())
  svc.on_event(self.seal(uid,1,'cancelled'))
  for _ in range(100):
   if svc.snapshot(uid)['settled']: break
   time.sleep(.01)
  self.assertTrue(svc.snapshot(uid)['settled']); self.assertFalse(lock.locked())

class DiagnosticsTests(unittest.TestCase):
 def test_safe_command_failure_log_contains_stage_not_text(self):
  from speech_service import SpeechService
  text='private utterance'; calls=[]
  def control(c,p,timeout_s): calls.append(c); return {'ok':False,'status':'timeout'}
  with self.assertLogs('relay.speech',level='WARNING') as logs:
   svc=SpeechService(control,lambda t:[b'a'],'a'*64,cancel_wait_s=.01)
   uid=svc.start(text)['id']
   for _ in range(100):
    if svc.snapshot(uid)['settled']: break
    time.sleep(.01)
  output=' '.join(logs.output)
  self.assertIn('cmd=11',output); self.assertIn('ack=timeout',output)
  self.assertNotIn(text,output); self.assertNotIn('a'*64,output)
