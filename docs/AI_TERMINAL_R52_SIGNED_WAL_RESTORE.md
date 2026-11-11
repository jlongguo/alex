# Alex R52 — 真实签名 WAL 恢复与隔离备份一致性验收

## 本轮为什么需要完整联测

R50 证明了单包、批量 WAL 在独立 Registry 和模拟 Trust 下可恢复。R51 使用真实 Ed25519 签名证明 Trust/Registry 加载器可拒绝错误签名，但仍未验证**真实已签名包在 WAL 崩溃、离线备份、隔离恢复之后能否再次正确恢复**。

R52 将以上流程连接为一个测试专属的完整闭环，不触碰用户的生产家庭目录和真实机器人：

1. 为两个声明式 Skill Manifest 生成测试专属 Ed25519 密钥、签名和 Artifact SHA-256，使用正式 Trust 存储签名证明；
2. 在真实 Registry 中提交与审批两个版本；
3. 单包：注入 `prepared` 写入后、Registry 安装前的故障；
4. 批量：注入 Registry 已安装成功，但 WAL 最终提交失败；
5. 调用 R43 原离线备份创建和完整性验证，在**另一个全新空目录**完成 R48 隔离恢复及文件集合审计；
6. 重新构造 Registry、Trust、两套 WAL 协调器并调用正式 `load()/recover()`；
7. 对比恢复前后安装版本、Registry 审计记录数、WAL 状态，以及**源文件原样未变化**；
8. 将发行者撤销后再尝试恢复，必须保留 `prepared` 且提示人工审核；
9. 篡改备份中的 WAL proof，必须拒绝 staging，而不是先复制后报警。

## 新的只读恢复来源检查

```bash
npm run release:skill-recovery -- .local
npm run release:preflight -- .local
```

`scripts/skill-recovery-evidence.mjs` 复用 R49/R50 的正式 WAL 哈希链验证和 R51 的 Registry/Trust 载入检查；在内存中进一步对照 `prepared` 事务对应包的实际 Manifest、发行者签名和 Artifact 摘要。

- `pass`：未找到等待恢复的 WAL，且已知状态可读；**不代表发布获批**。
- `manual-review-required`：存在未完成但证明仍可核对的 WAL；**不会执行重放**，操作人员应在隔离副本演练并验证业务一致性。
- `blocked`：状态、WAL 格式、历史链、信任证明或关联关系无法验证。禁止将其视为可恢复状态。
- 输出只包含记录数量、拒绝数量和原因代码，不包含包 Manifest、儿童聊天、签名原文、私钥或密码。
- 所有输出保留 `replayExecuted:false`、`recoveryApproved:false`、`releaseApproved:false`。

R47 发布预检同步新增 `SKILL_PENDING_PROOFS` 检查项。即使来源签名通过，已有 `WAL_SINGLE` / `WAL_BATCH` 检查仍会阻止带 `prepared` 记录的升级，直到恢复完成并重新验证。

## 不在本轮范围

不自动修复损坏的 Registry/Trust、清理锁、覆盖真实状态、解密或运行第三方 Skill、部署到生产或启动实体机器人。上述自动化仅证明**模拟本地持久化事务的逻辑故障**，不证明断电写入持久性、真实跨版本生产升级、云端语音质量、浏览器行为或 ROS2/Nav2 实时安全。

## R53 建议

R53 优先进行真实浏览器儿童旅程与上线诊断：家长初始化、两个孩子登录、学习会话、刷新及重新登录、撤销与失效确认；同步规划需要真实供应商凭据的语音与 ROS2/Nav2 人工验收证据。保留 CI 不能冒充实体设备验收的限制。
