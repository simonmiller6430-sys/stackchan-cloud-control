"""HTTPS API for the relay. Cloudflare Worker calls these three endpoints.

    POST /chat            {"text": "..."}     -> job snapshot
    GET  /chat/{id}                           -> job snapshot (phone polls this)
    POST /chat/{id}/cancel                    -> job snapshot
    GET  /healthz                             -> service state, no auth

Every route except /healthz requires `Authorization: Bearer <RELAY_TOKEN>`.
The relay deliberately exposes no other robot capability: head, camera and settings
stay on the Cloudflare worker so this box holds the smallest possible surface.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import speech_service
import chat_service
import robot_link

log = logging.getLogger("relay.http")
MAX_BODY = 16384


def load_config() -> dict:
    """Read settings from the environment, plus an optional local JSON file for dev."""
    config = {
        "relay_token": os.environ.get("RELAY_TOKEN", ""),
        "device_control_secret": os.environ.get("DEVICE_CONTROL_SECRET", ""),
        "robot_mac": os.environ.get("ROBOT_MAC", ""),
        "mqtt_host": os.environ.get("MQTT_HOST", "broker-cn.emqx.io"),
        "mqtt_port": int(os.environ.get("MQTT_PORT", "1883")),
        "topic_prefix": os.environ.get("TOPIC_PREFIX", "stackchan"),
        "port": int(os.environ.get("PORT", "7860")),
        "bind_host": os.environ.get("BIND_HOST", "127.0.0.1"),
        "speech_voice": os.environ.get("SPEECH_VOICE", "zh-CN-XiaoxiaoNeural"),
        "chat_timeout_s": float(os.environ.get("CHAT_TIMEOUT_S", "120")),
    }
    path = os.environ.get("RELAY_CONFIG", "")
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            config.update({k: v for k, v in json.load(handle).items() if v not in (None, "")})
    return config


class Relay:
    def __init__(self, config: dict):
        self.config = config
        self.voice_lock = threading.Lock()
        self.link = robot_link.RobotLink(
            host=config["mqtt_host"], port=config["mqtt_port"], prefix=config["topic_prefix"],
            mac=config["robot_mac"], secret=config["device_control_secret"],
            on_event=self._on_event, on_speech_event=self._on_speech_event)
        self.service = chat_service.ChatService(
            self.link.control, self._synthesize, config["device_control_secret"],
            timeout_s=config["chat_timeout_s"], voice_lock=self.voice_lock)
        self.speech = speech_service.SpeechService(self.link.control, self._synthesize_speech, config["device_control_secret"], voice_lock=self.voice_lock, submit=self.link.control_submit, wait=self.link.control_wait, available=self.link.connected.is_set)
        self.ready = False

    def _synthesize(self, text: str):
        import audio_synth
        return audio_synth.synthesize(text)

    def _synthesize_speech(self, text):
        import audio_synth
        return audio_synth.synthesize_speech(text, self.config.get("speech_voice", "zh-CN-XiaoxiaoNeural"))

    def _on_speech_event(self, payload):
        self.speech.on_event(payload)

    def _on_event(self, payload: bytes) -> None:
        self.service.on_event(payload)

    def start(self) -> None:
        self.link.start()
        self.ready = True


class Handler(BaseHTTPRequestHandler):
    server_version = "stackchan-relay/1"
    relay: Relay = None  # type: ignore[assignment]

    # ------------------------------------------------------------------ helpers
    def log_message(self, fmt, *args):  # noqa: ANN001 - quieter default logging
        log.info("%s %s", self.address_string(), fmt % args)

    def _json(self, value, status=200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        expected = self.relay.config["relay_token"]
        if not expected or len(expected) < 32:
            return False
        given = self.headers.get("Authorization", "")
        return hmac.compare_digest(given, f"Bearer {expected}")

    def _body(self) -> dict:
        raw_length = self.headers.get("Content-Length") or ""
        if not raw_length.isascii() or not raw_length.isdecimal() or len(raw_length)>6:
            raise ValueError("bad body")
        length = int(raw_length)
        if length <= 0 or length > MAX_BODY:
            raise ValueError("bad body")
        raw = self.rfile.read(length)
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("bad body")
        return value

    # -------------------------------------------------------------------- routes
    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler naming
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            config = self.relay.config
            self._json({
                "service": "stackchan-relay",
                "speech_supported": True,
                "speech_voice": config.get("speech_voice", "zh-CN-XiaoxiaoNeural"),
                "ready": self.relay.ready,
                "broker_connected": self.relay.link.connected.is_set(),
                "configured": bool(config["relay_token"] and config["device_control_secret"] and config["robot_mac"]),
                "robot_mac": config["robot_mac"][-5:],
            })
            return
        if not self._authorized():
            self._json({"error": "unauthorized"}, 401)
            return
        parts = [p for p in path.split("/") if p]
        if len(parts) == 2 and parts[0] in {"chat", "speak"}:
            try:
                self._json((self.relay.speech if parts[0]=="speak" else self.relay.service).snapshot(parts[1]))
            except KeyError as exc:
                self._json({"error": str(exc)}, 404)
            return
        self._json({"error": "not_found"}, 404)

    def do_POST(self):  # noqa: N802
        if not self._authorized():
            self._json({"error": "unauthorized"}, 401)
            return
        path = self.path.split("?", 1)[0]
        parts = [p for p in path.split("/") if p]
        try:
            if parts == ["speak"]:
                body = self._body()
                try:
                    self._json(self.relay.speech.start(body.get("text"), body.get("idempotency_key")), 202)
                except ConnectionError:
                    self._json({"error": "relay_unavailable"}, 503)
                except ValueError as exc:
                    self._json({"error": str(exc)}, 400)
                except RuntimeError as exc:
                    self._json({"error": str(exc)}, 409)
                return
            if parts == ["chat"]:
                text = self._body().get("text")
                try:
                    self._json(self.relay.service.start(text))
                except ValueError as exc:
                    self._json({"error": str(exc)}, 400)
                except RuntimeError as exc:
                    self._json({"error": str(exc)}, 409)
                return
            if len(parts) == 3 and parts[0] in {"chat", "speak"} and parts[2] == "cancel":
                self._body()
                try:
                    self._json((self.relay.speech if parts[0]=="speak" else self.relay.service).cancel(parts[1]))
                except KeyError as exc:
                    self._json({"error": str(exc)}, 404)
                return
        except ValueError:
            self._json({"error": "bad request"}, 400)
            return
        except Exception as exc:  # noqa: BLE001
            log.error("relay request failed")
            self._json({"error": "relay_error"}, 500)
            return
        self._json({"error": "not_found"}, 404)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    config = load_config()
    if not config["relay_token"] or not config["device_control_secret"] or not config["robot_mac"]:
        log.error("RELAY_TOKEN, DEVICE_CONTROL_SECRET and ROBOT_MAC are all required")
        return 2
    relay = Relay(config)
    relay.start()
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        # Start the broker subscription, synthesize once, and exit without chatting.
        import audio_synth
        frames = audio_synth.synthesize("中转自检")
        log.info("selftest ok: %d opus frames, first=%d bytes", len(frames), len(frames[0]))
        relay.link.stop()
        return 0
    Handler.relay = relay

    def prune_loop() -> None:
        while True:
            time.sleep(60)
            relay.link.prune_acks()

    threading.Thread(target=prune_loop, daemon=True, name="relay-prune").start()
    server = ThreadingHTTPServer((config['bind_host'], config["port"]), Handler)
    log.info("relay listening on %s:%s", config['bind_host'], config["port"])
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
