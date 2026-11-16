# R75：Recovery Drill Evidence + Runtime Closure Pack

## 目标

把 R48 已存在于测试中的隔离恢复能力提升为正式 CLI 与机器可读发布证据：

```text
Offline Backup
  ↓ verify SHA-256
Empty Staging Restore
  ↓ exact file audit
Release Preflight
  ↓ no blockers
Real Alex Node Boot
  ↓ loopback /api/health
Clean Shutdown
  ↓
alex.dev/recovery-drill/v1
  ↓ commit binding
Release Readiness Matrix
```

## 安全边界

- 只允许向既有空 staging 目录恢复。
- 不覆盖线上/家庭真实状态目录。
- 外部 Voice/Chat/Audio Provider 全部禁用。
- 不执行生产 rollback。
- 不授予 release approval。
- 不声称实体硬件安全通过。

证据固定：

```ini
productionRestored=false
rollbackExecuted=false
releaseApproved=false
physicalSafetyCertified=false
```

## 当前剩余 P0

1. 真实 Voice Provider workflow。
2. 真实 ROS/Gazebo self-hosted workflow。
3. 真实麦克风 → ASR → LLM → TTS → 扬声器声学 I/O。
4. 真实家庭/儿童 Pilot。
5. 实体机器人 Physical Safety。

R75 完成后，Recovery Drill 不再只是 R42/R48 的人工声明，而可由当前 Commit 的正式机器证据解除矩阵门槛。
