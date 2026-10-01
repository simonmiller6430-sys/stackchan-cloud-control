# 给 Muse / AI 助手的调用说明

把自己的 Worker HTTPS 地址与此说明交给助手，APP_TOKEN 存其私有环境或连接配置，禁止写入公开文档或 schema。

> 所有 /api 请求携带 Authorization: Bearer APP_TOKEN。先查设备状态。拍照用无 body POST /api/photo，超时至少 35 秒，响应为 JPEG。连续控制间隔至少 0.5 秒，参数遵循 API；遇到 409 等待。
>
> 朗读你已生成的答案，用 POST /api/speak，body={text: 回复原文, idempotency_key: 本条逻辑回复固定键}。不要为此使用 /api/chat，它会让小智重新生成答案。保存返回 id，每 1～2 秒 GET /api/speak/{id}，直到 settled=true；只有 status=done 才报告成功。每段最多 1000 字且音频最多 120 秒，前段收尾后再提交下一段。重试相同文本沿用同键；结果不明时先查 job，不换键重播。取消 POST /api/speak/{id}/cancel，再轮询检查 cancel_confirmed。

```bash
export STACKCHAN_GATEWAY="https://<你的worker>.workers.dev"
# STACKCHAN_TOKEN 由私有环境提供
curl --request POST "$STACKCHAN_GATEWAY/api/photo" \
  --header "Authorization: Bearer $STACKCHAN_TOKEN" \
  --max-time 35 --fail --output snap.jpg
curl --request POST "$STACKCHAN_GATEWAY/api/speak" \
  --header "Authorization: Bearer $STACKCHAN_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"text":"你好，我是 Muse。","idempotency_key":"muse_reply_001"}'
```

可导入 [openapi-speak.json](openapi-speak.json)，私下替换 servers。原 ZIP 客户端的 api() 缺少 GET 参数；发布版只补 method 透传，原件保存于 muse-original。无 body photo POST 与原命令入口保持。
