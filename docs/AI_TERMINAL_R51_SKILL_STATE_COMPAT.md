# Alex R51 — Skill Registry / Trust 兼容加载与发布阻断

## 已核实的原有机制

R50 已使双 WAL 风险扫描直接复用正式的单包、批量事务校验函数。然而 R47 的发布预检对 Skill Registry/Trust 快照此前只进行 JSON 格式和有限版本检查，不能证明以下性质：

- Registry 自身的安装 pin、声明式包 Manifest、依赖关系、引用与历史哈希链有效；
- Trust 保存的 Ed25519 发行者公钥、包证明与审计事件链可由正式加载器接受；
- 已安装版本拥有未被撤销的发行者签名，不是仅靠 `status=approved` 的 UI 状态。

## 本轮 CLI 和发布预检

新增只读命令：

```bash
npm run release:skill-compat -- .local
npm run release:preflight -- .local
```

`skill-state-compat.mjs` 对指定目录的 Registry 和 Trust 文件进行普通文件/符号链接/大小限制检查，然后实例化项目原有 `SkillPackageRegistry`、`SkillPackageTrust` 并调用实际 `load()`。**不会调用 `save()`、`review()`、`install()` 或进行迁移写回**。

对于实际安装的每个包，调用 `trust.assertTrusted(manifest)`，验证 Manifest 摘要、Ed25519 证明和发行者未被撤销。只返回检查名、状态、拒绝数量等聚合信息；不返回密钥、签名、家长密码、儿童信息或包 Manifest 原文。

- Registry/Trust 状态文件不安全、JSON 数据无法通过正式加载器，或已安装包不可信：阻断发布预检。
- Registry 已有历史包但 Trust 文件丢失，以及反向的有证明无 Registry：阻断不完整恢复。
- 旧版 Registry schemaVersion=1：使用原模块在内存中转换为 v2，并标记 `manual-required`；不改写原文件，也不能宣称已实际完成升级。
- 全新安装两个文件都不存在：视为可继续安装检查，但不能由此断言用户的历史资料完整。

R47 发布预检新增三个以上独立 `SKILL_*` 状态条目（Registry、Trust、State Pair、Installed Provenance）。任何 block 均进入总发布阻断列表。

## 验证证据的边界

单元及真实磁盘状态测试使用测试专属 Registry/Trust，生成 Ed25519 密钥与签名，验证：

1. 可信发行者与安装清单一致时成功只读载入。
2. 未签名的已安装包拒绝通过；撤销发行者后同样拒绝。
3. Trust 签名损坏、Registry 审计哈希链损坏均被正式加载器拒绝。
4. Registry v1 只在内存中兼容，磁盘旧文件保持原样。
5. 数据源为符号链接、不完整文件对或未授权的额外元数据时拒绝。
6. CLI 只输出聚合数据，不泄漏私密内容，且没有任何发布授权标记。

**以上不证明**真实生产跨版本迁移、异常断电 fsync、已准备 WAL 的完整恢复、真实浏览器儿童体验、云端 ASR/LLM/TTS、Gazebo/Nav2 或实体安全已通过。上线许可依然是 `releaseApproved:false`。

## 下一轮

优先将 R50/WAL 与 R51 Registry/Trust 的真实加载结果结合成隔离恢复的端到端场景，包括 Registry 包签名与恢复后状态比对；再逐步收敛浏览器、语音和 ROS2 真实验收。
