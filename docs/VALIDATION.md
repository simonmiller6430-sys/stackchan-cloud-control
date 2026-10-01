# 验证与验收

纯本地回归，无需真实设备或密钥：

```bash
cd worker
npm ci
npm test
npm run check
cd ..
python -m pip install -r voice-relay/requirements.txt
python -m unittest discover -s voice-relay/tests
python -m unittest discover -s client -p test_client.py
```

固件需生成自己的控制密钥，再用 ESP-IDF 5.5.2 idf.py build。构建、刷写校验、实际操作、听音是不同验收层次。

1. 无令牌 status 返回 401，有令牌获取设备状态。
2. 安全角度转头与 center，测试音量/亮度。
3. 无 body photo 返回完整 JPEG，实际查看；以 `{}` 再试。
4. 短句 speak，同键同文复用 id，同键不同文返回 409。
5. 轮询 done 且 settled，实际听到完整原文；长句取消并确认 cancel_confirmed。
6. 语音互斥返回 409，播报后 status/photo 正常。
7. 关闭 Windows，保持树莓派和机器人联网，从外网重试。

实现源自 2026-09-30 本地验收过的代码，历史记录有设备输出完成、取消恢复、拍照回归，也出现公共 MQTT 瞬时断连。公开副本没有携带个人设备日志；新部署须独立验收。

## 2026-10-01 发布副本检查

- Worker 55 项、Python relay 35 项、客户端 2 项测试通过。
- Wrangler 4.145.0 打包 dry-run 成功；npm audit 为 0 项漏洞。
- 两个固件 C++ 主机探针（speech_state、local_speech_gate）编译运行通过。
- 隔离目录用 ESP-IDF 5.5.2、仓库默认配置和新生成测试密钥完整构建成功；依赖复用本机已有组件缓存。镜像 0x2dd400 字节，3 MiB 应用分区剩余约 5%，继续加功能需注意容量。
- 安装/自检脚本通过 bash -n；源码、本地文档链接、OpenAPI JSON 与已知私有值扫描通过。
- Muse 原客户端备份逐字节保留；GET 轮询修复先复现失败再验证通过，无 body photo POST 未改。

本次只验证发布副本，没有重新刷写或执行新的生产硬件操作。镜像不发布，测试密钥不是生产密钥。GitHub 可见性、remote 与远端 README 渲染需推送后另行确认。
