# CoreS3 网关固件

这是完整的 ESP-IDF 固件，不是运行在树莓派上的程序。它在原有 StackChan Fusion / 小智功能上增加第二条 MQTT 控制通道、加密照片回传与外部原文播报。

## 源码模块

| 文件 | 职责 |
|---|---|
| `main/boards/m5stack-core-s3/m5stack_core_s3.cc` | MQTT 生命周期、HMAC 指令验证、运动/设置、相机、聊天与播报接收及事件回传 |
| `main/boards/m5stack-core-s3/speech_state.h` | 播报会话和取消状态管理 |
| `main/audio/audio_service.*`、`audio_codec.*` | 音频队列、实际输出计数与播放收尾 |
| `main/application.*`、`main/protocols/` | 应用状态与原有小智会话隔离 |
| `main/boards/common/` | 共用板级抽象 |
| `partitions/v1/16m_stackchan.csv` | 16 MiB 分区布局 |
| `scripts/` | 语言资源、默认资源和构建辅助工具 |

语音任务的 HTTP job 管理、幂等及 TTS 在 `../voice-relay/`；固件负责接收音频、输出、取消与签名完成事件。拍照采用独立请求编号、加密分片、完整 JPEG 组装；MQTT 回调不进行长时间阻塞。

## 构建

使用 ESP-IDF **5.5.2** 的已激活终端，Python 环境需安装该 ESP-IDF 要求的依赖。Windows 建议放到短 ASCII 路径，例如 `D:/stackchan-cloud-control/firmware`。

```bash
cd firmware
python scripts/generate_control_secret.py
idf.py set-target esp32s3
idf.py build
```

生成的 `main/boards/m5stack-core-s3/device_control_secret.h` 被 Git 忽略。它含 64 位小写 hex 密钥，Worker 与语音服务的 `DEVICE_CONTROL_SECRET` 必须使用**同一字符串**。这是按 ASCII 字符串参与签名与派生的密钥；不要把它转换为 32 字节后配置。脚本不会覆盖已有文件，避免误换密钥。

`sdkconfig.defaults` 选择 CoreS3 和相机配置，依赖由 `main/idf_component.yml` 与 `dependencies.lock` 定义；首次构建需要联网下载组件。本仓库不携带 `managed_components/` 或生成的 sdkconfig。缺少控制密钥头文件时无法编译是预期保护行为。

## 刷写与配网

先保存自己设备现有分区、配置和可回滚镜像，再在相同板型上刷写。新安装使用构建系统完整 flash 清单，而非手写地址只刷应用：

```bash
idf.py -p <你的串口> flash monitor
```

该分区布局包含 bootloader、分区表、OTA data、模型与资源，应用 `ota_0` 从 `0x410000` 开始。只有确认设备布局完全一致时才考虑单独更新应用。16 MiB 布局不要套到其他容量的硬件。

按照设备屏幕提示完成 Wi-Fi 配网及原有小智绑定。HTTP 云控不要求电脑常开；原有小智文字聊天还需要可用的小智会话。启动后记录自己设备 MAC，填入 Worker 和 relay 的 `ROBOT_MAC`（小写、冒号分隔）。

MQTT 默认为 `broker-cn.emqx.io:1883`，Worker 用同一 broker 的 WSS 入口。主题形如 `stackchan/<你的设备MAC>/control`；固件内 broker 入口在 CoreS3 源码 `kPushMqttUris` 定义。若自行更换 broker，三端同时修改并重新构建验证；当前发布没有实现私有 broker 的账号密码配置向导。

## 部署后检查

串口确认 Wi-Fi 与 MQTT 已连接。部署 Worker 后依次请求 status、单次 photo、短句 speak；确认运动范围、实际音频与取消行为。刷写结束必须看到工具的写入校验成功；本仓库不包含生产设备镜像或 Wi-Fi 备份。
