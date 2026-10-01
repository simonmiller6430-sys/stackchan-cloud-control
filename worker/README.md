# Cloudflare Worker HTTPS 网关

完整入口在 `src/worker.mjs`，`RobotGateway` Durable Object 协调单设备控制；`mqtt.mjs` 通过 WebSocket Upgrade 连接 MQTT broker；`protocol.mjs` 生成签名指令并解密组装照片；`speech-relay.mjs`、`chat-relay.mjs` 代理常开语音服务；`public/` 是手机面板和播报 OpenAPI。

## 部署

使用支持当前 Wrangler 的 Node.js LTS（推荐 Node 22 或 24），Cloudflare 账号和 npm。

```bash
cd worker
npm ci
npx wrangler login
npx wrangler secret put APP_TOKEN
npx wrangler secret put DEVICE_CONTROL_SECRET
npx wrangler secret put ROBOT_MAC
npm test
npm run check
npm run deploy
```

`APP_TOKEN` 用密码学安全随机数生成，至少 32 字符（例如 `openssl rand -hex 32`）；只交给有控制权限的客户端。`DEVICE_CONTROL_SECRET` 是固件生成的独立密钥，`ROBOT_MAC` 是自己的设备 MAC。三者都通过 Wrangler secret 提交，**不要写入 wrangler.toml 或仓库**。

`wrangler.toml` 无个人 account_id，登录后选择自己的账户。SQLite Durable Object migration 使用 `new_sqlite_classes`，支持 Workers Free；这是单设备配置，不能直接用于多租户平台。

Worker 地址示例：`https://<你的worker>.workers.dev`。浏览器打开根路径得到手机控制台。`GET /healthz` 不需令牌，仅说明服务配置，不证明机器人在线；所有 `/api/*` 都需要 Bearer APP_TOKEN。

## 启用回复播报与小智聊天

先部署 `../voice-relay/`，让它具备有效证书的 HTTPS 入口，再设置：

```bash
npx wrangler secret put RELAY_URL
npx wrangler secret put RELAY_TOKEN
npm run deploy
```

`RELAY_URL` 为中转 HTTPS 基址，不带 `/speak`；`RELAY_TOKEN` 与 Linux 服务配置一致。未配置时语音 API 返回 503。适配器拒绝 HTTP 与自动跳转，避免令牌送到错误入口。

## 拍照接口的兼容要求

`POST /api/photo` 支持**无 body、无 Content-Type** 请求，原客户端保持该形式；也支持 JSON `{}`。入口不强行解析用户拍照 body，而向内部 Durable Object 发送 `{}`；内部分支执行 cmd10 后返回完整 JPEG，不能将它当作 JSON 命令/JSON 响应处理。这里的“透传无 body POST”指外部 API 接受这种请求，并正确保留二进制返回，而不是把空请求交给内部 `request.json()`。

客户端等待至少 35 秒；Worker 的照片等待预算为 25 秒。重复分片不会虚增完成计数；机器人忙碌返回 409，其他 MQTT/照片问题可能返回 504。

## 鉴权、路由与免费计划

- APP_TOKEN 使用哈希后的常量时间比较，失败返回 401。
- status/head/gesture/volume/brightness/photo 走 MQTT；speak/chat 走 HTTPS relay 后再经 MQTT 到设备。
- 控制请求限速，忙碌返回 409，过快返回 429；单设备语音互斥由 relay 保证。
- 不要求所有客户端伪装浏览器 UA；若账号的额外安全规则返回 Cloudflare 1010，检查具体规则。客户端保留 Muse 原 UA 以兼容其运行环境。
- [免费计划额度](https://developers.cloudflare.com/workers/platform/pricing/) 和 [Durable Objects 限制](https://developers.cloudflare.com/durable-objects/platform/limits/) 会变化；公共 MQTT 及语音服务不受 Workers 可用性覆盖。

`npm test` 为纯本地模拟回归，`npm run check` 为 Wrangler 打包 dry-run，二者不会操作机器人，也不能替代新设备验收。
