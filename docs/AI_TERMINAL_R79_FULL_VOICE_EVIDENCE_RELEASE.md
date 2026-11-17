# R79：Full Voice Turn Coherent Evidence + Release Integration

## 目标

R78 已证明同一 Turn 可以走：

Provider PCM seed → 真实扬声器 → 真实麦克风 → ASR → Streaming LLM → PCM TTS → 真实扬声器 → 麦克风回采。

R79 不重复语音链实现，而是把 R78 的真实报告升级为发布级证据：

```text
full-turn report.json
        ↓
GitHub Actions Artifact
        ↓
Artifact ID + Digest
        ↓
GitHub REST Readback
        ↓
Artifact Attestation
        ↓
Coherent Evidence Set
        ↓
Runtime Gate
        ↓
Release Readiness Matrix
        ↓
Release Candidate
        ↓
Signed Release Permit
```

## 发布边界

- 单个 self-hosted report 仍只能表示 `verified-self-hosted`。
- 只有 coherent evidence set 才能升级为 `verified-by-set`。
- Matrix 的 `fullVoiceTurn` 是 software-pilot 硬门槛。
- Candidate 冻结 `automatedEvidence.fullVoiceTurn=pass`。
- Permit 冻结 `subjects.fullVoiceTurn`，并强制与 Candidate/CI Commit 一致。
- Producer 必须是 `[self-hosted, linux, x64, alex-acoustic]`。
- Publication audit 必须运行于 GitHub-hosted runner。
- 两个 Artifact 必须来自同一 Run/Attempt/Commit，且 ID 不得复用。
- 原始 PCM/WAV、转录文本、模型回复文本和设备原始标识不进入 Artifact。

## R79 后仍未被代码替代的真实闭环

1. 实际运行 R79 Full Voice Turn workflow。
2. 实际运行 Voice Provider workflow。
3. 实际运行 ROS/Gazebo self-hosted workflow。
4. 8h / 24h / 72h soak。
5. 麦克风/扬声器热插拔、网络断开、ASR/LLM/TTS outage 与恢复。
6. 真实家庭/儿童 Pilot。
7. 实体机器人 Physical Safety。
8. 真实 production rollback fault-injection drill。

Release Executor 仍故意不实现。
