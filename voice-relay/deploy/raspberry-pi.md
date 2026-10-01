# 树莓派部署

完整步骤见 [服务 README](../README.md)：安装 systemd 服务、私下设置设备密钥/MAC/中转令牌，保持 localhost 监听，再提供有效 HTTPS 入口。

```sh
sudo bash voice-relay/deploy/install-oracle.sh
sudo nano /etc/stackchan-relay.env
sudo systemctl restart stackchan-relay
sudo tailscale funnel --bg --yes 8080
sudo tailscale funnel status
```

预先完成 Tailscale 登录与 Funnel 授权；将实际 HTTPS 基址与 RELAY_TOKEN 私下填入 Worker。停止可用 `sudo systemctl disable --now stackchan-relay`，同时停用自己的公网入口与 Worker relay 配置。
