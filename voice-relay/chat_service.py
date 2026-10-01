"""One in-flight typed-chat turn against the robot's own xiaozhi session.

The robot keeps its normal role, voice and cloud session: the relay only uploads
silently synthesized input audio and reads back the subtitles it already produces.
"""
from __future__ import annotations

import secrets
import threading
import time

import relay_protocol as proto

TERMINAL = {"done", "error", "cancelled"}
MAX_JOBS = 20


class ChatService:
    """Serialized chat turns. `control(cmd, payload, timeout_s)` sends one signed packet
    and returns the firmware ACK dict; `synthesize(text)` returns Opus frames."""

    def __init__(self, control, synthesize, secret: str, timeout_s: float = 120.0, voice_lock=None):
        self.control = control
        self.synthesize = synthesize
        self.secret = secret
        self.timeout_s = timeout_s
        self.lock = threading.RLock()
        self.control_lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.voice_lock = voice_lock if voice_lock is not None else threading.Lock()

    # ------------------------------------------------------------------ public
    def start(self, text) -> dict:
        cleaned = proto.validate_text(text)
        with self.lock:
            if any(job["status"] not in TERMINAL or not job["worker_done"] for job in self.jobs.values()):
                raise RuntimeError("上一条聊天尚未结束，请等待或取消")
            if not self.voice_lock.acquire(blocking=False):
                raise RuntimeError("voice busy")
            while len(self.jobs) >= MAX_JOBS:
                self.jobs.pop(next(iter(self.jobs)))
            uid = secrets.token_hex(4)
            self.jobs[uid] = dict(
                id=uid, text=cleaned, status="preparing", recognized="", reply="", session="",
                error="", created_at=time.time(), events={}, seq=0, worker_done=False,
                audio_packets=0, cancel_confirmed=False, opened=False, last_control_id="",
                begin_rejected=False, stopped=threading.Event(), changed=threading.Event(),
            )
        threading.Thread(target=self._run, args=(uid,), daemon=True, name=f"chat-{uid}").start()
        return self.snapshot(uid)

    def snapshot(self, uid: str) -> dict:
        with self.lock:
            job = self.jobs.get(uid)
            if job is None:
                raise KeyError("聊天记录不存在或中转服务已重启")
            result = {key: job[key] for key in (
                "id", "text", "status", "recognized", "reply", "session", "error",
                "created_at", "audio_packets", "cancel_confirmed")}
            result["settled"] = job["worker_done"]
            return result

    def cancel(self, uid: str) -> dict:
        with self.lock:
            job = self.jobs.get(uid)
            if job is None:
                raise KeyError("聊天记录不存在或中转服务已重启")
            if job["status"] not in TERMINAL:
                job["status"] = "cancelled"
                job["stopped"].set()
                job["changed"].set()
            return self.snapshot(uid)

    def on_event(self, payload: bytes) -> None:
        event = proto.open_event(payload, self.secret)
        if event is None:
            return
        uid, seq, kind = event["id"], int(event["seq"]), str(event.get("kind") or "")
        with self.lock:
            job = self.jobs.get(uid)
            if job is None or job["status"] in TERMINAL or seq <= job["seq"]:
                return
            text = str(event.get("text") or "")[:8000]
            if kind == "error":
                # A signed transport error must settle immediately, even across a subtitle gap.
                job["status"], job["error"] = "error", text or "小智连接中断"
                job["changed"].set()
                return
            job["events"][seq] = (kind, text, str(event.get("session") or ""), int(event.get("audio_packets") or 0))
            job["changed"].set()
            while job["seq"] + 1 in job["events"]:
                job["seq"] += 1
                kind, text, session, packets = job["events"].pop(job["seq"])
                job["audio_packets"] = max(job["audio_packets"], packets)
                if session:
                    job["session"] = session
                if kind == "recognized":
                    job["recognized"] = text
                elif kind == "speaking":
                    job["status"] = "speaking"
                elif kind == "sentence":
                    job["reply"] += text
                    job["status"] = "speaking"
                elif kind == "done":
                    job["status"] = "done" if job["reply"] else "error"
                    if not job["reply"]:
                        job["error"] = "云端结束了回复，但未收到文字"

    # ----------------------------------------------------------------- private
    def _send(self, uid: str, cmd: int, payload: bytes) -> bool:
        """`payload` is the complete plaintext, chat id included."""
        with self.control_lock:
            with self.lock:
                job = self.jobs[uid]
                if job["stopped"].is_set():
                    return False
            ack = self.control(cmd, payload, timeout_s=12 if cmd == 4 else 5)
            with self.lock:
                job["last_control_id"] = ack.get("request_id", "")
            if not ack.get("ok"):
                # An explicit rejection means the robot is known NOT to be in input mode,
                # so no abort is needed later. A timeout/unknown state still aborts.
                if cmd == 4:
                    with self.lock:
                        job["begin_rejected"] = True
                raise RuntimeError("机器人未完成输入：" + str(ack.get("status", "无回执"))[:80])
            if cmd == 4:
                with self.lock:
                    job["opened"] = True
            return True

    def _abort(self, uid: str) -> dict:
        # Serialized with upload so a cancelled input cannot resume after the abort.
        with self.control_lock:
            return self.control(7, proto.command_payload(uid), timeout_s=5)

    def _run(self, uid: str) -> None:
        job = self.jobs[uid]
        try:
            frames = self.synthesize(job["text"])
            if not frames:
                raise RuntimeError("没有生成输入音频")
            if not self._send(uid, 4, proto.command_payload(uid)):
                return
            with self.lock:
                if job["status"] not in TERMINAL:
                    job["status"] = "uploading"
            for offset, batch in proto.batch_frames(frames):
                if not self._send(uid, 5, proto.audio_batch(uid, offset, batch)):
                    return
            if not self._send(uid, 6, proto.command_payload(uid)):
                return
            with self.lock:
                if job["status"] not in TERMINAL and job["status"] != "speaking":
                    job["status"] = "waiting"
            deadline = time.monotonic() + self.timeout_s
            while True:
                with self.lock:
                    if job["status"] in TERMINAL:
                        break
                if time.monotonic() >= deadline:
                    raise RuntimeError("等待小智回复超时；不会自动重发，请稍后再试")
                job["changed"].wait(0.2)
                job["changed"].clear()
        except Exception as exc:  # noqa: BLE001 - surfaced to the phone as a readable status
            with self.lock:
                if job["status"] not in TERMINAL:
                    job["status"] = "error"
                    job["error"] = str(exc) if isinstance(exc, (RuntimeError, ValueError)) else "静默输入生成或连接失败，请稍后再试"
        finally:
            try:
                # Abort when the robot may already be in input mode (cancel, timeout, lost ACK).
                # If cmd 4 was explicitly rejected nothing was opened, so there is nothing to abort.
                if job["status"] in {"error", "cancelled"} and not job["begin_rejected"]:
                    ack = self._abort(uid)
                    with self.lock:
                        job["cancel_confirmed"] = bool(ack.get("ok"))
                        if not ack.get("ok"):
                            job["error"] += "；取消指令未获确认，机器人会在超时后退出文字输入"
            except Exception:  # noqa: BLE001
                with self.lock:
                    job["error"] += "；取消指令未获确认，请检查机器人连接"
            finally:
                with self.lock:
                    job["worker_done"] = True
                    job["changed"].set()
                self.voice_lock.release()
