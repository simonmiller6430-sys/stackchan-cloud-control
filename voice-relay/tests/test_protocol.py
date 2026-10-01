"""Relay protocol tests: byte-exact control envelopes and signed reply events.

These mirror what the firmware in firmware/ actually accepts, so they must stay
byte-exact. Run with:  python -m unittest discover -s voice-relay/tests -v
"""
from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import secrets
import sys
import threading
import time
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parents[2]
RELAY = ROOT / "voice-relay"
sys.path.insert(0, str(RELAY))

import relay_protocol as proto  # noqa: E402
import chat_service as chat  # noqa: E402

SECRET = "ab" * 32


def seal_event(data: dict, key: str = SECRET) -> bytes:
    """What the robot's SealChatEvent() produces: HMAC || IV || AES-GCM(json)."""
    nonce = secrets.token_bytes(12)
    body = nonce + AESGCM(hashlib.sha256(key.encode()).digest()).encrypt(
        nonce, json.dumps(data, ensure_ascii=False).encode(), b"stackchan-chat-event-v1")
    return hmac.new(key.encode(), body, hashlib.sha256).digest()[:16] + body


class EnvelopeTests(unittest.TestCase):
    def test_plain_commands_are_exactly_71_bytes(self):
        # The firmware rejects any 4..7 packet that is not exactly 71 bytes, except cmd5.
        for cmd in (4, 6, 7):
            wire = proto.build(cmd, b"01020304", SECRET)
            self.assertEqual(len(wire), 71, f"cmd{cmd} must be 71 bytes on the wire")
            self.assertEqual(wire[0], 5)
            self.assertEqual(wire[1], 3)
            self.assertEqual(wire[2], cmd)

    def test_audio_batch_plaintext_layout(self):
        frames = [b"a" * 10, b"b" * 20]
        plain = proto.audio_batch("01020304", 12, frames)
        self.assertEqual(plain[:8], b"01020304")
        self.assertEqual(int.from_bytes(plain[8:10], "big"), 12)
        self.assertEqual(plain[10], 2)
        self.assertEqual(plain[11:13], (10).to_bytes(2, "big"))
        self.assertEqual(plain[13:23], b"a" * 10)
        self.assertEqual(plain[23:25], (20).to_bytes(2, "big"))
        self.assertEqual(plain[25:45], b"b" * 20)
        self.assertEqual(len(plain), 8 + 3 + 2 + 10 + 2 + 20)

    def test_batch_packer_respects_firmware_limits(self):
        frames = [b"x" * 100] * 30
        batches = list(proto.batch_frames(frames))
        self.assertEqual(sum(len(b) for _, b in batches), 30)
        for offset, batch in batches:
            self.assertLessEqual(len(batch), 12, "firmware accepts at most 12 frames per batch")
            self.assertLessEqual(sum(len(f) + 2 for f in batch), 1500)
            self.assertGreaterEqual(offset, 0)
            self.assertLessEqual(offset + len(batch), 2000)
            for frame in batch:
                self.assertTrue(1 <= len(frame) <= 1000)
        # offsets must be contiguous frame indexes, which the firmware checks strictly
        expected = 0
        for offset, batch in batches:
            self.assertEqual(offset, expected)
            expected += len(batch)
        self.assertEqual(expected, 30)

    def test_envelope_is_signed_and_encrypted_with_the_documented_keys(self):
        wire = proto.build(4, b"01020304", SECRET, request_id="aabbccdd", now=1700000000)
        body, mac = wire[:-16], wire[-16:]
        self.assertEqual(mac, hmac.new(SECRET.encode(), body, hashlib.sha256).digest()[:16])
        header = body[:11]
        # header: [5][3][cmd][request_id:4][issued_at:4] — request id is NOT the chat id
        self.assertEqual(header[0], 5)
        self.assertEqual(header[1], 3)
        self.assertEqual(header[2], 4)
        self.assertEqual(header[3:7], bytes.fromhex("aabbccdd"))
        self.assertEqual(int.from_bytes(header[7:11], "big"), 1700000000)
        # layout: header(11) iv(12) ciphertext(8) tag(16) nonce(8)
        enc = body[11:-8]
        self.assertEqual(len(enc), 12 + 8 + 16)
        plain = AESGCM(hashlib.sha256(SECRET.encode()).digest()).decrypt(enc[:12], enc[12:], header)
        self.assertEqual(plain, b"01020304")

    def test_chat_id_length_and_alphabet_are_enforced(self):
        with self.assertRaises(ValueError):
            proto.build(4, b"0102030", SECRET)
        with self.assertRaises(ValueError):
            proto.build(4, "0102030Z", SECRET)
        with self.assertRaises(ValueError):
            proto.build(4, "0102030", SECRET)
        # bytes are also accepted so callers cannot accidentally double-encode the id
        self.assertEqual(len(proto.build(4, b"01020304", SECRET)), 71)


class EventTests(unittest.TestCase):
    def test_opens_a_real_firmware_event(self):
        payload = seal_event({"id": "01020304", "seq": 3, "kind": "sentence",
                              "text": "你好", "session": "s1", "audio_packets": 7})
        event = proto.open_event(payload, SECRET)
        self.assertEqual(event["kind"], "sentence")
        self.assertEqual(event["text"], "你好")
        self.assertEqual(event["seq"], 3)

    def test_rejects_wrong_key_tampering_and_plaintext(self):
        good = seal_event({"id": "01020304", "seq": 1, "kind": "done"})
        self.assertIsNone(proto.open_event(good, "ff" * 32))
        tampered = bytearray(good)
        tampered[-1] ^= 1
        self.assertIsNone(proto.open_event(bytes(tampered), SECRET))
        plain = json.dumps({"id": "01020304", "seq": 1, "kind": "done"}).encode()
        self.assertIsNone(proto.open_event(hmac.new(SECRET.encode(), plain, hashlib.sha256).digest()[:16] + plain, SECRET))
        self.assertIsNone(proto.open_event(b"short", SECRET))
        self.assertIsNone(proto.open_event(b"x" * 13000, SECRET))


class OggTests(unittest.TestCase):
    def test_extracts_packets_across_pages_and_skips_headers(self):
        def page(parts: list[int], data: bytes) -> bytes:
            return b"OggS" + bytes(22) + bytes([len(parts)]) + bytes(parts) + data
        ogg = page([8, 8, 255], b"OpusHeadOpusTags" + b"a" * 255) + page([3, 2], b"bbbcc")
        self.assertEqual(proto.ogg_opus_packets(ogg), [b"a" * 255 + b"bbb", b"cc"])

    def test_truncated_container_is_rejected(self):
        with self.assertRaises(ValueError):
            proto.ogg_opus_packets(b"OggS" + bytes(26) + bytes([2]) + b"ab")


class ChatJobTests(unittest.TestCase):
    def make(self, frames=None, timeout=0.4, ok=True):
        # Note: `control` receives the complete plaintext, chat id included.
        calls: list[tuple[int, bytes]] = []

        def control(cmd, payload, timeout_s=5):
            calls.append((cmd, payload))
            return {"ok": ok, "request_id": "0" * 8, "status": "applied"} if ok else {"ok": False, "status": "busy"}

        service = chat.ChatService(control, lambda text: (frames or [b"frame"] * 13), SECRET, timeout_s=timeout)
        return service, calls

    def wait(self, service, uid, statuses):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            state = service.snapshot(uid)
            if state["status"] in statuses:
                return state
            time.sleep(0.01)
        raise AssertionError(service.snapshot(uid))

    def test_input_validation_and_single_active_request(self):
        service, _ = self.make()
        for bad in ["", "   ", "字" * 301, 42, "abc\x00def"]:
            with self.assertRaises(ValueError):
                service.start(bad)
        uid = service.start("请记住我的杯子是蓝色的。")["id"]
        with self.assertRaises(RuntimeError):
            service.start("第二条")
        service.cancel(uid)

    def test_audio_is_sent_in_frame_index_order_on_commands_5_then_6(self):
        service, calls = self.make()
        uid = service.start("安静输入")["id"]
        self.wait(service, uid, {"waiting"})
        self.assertEqual([cmd for cmd, _ in calls], [4, 5, 5, 6])
        self.assertTrue(all(payload[:8] == uid.encode() for _, payload in calls))
        offsets = [int.from_bytes(p[8:10], "big") for cmd, p in calls if cmd == 5]
        self.assertEqual(offsets, [0, 12])
        service.cancel(uid)

    def test_failed_begin_sends_no_audio_and_no_abort(self):
        # The robot rejected cmd4, so it never entered input mode: uploading frames or
        # aborting would be wrong. The error must still be visible to the phone.
        service, calls = self.make(ok=False)
        uid = service.start("你好")["id"]
        state = self.wait(service, uid, {"error"})
        self.assertIn("busy", state["error"])
        self.assertEqual([cmd for cmd, _ in calls], [4])

    def test_signed_events_arrive_out_of_order_and_deduplicate(self):
        service, _ = self.make()
        uid = service.start("你好")["id"]
        self.wait(service, uid, {"waiting"})
        events = [
            {"id": uid, "seq": 1, "kind": "ready", "session": "existing"},
            {"id": uid, "seq": 2, "kind": "recognized", "text": "你好"},
            {"id": uid, "seq": 3, "kind": "sentence", "text": "第一句。"},
            {"id": uid, "seq": 4, "kind": "sentence", "text": "第二句。"},
            {"id": uid, "seq": 5, "kind": "done"},
        ]
        for index in [0, 4, 3, 3, 2, 1]:
            service.on_event(seal_event(events[index]))
        state = service.snapshot(uid)
        self.assertEqual(state["status"], "done")
        self.assertEqual(state["reply"], "第一句。第二句。")
        self.assertEqual(state["recognized"], "你好")
        self.assertEqual(state["session"], "existing")

    def test_foreign_id_bad_signature_and_garbage_are_ignored(self):
        service, _ = self.make()
        uid = service.start("你好")["id"]
        self.wait(service, uid, {"waiting"})
        service.on_event(seal_event({"id": uid, "seq": 1, "kind": "done"}, "wrong-key"))
        service.on_event(seal_event({"id": "00000000", "seq": 1, "kind": "done"}))
        service.on_event(b"invalid")
        self.assertEqual(service.snapshot(uid)["status"], "waiting")
        service.cancel(uid)

    def test_signed_error_settles_without_waiting_for_a_gap(self):
        service, _ = self.make()
        uid = service.start("你好")["id"]
        self.wait(service, uid, {"waiting"})
        service.on_event(seal_event({"id": uid, "seq": 9, "kind": "error", "text": "小智会话连接已断开"}))
        state = service.snapshot(uid)
        self.assertEqual(state["status"], "error")
        self.assertIn("断开", state["error"])

    def test_done_without_text_is_reported_as_an_error(self):
        service, _ = self.make()
        uid = service.start("你好")["id"]
        self.wait(service, uid, {"waiting"})
        service.on_event(seal_event({"id": uid, "seq": 1, "kind": "done"}))
        self.assertEqual(service.snapshot(uid)["status"], "error")

    def test_timeout_aborts_once_without_resending(self):
        service, calls = self.make(timeout=0.3)
        uid = service.start("你好")["id"]
        state = self.wait(service, uid, {"error"})
        self.assertIn("超时", state["error"])
        self.assertEqual(sum(1 for cmd, _ in calls if cmd == 4), 1)
        self.assertEqual(sum(1 for cmd, _ in calls if cmd == 7), 1)

    def test_cancel_during_synthesis_sends_nothing(self):
        gate = threading.Event()
        service, calls = self.make()
        service.synthesize = lambda text: (gate.wait(2), [b"frame"])[1]
        uid = service.start("你好")["id"]
        service.cancel(uid)
        gate.set()
        self.wait(service, uid, {"cancelled"})
        self.assertFalse(any(cmd == 4 for cmd, _ in calls))

    def test_unknown_job_id_and_cancel_are_reported(self):
        service, _ = self.make()
        with self.assertRaises(KeyError):
            service.snapshot("deadbeef")
        with self.assertRaises(KeyError):
            service.cancel("deadbeef")


if __name__ == "__main__":
    unittest.main()
