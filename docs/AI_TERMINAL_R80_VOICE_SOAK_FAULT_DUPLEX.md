# R80：Voice Runtime Soak、Fault Recovery 与 Duplex Hardening

## 为什么这一轮不再继续堆发布签名层

R79 已经把真实 Full Voice Turn 接入 Artifact / Readback / Attestation / Candidate / Permit。
当前主要风险已经变成运行稳定性：

- 长时间运行后是否积累内存或文件描述符；
- Provider 429/5xx、连接关闭、超时之后是否能在下一轮恢复；
- 麦克风/扬声器故障后是否 fail closed；
- TTS 播放结束后是否立即开启麦克风，从而把 Alex 自己的尾音重新识别；
- 显式 barge-in 是否能打断播放，同时避免 0ms 回采造成回声。

## Duplex Guard

浏览器新增 `AlexVoiceDuplexGuard`：

- 禁止 playback/capture 重叠；
- 普通播放结束后默认 260ms 冷却；
- 显式 barge-in 使用较短的 120ms 冷却；
- Realtime PCM、增量录音、短录音、浏览器 WebSpeech 共用同一守卫；
- WebRTC `echoCancellation` 仍保留，但不会把它当作物理 AEC 证明。

这只是浏览器层的半双工防回声策略，不等于专业硬件 AEC 认证。

## Soak Segment

`voice-runtime-soak.mjs` 复用真实 Full Voice Turn：

```text
speaker → mic → ASR → LLM → TTS → speaker → mic proof
```

每轮只聚合：

- started / completed / failed / cancelled；
- fault code / fault category；
- failure → next success 的 recovery；
- total-turn p50 / p95 / p99；
- RSS / heap / Linux FD start / peak / end；
- 最近 256 轮的无内容状态摘要。

不保存 PCM/WAV、转录文本、模型回复文本或凭据。

### Fail closed

以下情况不会靠重试掩盖：

- contract / invalid / mismatch；
- 连续失败达到上限；
- segment 成功率低于 95%；
- RSS 增长超过 256MiB；
- heap 增长超过 128MiB；
- FD 增长超过 32。

## GitHub Actions 时间边界

GitHub Actions 单个 run step 最大 360 分钟，因此 R80 workflow 只执行 1/2/4h segment。
8/24/72h 不声明为单 Job 连续运行，而使用多个独立 self-hosted segment 聚合。

`voice-runtime-soak-aggregate.mjs` 要求：

- 每个 segment 都通过真实报告 verifier；
- 单 segment 不超过 4h；
- Run ID 唯一；
- 报告 digest 唯一；
- Commit 完全相同；
- 实际观测时长达到声明时长；
- campaign 汇总成功率 >=95%。

72h campaign 的语义明确是：

`segmented-self-hosted-runs-not-single-process-continuity`

不能冒充单进程连续 72 小时。

## 当前仍未证明

R80 Coding 完成并不代表以下事项已经实测：

1. 真实 4h segment；
2. 两段组成的 8h campaign；
3. 24h / 72h campaign；
4. 人工拔掉麦克风/扬声器后的真实 ALSA 恢复；
5. 人工断网与恢复；
6. Provider 真实 429/5xx/outage；
7. 实际房间回声条件下的 AEC 效果；
8. 真实儿童 barge-in 体验；
9. 实体机器人 Physical Safety。
