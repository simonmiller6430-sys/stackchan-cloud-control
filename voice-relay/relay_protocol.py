"""Byte-exact StackChan control envelopes and reply-event decoding.

Downlink (relay -> robot) control packet, version 3 for typed chat:

    [5][3][cmd][request_id:4][issued_at:4][iv:12][AES-GCM(payload, aad=header)][nonce:8][hmac:16]

    * HMAC key  = the ASCII text of the device control secret (64 lowercase hex chars)
    * AES-256 key = SHA-256(that same ASCII text)
    * AAD       = the 11-byte header
    * The firmware silently drops a packet whose HMAC does not match, and drops any
      cmd 4..7 packet whose total length is not exactly 71 bytes (except cmd 5).

Uplink reply event (robot -> relay), what firmware SealChatEvent() produces:

    [hmac:16][iv:12][AES-GCM(json, aad=b"stackchan-chat-event-v1")]

Keeping this file free of I/O makes the wire format unit-testable on its own.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from typing import Iterator

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PROTOCOL_VERSION = 5
CHAT_ENVELOPE_VERSION = 3
EVENT_AAD = b"stackchan-chat-event-v1"

# Firmware limits, see firmware/main/application.cc TypedChatControl.
MAX_FRAMES_PER_BATCH = 12
MAX_BATCH_BYTES = 1500
MAX_FRAME_BYTES = 1000
MAX_TOTAL_FRAMES = 2000
MAX_TEXT_CHARS = 300


def _aes_key(secret: str) -> bytes:
    return hashlib.sha256(secret.encode("ascii")).digest()


def _check_id(chat_id) -> bytes:
    if isinstance(chat_id, (bytes, bytearray)):
        chat_id = bytes(chat_id).decode("ascii", "replace")
    if not isinstance(chat_id, str) or len(chat_id) != 8:
        raise ValueError("chat id must be 8 hex characters")
    if any(ch not in "0123456789abcdef" for ch in chat_id):
        raise ValueError("chat id must be lowercase hex")
    return chat_id.encode("ascii")


def command_payload(chat_id) -> bytes:
    """Plaintext for cmds 4, 6 and 7: the chat id and nothing else."""
    return _check_id(chat_id)


def build(cmd: int, chat_id, secret: str, payload: bytes = b"", *, now: int | None = None,
          request_id: str | None = None) -> bytes:
    """Build one control packet. `payload` is the plaintext *after* the chat id."""
    if not secret:
        raise ValueError("missing device control secret")
    request = request_id or secrets.token_hex(4)
    issued = int(now if now is not None else time.time())
    header = bytes([PROTOCOL_VERSION, CHAT_ENVELOPE_VERSION, int(cmd) & 0xFF]) + bytes.fromhex(request) + issued.to_bytes(4, "big")
    iv = secrets.token_bytes(12)
    encrypted = iv + AESGCM(_aes_key(secret)).encrypt(iv, _check_id(chat_id) + payload, header)
    body = header + encrypted + secrets.token_bytes(8)
    return body + hmac.new(secret.encode("ascii"), body, hashlib.sha256).digest()[:16]


def audio_batch(chat_id: str, offset: int, frames: list[bytes]) -> bytes:
    """Plaintext for cmd 5: chat id, first frame index, frame count, then length-prefixed frames."""
    if not 1 <= len(frames) <= MAX_FRAMES_PER_BATCH:
        raise ValueError("frame count out of range")
    if not 0 <= offset <= 0xFFFF:
        raise ValueError("frame offset out of range")
    packed = bytearray()
    for frame in frames:
        if not 1 <= len(frame) <= MAX_FRAME_BYTES:
            raise ValueError("frame size out of range")
        packed += len(frame).to_bytes(2, "big") + frame
    return chat_id.encode("ascii") + offset.to_bytes(2, "big") + bytes([len(frames)]) + bytes(packed)


def batch_frames(frames: list[bytes]) -> Iterator[tuple[int, list[bytes]]]:
    """Group frames exactly the way the firmware expects: contiguous frame indexes."""
    offset, index = 0, 0
    while index < len(frames):
        batch: list[bytes] = []
        size = 0
        for frame in frames[index:index + MAX_FRAMES_PER_BATCH]:
            if size + len(frame) + 2 > MAX_BATCH_BYTES:
                break
            batch.append(frame)
            size += len(frame) + 2
        if not batch:
            raise ValueError("input audio frame too large")
        if offset + len(batch) > MAX_TOTAL_FRAMES:
            raise ValueError("input audio too long")
        yield offset, batch
        offset += len(batch)
        index += len(batch)


def _open_event(payload: bytes, secret: str, aad: bytes) -> dict | None:
    """Verify and decrypt one signed reply event. Returns None for anything unusable."""
    if not secret or not isinstance(payload, (bytes, bytearray)):
        return None
    if len(payload) < 18 or len(payload) > 12000:
        return None
    tag, body = bytes(payload[:16]), bytes(payload[16:])
    if not hmac.compare_digest(tag, hmac.new(secret.encode("ascii"), body, hashlib.sha256).digest()[:16]):
        return None
    if len(body) < 28:
        return None
    try:
        plain = AESGCM(_aes_key(secret)).decrypt(body[:12], body[12:], aad)
        event = json.loads(plain)
    except Exception:  # InvalidTag, malformed JSON, wrong types
        return None
    if not isinstance(event, dict):
        return None
    try:
        seq = int(event["seq"])
    except (KeyError, TypeError, ValueError):
        return None
    if not 1 <= seq <= 2048:
        return None
    identifier = event.get("id")
    if not isinstance(identifier, str) or len(identifier) != 8:
        return None
    return event


def ogg_opus_packets(data: bytes) -> list[bytes]:
    """Split an Ogg Opus stream into raw Opus packets, dropping the two header packets."""
    packets: list[bytes] = []
    pending = bytearray()
    pos = 0
    while pos < len(data):
        if data[pos:pos + 4] != b"OggS" or pos + 27 > len(data):
            raise ValueError("audio container is incomplete")
        count = data[pos + 26]
        table = data[pos + 27:pos + 27 + count]
        if len(table) != count or pos + 27 + count + sum(table) > len(data):
            raise ValueError("audio container is incomplete")
        cursor = pos + 27 + count
        for size in table:
            pending.extend(data[cursor:cursor + size])
            cursor += size
            if size < 255:
                packet = bytes(pending)
                pending.clear()
                if packet and not packet.startswith((b"OpusHead", b"OpusTags")):
                    packets.append(packet)
        pos = cursor
    if pending or not packets:
        raise ValueError("no complete input audio")
    return packets


def validate_text(text: object) -> str:
    """Same input rules as the PC console, so behaviour does not change between clients."""
    if not isinstance(text, str):
        raise ValueError("请输入1–300个字符")
    stripped = text.strip()
    if not 1 <= len(stripped) <= MAX_TEXT_CHARS:
        raise ValueError("请输入1–300个字符")
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in stripped):
        raise ValueError("请输入1–300个字符")
    return stripped


def open_event(payload: bytes, secret: str) -> dict | None:
    return _open_event(payload, secret, EVENT_AAD)

def open_speech_event(payload: bytes, secret: str) -> dict | None:
    event = _open_event(payload, secret, b"stackchan-speech-event-v1")
    if event is None or event.get("kind") not in {"playing", "done", "error", "cancelled"}:
        return None
    try: _check_id(event["id"])
    except ValueError: return None
    return event
