# 安全与隐私

APP_TOKEN 是客户端 → Worker 的独立令牌，至少 32 字符；持有者可以拍照和控制设备。DEVICE_CONTROL_SECRET 是固件生成的 64 字符 hex 密钥字符串，三端一致，不交给 Muse。RELAY_TOKEN 是 Worker → HTTPS relay 的独立令牌，至少 32 字符。实际 MAC、RELAY_URL 也不应写入公开配置。

Worker 使用 HTTPS/WSS。固件与 relay 默认 MQTT TCP 1883，主要载荷由应用层 HMAC/AES-GCM 保护，但公共 broker 不提供访问隔离；主题、流量时序与传统 ACK/在线状态可被观察或伪造。控制响应标记 legacy-unsigned-device-ack；照片绑定请求编号与 AES-GCM，语音任务事件验证认证和序号。这不是经过完整安全审计的多租户生产系统。

私有 broker/TLS/ACL 可进一步加固，但当前没有一键私有账号认证向导；更换入口必须同步三端并重新验证。

公开仓库排除真实 Worker 地址、令牌、设备密钥/MAC、个人中转域名、照片、NVS、回滚镜像、运行日志与生产配置；上游公共链接和公共 broker 不是个人部署信息。header、.env、.dev.vars、secrets JSON、build/sdkconfig/照片目录被忽略，但 .gitignore 不会清除已追踪历史。

幂等/任务在内存，重启清空；在线 TTS 接收要合成的文本，应遵守自己的隐私要求。照片由调用者保存，不要把室内照片提交 Git。
