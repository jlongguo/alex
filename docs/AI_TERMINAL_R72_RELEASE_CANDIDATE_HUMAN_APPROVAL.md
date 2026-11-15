# Alex R72 — Release Candidate Manifest 与人工发布审批审计

## 目标

R71 已把静态发布条件、真实 Voice/ROS Runtime Gate 和标准 CI 汇总成 Release Readiness Matrix，但 Matrix 始终 `releaseApproved=false`。R72 建立下一层：把某一个具体软件 Commit 的自动证据冻结成不可变候选，再要求本地家长显式完成剩余人工检查并写入审批账本。

R72 只覆盖 `software-pilot`。实体机器人仍必须单独完成物理安全验收，不能借软件批准变成 `physicalSafetyCertified=true`。

## 信任链

候选生成路径不是“上传一个 Matrix JSON”。管理员必须提供三份源证据：

- R42 static readiness；
- R55+ Runtime Gate；
- R71 CI evidence。

`release-candidate-manifest.mjs` 会重新调用 `composeReleaseReadinessMatrix()`，因此继续复用原有 Runtime/CI verifier，而不是相信客户端声称的 `pass`。

同时冻结三份源证据的 canonical SHA-256：

- `sourceEvidence.staticDigestSha256`；
- `sourceEvidence.runtimeDigestSha256`；
- `sourceEvidence.ciDigestSha256`。

候选还冻结：

- 当前 Commit SHA；
- 完整 Matrix SHA-256；
- CI / Browser / Voice 自动证据状态；
- 必须由人确认的检查项；
- Candidate ID；
- Candidate Digest。

任何字段变化都会改变候选 digest。

## Matrix verifier 加固

R72 为 R71 Matrix 新增 `verifyReleaseReadinessMatrix()`。

它不仅验证字段类型，还重新根据 domain 状态推导：

- software blockers；
- software evidenceRequired；
- software manual；
- software target status；
- robot blockers；
- robot evidenceRequired；
- robot manual；
- robot target status。

因此不能手工删掉 `realAcousticIo`、`realChildJourney` 或 `recoveryDrill` 后把伪造 Matrix 送去生成候选。

## Candidate 生成条件

只有满足以下条件时才能生成 software candidate：

- `targets.softwarePilot.status === manual-release-review`；
- software blockers 为空；
- software evidenceRequired 为空；
- 当前 CI 为 pass；
- 真实 Chromium journey 为 pass；
- 真实 Voice Provider coherent evidence 为 pass；
- CI Commit 存在并合法。

ROS/Gazebo 对软件候选不是硬阻断，但 Robot Candidate 仍保持独立状态。

候选文件本身始终：

- `releaseApproved=false`；
- `deployExecuted=false`；
- `rollbackExecuted=false`；
- `physicalSafetyCertified=false`。

## CLI

生成候选：

`npm run release:candidate -- create <static.json> <runtime.json> <ci.json> <candidate.json>`

校验候选：

`npm run release:candidate -- verify <candidate.json> [commit-sha]`

CLI 只读源证据并原子写候选文件，不部署、不升级、不回滚。

## 服务端候选来源

服务端只通过：

`ALEX_RELEASE_CANDIDATE_FILE`

读取本机候选文件。

浏览器没有 candidate upload/import API，也不能提交 Matrix 或 Runtime evidence。

审批账本默认存放：

`.local/release-approvals.json`

可通过 `ALEX_RELEASE_APPROVAL_FILE` 调整。该文件已纳入 R47 release preflight 的已知备份范围；如果把账本移出默认状态目录，BACKUP_SCOPE 会阻断默认备份覆盖判断。

## 家长审批 API

只允许 `AUTH_MODE=local` 的 parent：

- `GET /api/release/candidate`；
- `POST /api/release/candidate/decision`。

审批请求必须绑定：

- Candidate ID；
- Candidate Digest；
- requestId；
- action；
- 全量人工检查 acknowledgements。

Candidate ID 或 Digest 与磁盘当前候选不一致时直接 `RELEASE_CANDIDATE_CHANGED`。

## 人工确认

软件候选当前需要人工确认 Matrix 中仍为 manual-required 的软件项，例如：

- `realAcousticIo`；
- `realChildJourney`；
- `recoveryDrill`。

家长 UI 必须逐项勾选，所有项都确认后批准按钮才可用，并且批准前还有二次确认。

勾选表示人工声明已经在真实环境完成对应验收，不代表系统自动生成了新的运行时证据。

## 审批账本

`ReleaseApprovalLedger` 使用顺序事件：

- `seq`；
- `prevHash`；
- `hash`；
- Candidate ID / Digest；
- Commit SHA；
- reviewerRole；
- action；
- acknowledgements；
- requestId；
- timestamp。

每个事件的 SHA-256 覆盖前一事件 hash，因此账本中间记录被修改后，重启加载会 fail closed。

requestId 具备幂等语义：同一 requestId 的完全相同决定返回 duplicate；内容不同则拒绝为 idempotency conflict。

## 候选变化

审批状态是 Candidate ID + Candidate Digest 精确绑定的。

即使 Commit 相同，只要重新生成候选导致 Candidate Digest 变化，之前的批准也不会继承到新候选。旧浏览器继续提交旧候选会得到 conflict。

## 批准的含义

只有家长明确 approve 当前候选后，`/api/release/candidate` 的审批视图才会返回：

`releaseApproved=true`

这个字段只代表 **当前 software candidate 的人工审批记录存在并与当前 digest 匹配**。

它明确不代表：

- 已执行部署；
- 已执行升级；
- 已执行回滚；
- 已发布到生产；
- 机器人已经物理安全认证。

因此同一状态始终保持：

- `deployExecuted=false`；
- `physicalSafetyCertified=false`。

R71 Matrix 本身也继续保持 `releaseApproved=false`，避免把人工审批倒灌成自动证据。

## 家庭审计

成功 approve/reject 同时写入既有家庭 AuditLog，只记录动作、结果和 requestId，不写 Candidate Digest、家庭隐私或任何 Secret。

完整 Candidate/Commit/Digest/人工确认项仍保存在专用 hash-chained approval ledger。

## 当前仍未闭环

R72 解决发布候选冻结与人工批准审计，但以下实际运行事实仍需执行：

- R68 self-hosted ROS/Gazebo Workflow；
- R69 真实 Voice Provider Workflow；
- 真实麦克风与扬声器链；
- 真实家庭/儿童用户验收；
- 真实恢复演练；
- 实体机器人物理安全。

此外 GitHub Actions 仍使用浮动 `@v4` action refs，供应链 pinning 尚未完成。