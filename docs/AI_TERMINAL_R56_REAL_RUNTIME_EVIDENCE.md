# Alex R56 — 真实语音供应商运行时证据闭环

## 本批目标

R55 已证明 ASR/TTS 适配器的协议、边界、取消和 ROS 三段路线报告校验，但真实云端语音仍只有“待验收”标记。R56 第一批不重写现有语音栈，而是复用 `CompatibleAudioProvider`、`CompatibleCompanionProvider`、`StreamingPcmSpeechProvider`、`StreamingSpeechSessions`、`ProviderUsageJournal` 与 R45 的 `revokeLearnerRuntime`，把真实供应商执行结果转换成可复核、可进入发布门槛的聚合证据。

## 新的真实验收入口

```bash
ALEX_RUN_VOICE_PROVIDER_ACCEPTANCE=1 \
ALEX_VOICE_PROVIDER_BASE_URL=... \
ALEX_VOICE_PROVIDER_API_KEY=... \
ALEX_VOICE_ASR_MODEL=... \
ALEX_VOICE_TTS_MODEL=... \
ALEX_CHAT_PROVIDER_BASE_URL=... \
ALEX_CHAT_PROVIDER_API_KEY=... \
ALEX_CHAT_MODEL=... \
npm run voice:accept -- --report .local/voice/runtime-report.json
```

验收链路固定使用项目自带的合成短句，不读取儿童录音或真实家庭对话：

1. 真实 HTTPS TTS 生成固定短句的 MP3，仅驻留内存。
2. 真实 ASR 识别该音频，并要求标准化后的短句匹配。
3. 真实流式 LLM 生成回复；报告只记录字符数和耗时。
4. 真实 PCM TTS 完整读取音频帧，`ProviderUsageJournal` 记录响应字节、帧数和完成状态。
5. 再打开一个真实 TTS 会话，通过现有 `revokeLearnerRuntime` → `StreamingSpeechSessions.erasePrincipal()` 路径撤销，要求旧会话立即不可继续读取，并在供应商用量账本中记录 `cancelled`。

报告不写入音频、转录正文、模型回复正文、API Key、供应商 URL 或学习者真实 ID。临时供应商用量账本位于系统临时目录，验收结束即删除；最终只保留聚合计数。

## 证据验证与发布门槛

```bash
npm run voice:verify -- --report .local/voice/runtime-report.json

npm run release:runtime-evidence -- \
  --voice-report .local/voice/runtime-report.json \
  --voice-run-id <本次 run_id>
```

`verify-voice-runtime-report.mjs` 要求：

- `provider_mode=real`；测试注入产生的 `injected-test` 报告不能通过。
- run_id 必须与本次发布验收指定 ID 完全一致。
- ASR、流式 LLM、PCM TTS、撤销和供应商聚合用量全部通过。
- 一次完整 TTS 必须记为 `completed`，撤销探针必须记为 `cancelled`，且响应字节/帧与成功 TTS 一致。
- 报告必须明确 `release_approved=false`、`physical_safety_certified=false`。

R55 的 `release:runtime-evidence` 现在可同时读取 ROS 和语音报告。任一报告损坏、run_id 不匹配或语音报告来自注入测试时，状态为 `blocked`。

## GitHub Actions 边界

新增 `Voice Provider Runtime Acceptance (manual)` 工作流。只有仓库变量 `ALEX_VOICE_ACCEPTANCE_APPROVED=true` 时才运行，并从 GitHub Actions Secrets 注入供应商配置。普通 PR CI 继续不读取云端凭据、不调用真实供应商、不产生费用。

工作流只上传 `.local/voice/runtime-report.json` 聚合报告，不上传音频、转录、模型正文或临时供应商账本。

## 仍然不能声称完成的事项

这批证据证明的是**真实云端 ASR → 流式 LLM → PCM TTS 及运行时撤销路径**，不是麦克风声学质量、扬声器播放质量、儿童实际体验或供应商账单核对。输入音频来自真实供应商生成的固定合成短句，因此 `acoustic_capture_verified=false`。

ROS2/Gazebo/Nav2 三段真实路线仍必须由已有 `sim:accept` 在隔离 Jazzy/Harmonic 环境执行；物理机器人安全认证始终不由该工具批准。
