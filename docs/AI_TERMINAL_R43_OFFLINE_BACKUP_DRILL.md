# Alex R43 — 离线数据备份与恢复演练

## 实施边界

R43 新增 `scripts/offline-state-backup.mjs`，仅在 Alex 已退出、默认状态目录的独占写入标记不存在时使用。工具不会执行设备指令、运行第三方 Skill、读取云端密钥或修改现有家庭状态。

**重要：这不是完整产品备份。** 只收集指定源目录顶层的常规 `.json` 与 `.jsonl` 文件。外置的环境变量指向其他目录时、其他数据格式（如 SQLite）、设备固件、外部云端资源、ROS 运行环境等**均不包含**。输出报告明确 `fullApplicationBackup:false`。

备份可能包括儿童档案、家庭记忆、审计事件、学习记录，必须在受信任的本地受限存储中保存。不要将备份原样提交 Git 或分享至公开网盘。

## 完整演练示例

先正常停止 Alex 服务，确认没有其他服务进程持有同一状态目录。如果 `ALEX_SERVER_LOCK_FILE` 配置成非默认路径，**必须先检查那个实际锁路径**，本工具默认只检查源目录的 `.alex-writer.lock`。

下面路径仅为示例；使用前应自行确认真实状态位置：

```bash
# 仅在项目已停机时执行；目录必须存在且包含真正需要的状态文件。
mkdir -p /private/alex-backups
node scripts/offline-state-backup.mjs create .local /private/alex-backups/snapshot-20261111

# 对照备份清单与每个文件 SHA-256，不改动备份。
node scripts/offline-state-backup.mjs verify /private/alex-backups/snapshot-20261111

# 只读预演：仅允许目标为已经存在的空目录。
mkdir -p /private/alex-staging-empty
node scripts/offline-state-backup.mjs restore-plan /private/alex-backups/snapshot-20261111 /private/alex-staging-empty

# 隔离恢复演练：写入空的 staging 目录，不覆盖线上数据。
node scripts/offline-state-backup.mjs restore-stage /private/alex-backups/snapshot-20261111 /private/alex-staging-empty
```

- 创建时独占新目录；已有目标或源/目标路径重叠时拒绝。
- 识别源目录标记及尚未清理的 `.tmp` 文件，检测软链、非普通文件、异常 JSON、过多/超大文件。
- 对每个源文件计算 SHA-256、保留字节原文、记录体积和快照 ID；读完再次检查源目录快照是否变化。
- 校验要求文件集与清单完全一致，拒绝额外文件、路径穿越、清单篡改、摘要/大小不一致。
- 恢复预演不写任何文件；恢复演练每个目标文件都通过 `wx` 新建，拒绝覆盖已有文件。
- 如果备份过程中失败，保留部分新备份目录供人工诊断，**不要把它视为成功快照**，必须完整验证后才能使用。

## 上线缺口

- 业务级恢复验收（重新加载所有状态模块、跨存储校验、WAL 重放、儿童权限及语音对话）仍需单独执行；本轮仅证明文件级复制及一致性核验。
- 备份不加密；需要由使用者选择加密且访问控制严格的本地存储，后续考虑安全的应用级加密与保留策略。
- 未实现在线一致性快照、分布式备份、增量备份、覆盖现有状态的生产恢复。
- 异常退出遗留锁不允许自动清理；必须确认旧实例彻底停止后依既有运维流程恢复。
- 正式发布门槛中的 `DATA_RECOVERY_DRILL` 仍保持 **manual-required**，文件级演练不会擅自将其标记为全部验收通过。

## R44 方向

家长首次使用向导、儿童档案创建、隐私授权默认拒绝与首次学习/语音体验；优先打通真实用户路径，而非增加无关的基础设施抽象。
