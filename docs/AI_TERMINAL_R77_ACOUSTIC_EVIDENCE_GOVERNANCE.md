# R77：Acoustic Evidence Governance

## 目标

R76 已能在专用 self-hosted runner 上执行真实 ALSA 扬声器 → 空气/物理路径 → 麦克风回采，但单个本地 report 仍不足以作为发布级证据。

R77 将 Acoustic 提升到与 Voice/ROS 同等级的 Artifact 治理：

```text
Physical Acoustic Run
        ↓
report.json
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

## 信任边界

- Producer 必须运行在 `[self-hosted, linux, x64, alex-acoustic]`。
- Publication Audit 必须运行在 GitHub-hosted runner。
- 主 Artifact 与 Attestation Artifact 必须是同一 Run / Attempt / Commit 的不同 immutable Artifact。
- 原始 WAV 不上传；Artifact 只包含隐私安全的 `report.json`。
- 单个 self-hosted report 只产生 `evidence-required/runtime-unpublished`，不能再直接解除发布门槛。
- 只有 coherent set 才令 `realAcousticIo=pass`。
- Candidate 冻结 `realAcousticIo=pass`。
- Signed Permit 绑定 `subjects.acoustic`，并要求 Acoustic Commit 与 Candidate Commit 一致。

## R77 后仍需真实闭环

1. 实际配置并运行 `alex-acoustic` self-hosted runner。
2. 实际 dispatch Voice Provider workflow。
3. 实际 dispatch ROS/Gazebo self-hosted workflow。
4. 同一真实物理轮次的 Mic → ASR → LLM → TTS → Speaker E2E。
5. 8h / 24h / 72h soak 与设备热插拔、断网、Provider outage。
6. 真实家庭/儿童 Pilot。
7. 实体机器人 Physical Safety。
8. 真正的生产 rollback fault-injection drill。

R77 仍不实现自动 Release Executor，也不把任何软件证据解释为实体机器人安全认证。
