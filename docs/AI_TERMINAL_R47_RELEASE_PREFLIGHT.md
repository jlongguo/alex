# Alex R47：软件内测发布预检与升级前安全检查

## 已实现能力

R47 新增 `npm run release:preflight -- [状态目录] [备份目录]`。该命令**仅执行只读检查**，不会清理锁、修改状态、执行升级、发布、回滚或自动授权。输出是聚合诊断而不是家庭数据原文。

检查项目：

- Node.js 当前运行时最低版本（>=20），本地家长认证配置是否满足基本条件；
- 状态目录、已知 JSON 文件是否是普通文件、大小是否在单文件上限内，JSON 是否能解析以及部分已知 schema version 是否匹配；
- 默认写者锁是否存在（包括崩溃残留锁）。锁不存在**不能证明进程已停止**；
- 18 个已知持久化路径是否全部位于 R43 备份的默认目录中，且文件名满足 R43 的顶层 JSON/JSONL 采集规则；
- 可选计费/用量记录是否通过自定义路径存储；目录外数据会明确阻断自动认定备份覆盖完整；
- 两个存储对象是否误指向同一个路径；
- 如提供备份目录，调用 R43 的 SHA-256 清单核验，不仅判断备份目录是否存在。

始终保留 `REAL_USER_ACCEPTANCE=manual-required` 与 `releaseApproved:false`。检查通过只代表可继续人工检查，不代表产品达到上线标准。

## 非破坏性操作步骤

1. **停止 Alex**，使用实际部署方式确认进程已经停止。检查是否有剩余写入任务；若存在遗留写者锁，不要根据 PID 推测后自动删除。
2. 记录并检查所有自定义环境变量中 `*_FILE` 的实际路径，确认家庭数据、WAL、音频计费账本和其他持久化资源的覆盖范围。
3. 在受限且受信任的本地位置创建**全新**备份目录，例如：

```bash
mkdir -p /private/alex-backups
node scripts/offline-state-backup.mjs create .local /private/alex-backups/pre-upgrade-new
node scripts/offline-state-backup.mjs verify /private/alex-backups/pre-upgrade-new
npm run release:preflight -- .local /private/alex-backups/pre-upgrade-new
```

4. 创建**全新空隔离目录**，预演还原；绝不覆盖正式状态：

```bash
mkdir -p /private/alex-recovery-stage
node scripts/offline-state-backup.mjs restore-plan /private/alex-backups/pre-upgrade-new /private/alex-recovery-stage
node scripts/offline-state-backup.mjs restore-stage /private/alex-backups/pre-upgrade-new /private/alex-recovery-stage
```

5. 在隔离环境以真实家庭状态的脱敏副本测试**业务加载和版本升级**、权限、儿童学习进度、Skill WAL 恢复与关闭重启；必须由操作者验证。R47 没有提供自动覆盖回滚功能。

## 当前明确不支持

- 当前没有自动安装器、升级执行器、在线快照、无损生产恢复、自动解锁或完整磁盘映像。
- 不读取和检查外部云端模型、真实 ROS2/Gazebo/Nav2、浏览器声学质量、物理设备安全和用户同意记录。
- 已知版本检测是**有限的静态检测**，不能代替每个状态模块实际 `load()` 与 WAL 恢复验证。
- 自定义锁文件路径、位于其他目录的状态存储以及其他格式（例如 SQLite）的资源，需要单独规划与验证。
- 备份可能包含儿童隐私信息，切勿提交 Git、上传公共 CI 日志或向第三方分享。

## 下一轮 R48

优先执行新装／已有家庭状态升级／真实环境故障恢复、浏览器儿童路径、云端音频供应商和 ROS2/Nav2 的明确验收，记录阻断问题并修复。CI 中的 `sim:preflight` 不是 Gazebo/Nav2 真实运行时证明。
