# 常开语音中转

Muse 回复 → Worker `/api/speak` → 此服务 TTS 合成 → MQTT → StackChan 原文播放。`/chat` 则将文字合成为语音交给已有小智会话，让小智生成答案。两者共享互斥锁，忙碌返回 409，不无限排队。

`server.py` 处理 Bearer 验证与 HTTP；`speech_service.py` 管理播报 job、幂等、取消与设备确认；`chat_service.py` 管理小智输入和字幕；`audio_synth.py` 用 edge-tts/ffmpeg 编码 16 kHz、60 ms Opus；`robot_link.py` 连接 MQTT；`relay_protocol.py` 实现 HMAC/AES-GCM 协议。

## 树莓派 / Linux 部署

使用常开 Debian/Ubuntu、Python 3.10+、ffmpeg 和网络。需要访问 MQTT broker 和在线 TTS；部署后 Windows 不参与链路。

```bash
sudo bash voice-relay/deploy/install-oracle.sh
sudo nano /etc/stackchan-relay.env
```

脚本名称来自最初云主机版本，也用于 Debian/Ubuntu 树莓派。它安装依赖、专用用户与 systemd 服务，默认监听 `127.0.0.1:8080`。环境文件只允许 root 读取，填入自己的值：

```dotenv
RELAY_TOKEN=<独立随机中转令牌至少32字符>
DEVICE_CONTROL_SECRET=<固件生成的64字符设备密钥>
ROBOT_MAC=<你的设备MAC>
MQTT_HOST=broker-cn.emqx.io
MQTT_PORT=1883
TOPIC_PREFIX=stackchan
PORT=8080
BIND_HOST=127.0.0.1
SPEECH_VOICE=zh-CN-XiaoxiaoNeural
CHAT_TIMEOUT_S=120
```

```bash
sudo systemctl restart stackchan-relay
sudo systemctl status stackchan-relay --no-pager
curl http://127.0.0.1:8080/healthz
```

`/healthz` 无需令牌；broker_connected 表示 MQTT 状态。直接启动 Python 时默认端口为 7860，安装器明确设置 8080。

## HTTPS 入口

主机完成 Tailscale 登录与 Funnel 授权后：

```bash
sudo tailscale funnel --bg --yes 8080
sudo tailscale funnel status
```

把显示的 HTTPS 基址作为 Worker RELAY_URL（不带 /speak），并配置同一 RELAY_TOKEN。电脑与 Muse 不需加入 tailnet。参考 [Funnel 文档](https://tailscale.com/kb/1223/funnel)。也可用有效证书的反向代理或 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)。服务保持 localhost 监听，公开入口必须验证令牌。

不要公开明文 8080。Worker 拒绝 HTTP 与自动重定向；Funnel 只提供语音服务入口，没有替换 MQTT。

## 接口与状态

除 `/healthz` 外均需 `Authorization: Bearer <RELAY_TOKEN>`：`POST /speak`、`GET /speak/{id}`、`POST /speak/{id}/cancel`，以及同样形式的 `/chat`。Worker 对外加 /api 前缀。不存在 `/health` 路由；未鉴权访问未知路径也可能先得到 401，不能据此证明健康。

播报 queued → synthesizing → playing → done/failed/cancelled。只有 done 且 settled=true 才是成功；取消还需 cancel_confirmed。完成来自验证过的设备输出事件，不仅是合成成功。每条 1～1000 Unicode 码点，音频上限 120 秒。

最多保留 20 个内存任务，已完成任务及幂等键会淘汰；进程重启清空。幂等不是永久 exactly-once 保证。长文按自然句分段，等待前一段 settled 后提交下一段。

## 本地测试

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r voice-relay/requirements.txt
python -m unittest discover -s voice-relay/tests
```

测试不连生产设备。`sudo bash /opt/stackchan-relay/deploy/selftest.sh` 会真实合成并提交一次小智聊天，应在配置后运行；任务完成仍需实际听音验收。
