# Alex R50 — 双 WAL 完整摘要校验与真实批量事务重启恢复

## 已核对的实现

单包 Skill 事务由 `SkillPackageTransactions` 管理，批量事务由 `SkillBatchTransactions` 管理。两套事务都写入持久化 `prepared` 意图，再修改 Registry，最后更新终态 WAL。重启时各自调用 `load()/recover()`。

R49 只读检查器只验证摘要长度与链式指针形状，无法区分实际合法哈希与伪造的 64 位十六进制值。R50 使用项目现有 `canonicalJson` 和 SHA-256 规范，验证：

- 单包事务：精确意图字段、Manifest/Artifact 摘要格式、请求摘要、每条记录的哈希和前一摘要引用。
- 批量事务：目标 pin 唯一性、数量限制、证据字段和摘要、基线快照的结构，以及请求摘要和整条记录的哈希链。
- 已篡改但能通过浅层结构检查的终态记录，必须被标记为 `blocked`，并由发布预检拒绝。
- 保持只读，不调用恢复、不清理写者锁、不修改用户数据；仅报告统计数字。

注意：单独验证 WAL 哈希链，仍**无法证明外部发行者签名可信、Registry 安装状态一致或 WAL 已安全完成恢复**。这些检查必须通过正式事务加载器、信任库和隔离运行时测试进行。

## R50 测试行为

`tests/r50-batch-restart-compat.test.mjs` 创建真实本地 Registry 和批量事务协调器，使用独立测试临时目录：

1. 已审批的两个声明式 Skill 包，提交批量安装请求。
2. 模拟 WAL 写入 `prepared` 后、Registry 安装之前失败；重建加载器对象，从磁盘重新读取并完成恢复。
3. 模拟 Registry 安装成功、WAL 最终提交失败；重启后验证只补交日志，不再重复安装和污染审计历史。
4. 修改已写入 WAL 的 Artifact 摘要，检查 R50 扫描器和正式批量加载器均拒绝非法哈希链。
5. 生成旧版 Registry schemaVersion=1 快照，验证现有加载器只在内存中兼容为 v2，并且不擅自覆盖原始历史文件。

已有 R37 单包 WAL 测试继续覆盖单包 `prepared`、审批后故障、安装后日志提交失败及信任撤销等回归。

## 保留的上线阻断

不提供自动删除遗留租约、自动修改生产 WAL、升级正式数据或执行真实第三方代码。R50 模拟的是进程逻辑故障，不代表断电 fsync 行为已验收。真实版本跨度、家长实际浏览器、云端 ASR/LLM/TTS、ROS2/Nav2 与实体机器人仍需分开验证。发布门槛 `releaseApproved:false` 保持不变。

推荐本地检查：

```bash
npm test
npm run release:wal-risks -- .local
npm run release:preflight -- .local
npm run sim:check
npm run sim:preflight
```
