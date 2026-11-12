# Alex R55：语音供应商故障契约与 ROS2/Nav2 真实运行证据门槛

## 实际代码依据

Alex 已有 `CompatibleAudioProvider`、`StreamingPcmSpeechProvider`、`VoiceTurnOrchestrator`、ROS2/Gazebo 运行脚本及 `verify-ros-report.py`。这些模块已经区分已提交文字与临时转写，具备音频大小限制、超时和取消入口。单靠 `npm run sim:preflight` 无法证明 Nav2 曾执行目标，且模拟云供应商响应不能证明真实供应商计费和音质。

## 本轮测试与实现

- 新增 `tests/r55-voice-provider-contract.test.mjs`，通过严格的本地替身响应检查实际音频适配器发出的 HTTPS multipart ASR 请求及 PCM TTS 请求；验证模型、语言、授权字段、识别结果 `validated:false`，无效 JSON、429/503、有界响应、音频大小、取消、恶意 PCM、非法上游地址及不回显私钥。
- 新增 `scripts/runtime-acceptance-gate.py` 及测试 `tests/r55-runtime-acceptance-gate.test.mjs`。检查器只读取已有证据，调用项目原有的严格三段路线校验器（包含实际路线目标、run_id、TF/时钟、导航误差）。不会启动真实 ROS/Gazebo，也不会对电机发出指令。
- `npm run release:runtime-evidence -- --require-all` 在缺少云端 ASR/LLM/TTS、真实 Nav2 三段导航或实体安全复核时明确失败。不传 `--require-all` 只生成诊断报告，不代表发布成功。
- 永远输出 `release_approved:false`、`physical_safety_certified:false`；在没有真实供应商信息时 `voice_real_provider:not_run`。不输出儿童录音、令牌或原始对话。

## 运行方式

```bash
npm test
npm run test:browser
npm run release:runtime-evidence
npm run release:runtime-evidence -- --require-all
```

若已经在专用 ROS2 Jazzy、Gazebo Harmonic 的**隔离仿真环境**执行过原有 `npm run sim:accept`，可用本次唯一 run_id 做只读再验证：

```bash
npm run release:runtime-evidence -- --ros-report .local/ros/acceptance-report.json --ros-run-id <本次运行的 ID>
```

真正的 Gazebo/Nav2 运行仍需按现有脚本完成，不能靠伪造 JSON、旧报告或预检状态替代。机器人硬件验收和生产环境操作须另行授权。

## 下一轮优先级 R56

1. 在用户授权且可安全配置的独立测试环境，用真实供应商凭据完成 ASR → 文本人工确认 → AI 回复 → TTS 端到端验收，核对速率、取消、调用次数与账单证据；不要在日志回显 API Key 或儿童资料。
2. 在独立 ROS2 Jazzy/Gazebo Harmonic 仿真环境运行三段导航、目标拒绝与取消恢复；收集同次 run_id 的完整证据，禁止虚报运行时通过。
3. 将两类真实验收结果与发布候选报告绑定，继续保留物理安全认证与人工批准门槛。

本轮 CI 即使全部通过，也只证明**接口契约与证据校验**，不证明已经连到真实云端语音或运行 Gazebo。
