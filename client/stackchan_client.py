#!/usr/bin/env python3
"""StackChan 云端网关客户端示例。

通过 Cloudflare Worker 网关远程控制 StackChan 桌面机器人：
拍照、转头/俯仰、手势、音量、屏幕亮度、语音播报。

配置（环境变量）:
    STACKCHAN_GATEWAY  网关地址，如 https://stackchan-remote-gateway.<你的账号>.workers.dev
    STACKCHAN_TOKEN    网关鉴权密钥（Bearer token），妥善保管，不要提交到仓库
"""
import argparse
import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("STACKCHAN_GATEWAY", "https://<your-worker>.workers.dev").rstrip("/")
TOKEN = os.environ.get("STACKCHAN_TOKEN", "")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"


def request(path, data=None, method="POST", timeout=30):
    url = BASE + path
    body = json.dumps(data or {}).encode("utf-8") if method == "POST" else None
    req = urllib.request.Request(url, data=body, method=method)
    # 注意：Cloudflare 会对非浏览器 UA 返回 1010 拦截，必须带浏览器 UA
    req.add_header("User-Agent", UA)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if method == "POST":
        req.add_header("Content-Type", "application/json")
    return urllib.request.urlopen(req, timeout=timeout)


def api(name, data=None, timeout=30, method="POST"):
    resp = request(f"/api/{name}", data=data, method=method, timeout=timeout)
    return json.loads(resp.read().decode("utf-8"))


def cmd_status(_args):
    print(json.dumps(api("status"), ensure_ascii=False, indent=2))


def cmd_head(args):
    print(json.dumps(api("head", {
        "yaw": args.yaw, "pitch": args.pitch, "time_ms": args.time_ms,
    }), ensure_ascii=False, indent=2))


def cmd_gesture(args):
    print(json.dumps(api("gesture", {"name": args.name}), ensure_ascii=False, indent=2))


def cmd_volume(args):
    print(json.dumps(api("volume", {"value": args.value}), ensure_ascii=False, indent=2))


def cmd_brightness(args):
    print(json.dumps(api("brightness", {"value": args.value}), ensure_ascii=False, indent=2))


def cmd_photo(args):
    # 关键：必须和控制面板完全一致 —— POST 空 body、无 Content-Type。
    # 带 JSON body ({}) 会让网关 hang 住直到 504！
    req = urllib.request.Request(BASE + "/api/photo", data=None, method="POST")
    req.add_header("User-Agent", UA)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    blob = urllib.request.urlopen(req, timeout=90).read()
    if not blob:
        raise SystemExit("empty photo response")
    with open(args.output, "wb") as f:
        f.write(blob)
    print(json.dumps({"saved": args.output, "bytes": len(blob)}, ensure_ascii=False))


def cmd_chat(args):
    job = api("chat", {"text": args.text}, timeout=30)
    job_id = job.get("id")
    if not job_id:
        print(json.dumps(job, ensure_ascii=False, indent=2))
        return
    deadline = time.time() + args.wait
    while time.time() < deadline:
        time.sleep(2)
        state = api(f"chat/{job_id}", method="GET", timeout=30)
        status = state.get("status")
        if status in ("done", "error", "cancelled") and state.get("settled", True):
            print(json.dumps(state, ensure_ascii=False, indent=2))
            return
    print(json.dumps({"id": job_id, "status": "polling_timeout",
                      "hint": "use chat-poll to keep waiting"}, ensure_ascii=False))


def cmd_chat_poll(args):
    print(json.dumps(api(f"chat/{args.id}", method="GET"), ensure_ascii=False, indent=2))


def cmd_speak(args):
    import re
    key = args.key or "speak_{}_{}".format(
        time.strftime("%Y%m%d%H%M%S"), os.getpid() % 100000)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key):
        raise SystemExit("idempotency key must match ^[A-Za-z0-9_-]{1,64}$")
    job = api("speak", {"text": args.text, "idempotency_key": key}, timeout=30)
    job_id = job.get("id")
    if not job_id:
        print(json.dumps(job, ensure_ascii=False, indent=2))
        return
    deadline = time.time() + args.wait
    while time.time() < deadline:
        time.sleep(2)
        state = api(f"speak/{job_id}", method="GET", timeout=30)
        if state.get("settled"):
            print(json.dumps(state, ensure_ascii=False, indent=2))
            return
    print(json.dumps({"id": job_id, "status": "polling_timeout",
                      "hint": "use speak-poll to keep waiting"}, ensure_ascii=False))


def cmd_speak_poll(args):
    print(json.dumps(api(f"speak/{args.id}", method="GET"), ensure_ascii=False, indent=2))


def cmd_speak_cancel(args):
    print(json.dumps(api(f"speak/{args.id}/cancel", {}), ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(description="StackChan remote gateway client")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("status", help="check robot connection and pose")
    s.set_defaults(fn=cmd_status)

    h = sub.add_parser("head", help="move head")
    h.add_argument("--yaw", type=int, default=0, help="-128..128")
    h.add_argument("--pitch", type=int, default=45, help="5..85")
    h.add_argument("--time-ms", type=int, default=900)
    h.set_defaults(fn=cmd_head)

    g = sub.add_parser("gesture", help="nod | shake | release")
    g.add_argument("--name", required=True, choices=["nod", "shake", "release"])
    g.set_defaults(fn=cmd_gesture)

    v = sub.add_parser("volume", help="set speaker volume 0..100")
    v.add_argument("--value", type=int, required=True)
    v.set_defaults(fn=cmd_volume)

    b = sub.add_parser("brightness", help="set screen brightness 0..100")
    b.add_argument("--value", type=int, default=100)
    b.set_defaults(fn=cmd_brightness)

    ph = sub.add_parser("photo", help="take a camera snapshot")
    ph.add_argument("--output", required=True)
    ph.set_defaults(fn=cmd_photo)

    c = sub.add_parser("chat", help="make the robot speak a reply (text <= 300 chars)")
    c.add_argument("--text", required=True)
    c.add_argument("--wait", type=int, default=90, help="max seconds to poll for reply")
    c.set_defaults(fn=cmd_chat)

    cp = sub.add_parser("chat-poll", help="poll an existing chat job")
    cp.add_argument("--id", required=True)
    cp.set_defaults(fn=cmd_chat_poll)

    sp = sub.add_parser("speak", help="have the robot speak text aloud verbatim (1-1000 chars)")
    sp.add_argument("--text", required=True)
    sp.add_argument("--key", default=None, help="idempotency key ^[A-Za-z0-9_-]{1,64}$")
    sp.add_argument("--wait", type=int, default=120, help="max seconds to poll for done")
    sp.set_defaults(fn=cmd_speak)

    spp = sub.add_parser("speak-poll", help="poll an existing speak job")
    spp.add_argument("--id", required=True)
    spp.set_defaults(fn=cmd_speak_poll)

    spc = sub.add_parser("speak-cancel", help="cancel a speak job")
    spc.add_argument("--id", required=True)
    spc.set_defaults(fn=cmd_speak_cancel)

    args = p.parse_args()
    if not TOKEN:
        print("error: set STACKCHAN_TOKEN env var first", file=sys.stderr)
        sys.exit(2)
    try:
        args.fn(args)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
