"""Serialized direct speech; completion comes only from authenticated codec events."""
from __future__ import annotations
import logging
import re
import secrets
import threading
import time
import unicodedata
import relay_protocol as proto
log = logging.getLogger('relay.speech')
def _ack_status(ack):
    status=ack.get('status')
    return status if status in {'timeout','ok','accepted','busy','invalid','queue_full','not_provisioned','broker_not_connected','publish_failed','speech_started','speech_finished','speech_cancelled','speech_batch','invalid_payload','replay','expired'} else 'other'
TERMINAL = {'done','failed','cancelled'}
def validate_text(text):
    if not isinstance(text,str) or not 1 <= len(text) <= 1000 or not text.strip():
        raise ValueError('text must contain 1..1000 characters')
    if any(unicodedata.category(c)=='Cc' and c not in '\n\t' for c in text):
        raise ValueError('text contains control characters')
    return text
def validate_key(key):
    if key is not None and (not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',key)):
        raise ValueError('invalid idempotency_key')
    return key
class SpeechService:
    def __init__(self, control, synthesize, secret, timeout_s=180, voice_lock=None, submit=None, wait=None, available=None, cancel_wait_s=5.0):
        self.control,self.synthesize,self.secret=control,synthesize,secret
        self.timeout_s=timeout_s
        self.submit,self.wait=submit,wait
        self.available=available
        self.cancel_wait_s=cancel_wait_s
        self.voice_lock=voice_lock if voice_lock is not None else threading.Lock()
        self.lock=threading.RLock(); self.jobs={}; self.keys={}
    def start(self,text,idempotency_key=None):
        text=validate_text(text); key=validate_key(idempotency_key)
        with self.lock:
            if key in self.keys:
                uid=self.keys[key]; job=self.jobs[uid]
                if job['text']!=text: raise RuntimeError('idempotency_key conflict')
                return self.snapshot(uid)
            if self.available is not None and not self.available(): raise ConnectionError('relay unavailable')
            if not self.voice_lock.acquire(blocking=False): raise RuntimeError('voice busy')
            try:
                while len(self.jobs)>=20:
                    victim=next((u for u,j in self.jobs.items() if j['status'] in TERMINAL and j['worker_done']),None)
                    if victim is None: raise RuntimeError('job capacity reached')
                    self.jobs.pop(victim)
                    self.keys={k:u for k,u in self.keys.items() if u!=victim}
                uid=secrets.token_hex(4)
                while uid in self.jobs: uid=secrets.token_hex(4)
                self.jobs[uid]=dict(id=uid,text=text,status='queued',error='',created_at=time.time(),worker_done=False,
                    cancel_confirmed=False,stopped=threading.Event(),changed=threading.Event(),seq=0,
                    begin_attempted=False,begin_rejected=False,abort_sent=False,frames=0,upload_seconds=0.0,audio_seconds=0.0)
                if key is not None: self.keys[key]=uid
                threading.Thread(target=self._run,args=(uid,),daemon=True,name=f'speech-{uid}').start()
            except Exception:
                self.voice_lock.release(); raise
            return self.snapshot(uid)
    def snapshot(self,uid):
        with self.lock:
            j=self.jobs[uid]
            result={k:j[k] for k in ('id','status','error','created_at','cancel_confirmed','frames','upload_seconds','audio_seconds')}
            result['settled']=j['worker_done']; return result
    def cancel(self,uid):
        with self.lock:
            j=self.jobs[uid]
            if j['status'] not in TERMINAL:
                j['status']='cancelled'; j['stopped'].set(); j['changed'].set()
            return self.snapshot(uid)
    def on_event(self,payload):
        e=proto.open_speech_event(payload,self.secret)
        if e is None: return
        with self.lock:
            j=self.jobs.get(e['id'])
            if j is None or e['seq']<=j['seq']: return
            j['seq']=e['seq']; kind=e.get('kind')
            if kind=='cancelled':
                j['cancel_confirmed']=True
                if j['status']!='done': j['status']='cancelled'; j['stopped'].set()
            elif j['status'] not in TERMINAL:
                if kind=='playing': j['status']='playing'
                elif kind=='done': j['status']='done'
                elif kind=='error': j['status']='failed'; j['error']='robot playback failed'
            j['changed'].set()
    def _run(self,uid):
        j=self.jobs[uid]; stage='synthesis'; deadline=time.monotonic()+self.timeout_s
        def check():
            if j['stopped'].is_set(): return False
            if time.monotonic()>=deadline: raise RuntimeError('speech deadline exceeded')
            return j['status'] not in TERMINAL
        def send(cmd,payload):
            if not check(): return False
            if cmd==11: j['begin_attempted']=True
            ack=self.control(cmd,payload,timeout_s=max(.01,min(5,deadline-time.monotonic())))
            log.log(logging.INFO if ack.get('ok') else logging.WARNING, 'speech id=%s cmd=%d ack=%s ok=%s', uid, cmd, _ack_status(ack), bool(ack.get('ok')))
            if not ack.get('ok'):
                status=str(ack.get('status',''))
                if cmd==11 and status not in ('timeout','broker_not_connected','not_provisioned') and not status.startswith('publish_failed'):
                    j['begin_rejected']=True
                raise RuntimeError('robot command failed')
            return True
        try:
            with self.lock:
                if j['stopped'].is_set(): return
                j['status']='synthesizing'
            frames=self.synthesize(j['text'])
            if not check(): return
            if not frames: raise RuntimeError('no speech audio')
            j['frames']=len(frames); j['audio_seconds']=len(frames)*.06
            if len(frames)>2000: raise RuntimeError('too_long')
            batches=list(proto.batch_frames(frames)); j['frames']=len(frames)
            subtitle=j['text'].encode('utf-8')[:512].decode('utf-8','ignore').encode('utf-8')
            stage='begin'
            log.info('speech id=%s stage=begin frames=%d',uid,len(frames))
            if not send(11,proto.command_payload(uid)+subtitle): return
            stage='upload'
            started=time.monotonic()
            pending=[]
            def await_oldest():
                rid=pending.pop(0)
                ack=self.wait(rid,timeout_s=max(.01,min(5,deadline-time.monotonic())))
                log.log(logging.INFO if ack.get('ok') else logging.WARNING, 'speech id=%s cmd=12 ack=%s ok=%s', uid, _ack_status(ack), bool(ack.get('ok')))
                if not ack.get('ok'): raise RuntimeError('robot upload failed')
            for offset,batch in batches:
                target=started+max(0,offset*.06-.48)
                while time.monotonic()<target:
                    if not check(): return
                    j['stopped'].wait(min(.05,target-time.monotonic()))
                payload=proto.audio_batch(uid,offset,batch)
                if self.submit is not None and self.wait is not None:
                    if len(pending)>=4: await_oldest()
                    if not check(): return
                    pending.append(self.submit(12,payload))
                elif not send(12,payload): return
            while pending:
                if not check(): return
                await_oldest()
            j['upload_seconds']=time.monotonic()-started
            stage='finish'
            if not send(13,proto.command_payload(uid)): return
            stage='playback'
            while check():
                j['changed'].wait(.05); j['changed'].clear()
        except Exception as exc:
            log.warning('speech id=%s stage=%s failed type=%s', uid, stage, type(exc).__name__)
            with self.lock:
                if j['status'] not in TERMINAL:
                    j['status']='failed'; j['error']='too_long' if j['frames']>2000 or (isinstance(exc, ValueError) and str(exc)=='too_long') else 'speech generation, playback or deadline failed'
        finally:
            if j['status'] in {'failed','cancelled'}:
                if not j['begin_attempted'] or j['begin_rejected']:
                    j['cancel_confirmed']=True
                else:
                    j['abort_sent']=True
                    remaining=max(.01,min(5,deadline-time.monotonic()))
                    try: self.control(14,proto.command_payload(uid),timeout_s=remaining)
                    except Exception: pass
                    cancel_deadline=min(deadline,time.monotonic()+self.cancel_wait_s)
                    while not j['cancel_confirmed'] and time.monotonic()<cancel_deadline:
                        j['changed'].wait(min(.05,max(0,cancel_deadline-time.monotonic())))
                        j['changed'].clear()
            with self.lock:
                self.voice_lock.release()
                j['worker_done']=True; j['changed'].set()
