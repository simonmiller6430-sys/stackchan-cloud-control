"""MQTT side of the relay: publish signed control packets, read signed reply events.

One long-lived connection is used because reply events arrive asynchronously while the
robot is talking; the control ACK itself is matched by request id.
"""
from __future__ import annotations

import json
import logging
import secrets
import threading
import time

import paho.mqtt.client as paho

import relay_protocol as proto

log = logging.getLogger("relay.mqtt")


class RobotLink:
    """Owns the broker connection, the pending-ACK table and the event sink."""

    def __init__(self, host: str, port: int, prefix: str, mac: str, secret: str, on_event, on_speech_event=None):
        self.host = host
        self.port = int(port)
        self.base = f"{prefix}/{mac}"
        self.secret = secret
        self.on_event = on_event
        self.on_speech_event = on_speech_event
        self.lock = threading.Lock()
        self.acks: dict[str, tuple[float, dict]] = {}
        self.connected = threading.Event()
        self.client: paho.Client | None = None
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ topics
    @property
    def control_topic(self) -> str:
        return f"{self.base}/control"

    @property
    def ack_topic(self) -> str:
        return f"{self.base}/control_ack"

    @property
    def event_topic(self) -> str:
        return f"{self.base}/chat_event"

    # ----------------------------------------------------------------- lifecycle
    def start(self) -> None:
        client = paho.Client(client_id=f"stackchan-relay-{int(time.time()) % 100000}", protocol=paho.MQTTv311)
        client.on_connect = self._on_connect
        client.on_message = self._on_message
        client.on_disconnect = self._on_disconnect
        self.client = client
        client.connect_async(self.host, self.port, keepalive=30)
        client.loop_start()
        self._thread = threading.Thread(target=self._wait_ready, daemon=True, name="relay-connect")
        self._thread.start()

    def _wait_ready(self) -> None:
        # connect_async returns immediately; wait so the first chat cannot race the socket.
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if self.connected.wait(0.2):
                return
        log.error("broker connection not established within 20s")

    def stop(self) -> None:
        if self.client is not None:
            try:
                self.client.loop_stop()
                self.client.disconnect()
            except Exception:  # noqa: BLE001
                pass

    def _on_connect(self, client, userdata, flags, rc):  # noqa: ANN001
        if rc != 0:
            log.error("broker rejected connection rc=%s", rc)
            return
        client.subscribe(self.ack_topic, qos=1)
        client.subscribe(self.event_topic, qos=1)
        client.subscribe(f"{self.base}/speech_event", qos=1)
        self.connected.set()
        log.info("subscribed to %s and %s", self.ack_topic, self.event_topic)

    def _on_disconnect(self, client, userdata, rc):  # noqa: ANN001
        self.connected.clear()
        if rc != 0:
            log.warning("broker disconnected rc=%s; paho will reconnect", rc)

    def _on_message(self, client, userdata, message):  # noqa: ANN001
        try:
            if message.topic == self.ack_topic:
                ack = json.loads(message.payload.decode("utf-8", "replace"))
                request_id = str(ack.get("request_id") or "")
                if request_id:
                    with self.lock:
                        self.acks[request_id] = (time.time(), ack)
            elif message.topic == f"{self.base}/speech_event" and self.on_speech_event:
                self.on_speech_event(bytes(message.payload))
            elif message.topic == self.event_topic:
                self.on_event(bytes(message.payload))
        except Exception as exc:  # noqa: BLE001 - a bad packet must not kill the loop
            log.warning("message handling failed")

    # ------------------------------------------------------------------- control
    def control_submit(self, cmd: int, payload: bytes) -> str:
        """Publish once, preserving MQTT connection ordering; never retry."""
        if not self.secret or not self.connected.is_set() or self.client is None:
            raise RuntimeError('broker unavailable')
        request_id = secrets.token_hex(4)
        wire = proto.build(cmd, payload[:8].decode('ascii'), self.secret, payload[8:], request_id=request_id)
        try:
            info = self.client.publish(self.control_topic, wire, qos=1)
            if info.rc != 0:
                raise RuntimeError('publish failed')
        except Exception:
            raise RuntimeError('publish failed') from None
        return request_id

    def control_wait(self, request_id: str, timeout_s: float = 5.0) -> dict:
        deadline = time.monotonic() + max(.01, float(timeout_s))
        while time.monotonic() < deadline:
            with self.lock:
                ack = self.acks.pop(request_id, None)
            if ack is not None:
                return {'request_id': request_id, **ack[1]}
            time.sleep(min(.05, max(0, deadline-time.monotonic())))
        return {'ok': False, 'status': 'timeout', 'request_id': request_id}

    def control(self, cmd: int, payload: bytes, timeout_s: float = 5.0) -> dict:
        """Synchronous compatibility wrapper for chat and begin/finish/cancel."""
        if not self.secret:
            return {'ok': False, 'status': 'not_provisioned'}
        if not self.connected.is_set():
            return {'ok': False, 'status': 'broker_not_connected'}
        try:
            request_id = self.control_submit(cmd, payload)
        except Exception:
            return {'ok': False, 'status': 'publish_failed'}
        return self.control_wait(request_id, timeout_s)

    def prune_acks(self, older_than_s: float = 120.0) -> None:
        cutoff = time.time() - older_than_s
        with self.lock:
            for request_id in [k for k, (at, _) in self.acks.items() if at < cutoff]:
                self.acks.pop(request_id, None)
