# Alex R49 — WAL 恢复风险与异常进程退出防护

## 代码检索得出的基线

- 单包 Skill 操作使用 `scripts/skill-package-transactions.mjs`，批量操作使用 `scripts/skill-batch-transactions.mjs`。它们先写 `prepared` 意图，启动时由各自事务协调器进行完整哈希链与业务状态恢复。
- `scripts/single-writer-lease.mjs` 以独占文件防止第二个写入者；意外退出后保留标记，不自动依据 PID 猜测锁已过期。
- R47 原预检检查 WAL JSON 可解析和部分版本类型，却无法直观报告两套 WAL 各有多少 `prepared` 事务。
- R48 隔离备份/恢复验收证明了模拟家庭双学习者的资料、隐私及聊天在本地重启后保持，并不等于生产数据跨版本迁移完成。

## 本批新增能力

新增只读命令：

```bash
npm run release:wal-risks -- .local
npm run release:preflight -- .local
```

`release:wal-risks` 检查**两套**已知 Skill WAL 是否存在、文件是否安全、schemaVersion、记录长度、合法阶段、单调序号、操作 ID 去重、前一摘要引用及摘要格式；只输出统计数字，不输出操作意图、儿童资料和摘要原文。

检测到 `prepared` 时输出 `manual-review-required` 并以退出码 1 阻断操作。结构异常输出 `blocked`；原始数据不被修改，日志不执行自动恢复。

**边界：此扫描不重新计算 canonical JSON 的完整哈希链，也不证明 Manifest 信任证明有效。** 正式服务器启动仍须经原两套 WAL 协调器的完整 `load()/recover()` 验证，升级前还须核对 R42 `/api/release/readiness`、真实业务场景和人工验收。

R47 发布预检已整合 `WAL_SINGLE` 和 `WAL_BATCH` 阻断项。不存在 WAL 对首次安装可接受，但不等于已有历史数据已覆盖备份。

## 异常退出验证

`tests/r49-crash-writer-lock-http.test.mjs` 使用独立测试临时目录和临时 Node 子进程：

1. 正常启动真实 Alex HTTP 服务，进行家长登录。
2. 仅对测试创建的子进程模拟强制退出。
3. 检查租约文件仍在，且 `inspect-writer-lease` 不允许自动清理。
4. 核对 R47 发布预检阻止不安全升级。
5. 启动第二测试实例，断言独占租约阻止服务抢占。
6. 只清理测试临时文件，不触碰用户的生产配置或存储。

该测试验证**不会自动抢占锁**，但不能代替真正有 `prepared` 事务时的 WAL 重放、系统断电后文件系统持久性或跨版本升级验收。

## 操作约束

如果真实业务发生崩溃导致锁残留，应先停止所有相关进程，取得状态及两套 WAL 的隔离备份，人工确认持有者和恢复方案。禁止未审核就删除 `.alex-writer.lock` 或直接启动多个副本；本批不新增自动解锁或破坏性恢复 API。

## 后续阻断项

- 使用可复现的历史版本状态副本，开展跨版本兼容加载和预期迁移测试。
- 对真实 `prepared` WAL 演练完整恢复，验证结果与现有 Registry/Trust 状态一致。
- 在真实浏览器验证家长初始化、儿童会话继续与撤销边界。
- 真实供应商 ASR→模型→TTS 与 Gazebo/Nav2 运行时仍需独立验收，不能以 CI `sim:check` 和 `sim:preflight` 替代。

R49 的 CI 成功只说明上述源码及自动化测试通过，不代表 V1 已获生产发布批准。
