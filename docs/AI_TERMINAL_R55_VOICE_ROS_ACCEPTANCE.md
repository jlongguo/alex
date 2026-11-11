# Alex R55 — 语音供应商契约与 ROS2/Nav2 真实验收证据门槛

## 本轮 Coding 范围

保留现有家庭认证、儿童权限和语音预算实现，不引入新依赖，也不修改实际机器人控制逻辑。把尚未有证据的功能与已自动化验证的契约明确区分。

### 语音协议自动化回归

`tests/r55-voice-provider-contract.test.mjs` 调用项目已存在的 `CompatibleAudioProvider` 与 `StreamingPcmSpeechProvider`。通过注入受控 HTTP Fetch 返回值，验证：

- ASR multipart/form-data 中音频类型、模型、语言、鉴权请求头符合既有协议；转录结果保留 `validated:false`，**不能自动当作儿童确认过的文字**。
- 非 2xx、无效 JSON、过大的供应商响应、超长或已经撤销的音频输入均拒绝。
- PCM TTS 请求使用预期的 HTTPS 路径、模型、语音及流媒体参数；每一帧为有界 PCM16 片段。
- 上游断开、错误 MIME、超大 PCM、奇数字节、等待供应商返回期间的取消不会被记为成功。
- 非 HTTPS、本机回环地址和内嵌 URL 凭据不能成为供应商目标。
- 测试专属虚构密钥不进入报告或日志。

这些测试**没有请求真实云端供应商或消费真实凭据**，因此不能宣称云端 ASR/LLM/TTS 已实测。

### ROS 运行时证据审计

新增命令：

```bash
npm run release:runtime-evidence
npm run release:runtime-evidence -- --ros-report .local/ros/acceptance-report.json --ros-run-id <本次实际运行ID>
npm run release:runtime-evidence -- --require-all
```

- 未提供真实报告：`ros_runtime=not_run`，仍保留人工验收阻断。
- 提供报告与本次运行 ID：调用**已有的** `verify-ros-report.py`，检查三段导航目标、位置误差、时钟/TF、路线和真实 run_id。错误、缺失或伪造的报告一律阻断。
- 此 CLI 不启动 ROS/Gazebo、不调用导航动作、不操作物理设备，不修改用户状态。
- 即使 ROS 报告有效，也始终保留 `voice_real_provider=not_run`、`physical_safety_certified=false` 和 `release_approved=false`，不能代替音频和实体安全验收。
- `--require-all` 在上述真实验收缺失时以非零状态退出，不允许通过跳过校验制造通过。

实际 ROS2/Nav2 集成入口仍是既有的 `npm run sim:accept`。需具备 ROS2 Jazzy、Gazebo、Nav2、独立 domain 77、模拟环境标志，按照现有 `run-ros-acceptance.sh` 的安全限制执行。当前通用 GitHub Actions 仅跑 `sim:check` 与 `sim:preflight`，**不具备 Gazebo/Nav2 runtime 验证证据**。

## 下一轮 R56

优先连接用户授权的真实供应商测试环境（凭据不能写入 Git、日志或报告），进行音频采集→ASR→文字确认→AI 对话→TTS 播放、权限撤销/限额/中断联测，并在拥有 ROS2/Gazebo 的隔离环境跑三段导航验收。只有取得真实报告，才可以更新发布候选证据；任何自动化测试或静态预检都不能直接批准发布。
