# 网关 API

Base URL：`https://<你的worker>.workers.dev`。所有 `/api/*` 要求 `Authorization: Bearer <APP_TOKEN>`。`GET /healthz` 和公开页面不要求令牌；healthz 只报告配置。

| 请求 | JSON body | 成功返回 |
|---|---|---|
| `POST /api/status` | `{}` 或空 | 设备 ACK/状态 JSON，附 verification |
| `POST /api/head` | `{"yaw":-60,"pitch":20,"time_ms":900}` | 控制 ACK |
| `POST /api/gesture` | `{"name":"nod"}` | 控制 ACK |
| `POST /api/volume` | `{"value":30}` | 控制 ACK |
| `POST /api/brightness` | `{"value":50}` | 控制 ACK |
| `POST /api/photo` | 空 body，或 `{}` | image/jpeg 二进制 |
| `POST /api/chat` | `{"text":"请用一句话回应"}` | 小智聊天 job |
| `GET /api/chat/{id}` | 无 | 聊天 job |
| `POST /api/chat/{id}/cancel` | `{}` 或空 | 聊天 job |
| `POST /api/speak` | `{"text":"Muse 回复","idempotency_key":"reply_001"}` | HTTP 202 播报 job |
| `GET /api/speak/{id}` | 无 | HTTP 200 播报 job |
| `POST /api/speak/{id}/cancel` | `{}` 或空 | HTTP 200 播报 job |

范围：yaw −128～128；pitch 5～85；time_ms 100～5000（默认 900）；手势 nod/shake/tilt/center/release；音量 0～100；亮度 5～100。center 是日常中立姿态，release 释放外部姿态锁，不代表固定角度复位。

拍照无需解析调用方 JSON，保留无 body/无 Content-Type POST 即可。建议至少 35 秒超时，一次一张。错误为 JSON，保存图片前检查 HTTP 状态与 Content-Type。

## 原文播报

text 为 1～1000 个 Unicode 码点、非纯空白；不允许特殊控制字符（换行/tab 可用）。JSON body 上限 16384 字节，音频上限 120 秒。idempotency_key 可选，但助手应每条逻辑回复提供固定键，匹配 `^[A-Za-z0-9_-]{1,64}$`；同键同文本复用任务，同键不同文本返回 409。

id 为 8 位小写 hex。轮询至 settled=true 后检查 status：done 才代表设备输出完成；failed 是失败；cancelled 是取消，还需 cancel_confirmed 确认设备停止。HTTP 202、playing 或 settled 单独都不能证明成功。

幂等记录仅在 relay 当前进程及任务保留窗口有效（最多 20 个任务）；重启或淘汰后旧键可能产生新任务。网络超时先查已有 id，不要每次重试换键。

## 小智聊天与错误

chat text 为 1～300 字符。它将文字转成语音输入小智，由小智生成自己的答案，识别文本可能有差异；并非朗读 Muse。状态 preparing/uploading/waiting/speaking/done/error/cancelled，等待 settled。与 speak 互斥。

401 未授权；400 参数错误；404 未知路径/job；409 busy/幂等冲突；429 过快；503 未配置/中转不可用；502 中转问题；504 MQTT/照片超时或断连。忙碌时等待；副作用指令发出后不自动重复，status 可以重试。

当前 chat 适配器会将部分中转的输入验证 400 映射为 502；例如 text 字符串超出中转的 300 字上限。调用方应先验证长度，502 不一定意味着网络故障。speak 会保留中转的 400。

状态/控制响应的 verification=legacy-unsigned-device-ack 表示传统 ACK 无签名；照片、播报事件独立验证，见 [安全说明](SECURITY.md)。Cloudflare 1010 来自账号的安全规则，不是本源码统一行为；原客户端保留浏览器 UA。

播报 OpenAPI 见 [openapi-speak.json](openapi-speak.json)，使用前替换 servers 地址并单独配置 Bearer 令牌。
