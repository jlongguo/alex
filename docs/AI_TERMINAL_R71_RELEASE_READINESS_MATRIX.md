# Alex R71 — Release Readiness Matrix 与跨证据 Commit 一致性

## 背景

R42 已经有 `release-readiness.mjs`，负责家庭认证、儿童入口、Skill/WAL、音频配置、恢复演练等本地发布条件；R55 之后又逐步形成真实 Voice/ROS Runtime Gate；R70 再把标准 CI 拆成 unit、Browser、ROS static 三个独立失败域。

问题是三套事实来源彼此分离：

- R42 仍使用静态布尔/人工验收语义；
- Runtime Gate 能严格验证 Voice/ROS evidence，但原输出没有被统一发布视图消费；
- CI 有真实 Job 结论，却没有机器可读 summary；
- 即使三类证据都存在，也没有一层保证它们来自同一个 Commit。

R71 不新增 ROS/Voice 原始 verifier，而是建立只读编排层。

## CI Evidence

`scripts/ci-evidence.mjs` 只接受标准 `Verify` Workflow 的 `evidence-summary` Job 环境，并记录：

- repository / event；
- Workflow Run ID / Attempt；
- Commit SHA；
- `test` Job conclusion；
- `browser` Job conclusion；
- `sim-static` Job conclusion。

只有三个域全部 `success` 时 `status=verified`。failure/cancelled/skipped 任一出现都得到 `blocked`。

报告明确：

- Browser success 代表真实 Chromium 引擎使用合成家庭数据跑通；
- `sim-static` success 只代表 ROS 静态检查，不代表 Gazebo/Nav2 runtime；
- `runtimeAcceptance=false`；
- `physicalSafetyCertified=false`；
- `releaseApproved=false`。

脚本不读取测试日志、不读取 Secret、不记录 `GITHUB_TOKEN`。

## CI Workflow 汇总 Job

标准 `.github/workflows/ci.yml` 新增：

`evidence-summary`

它使用 `if: always()` 并 `needs: [test, browser, sim-static]`。因此即使某个验证域失败，summary 仍能记录真实 conclusion；但失败的原 Job 仍保持 failure，summary 不使用 `continue-on-error`，也不会把整个 Workflow 洗绿。

生成 `.local/ci/evidence.json` 后立即用同一严格 verifier 复核，再以固定 Artifact `alex-ci-evidence` 上传。

## Runtime Gate Subject

R55–R69 的 coherent evidence set 已经严格要求 Run ID / Attempt / Commit SHA，但原聚合输出只给 `verified-by-set`，没有保留 subject。

R71 在 Runtime Gate 输出中新增：

`subjects.ros`

`subjects.voice`

只在对应 coherent set 真正验证通过后写入：

- Run ID；
- Attempt；
- Commit SHA。

单独 ROS report 或单独 Voice report 不会获得 release-grade subject。

## Release Readiness Matrix

`scripts/release-readiness-matrix.mjs` 接受三类只读输入：

- `--static`：R42 `alex.dev/release-readiness/v1`；
- `--runtime`：R55+ `alex.dev/runtime-acceptance-gate/v1`；
- `--ci`：R71 `alex.dev/ci-evidence/v1`。

只有 `--static` 是必需项。缺 Runtime/CI 时不会猜测通过，而是明确输出 `evidence-required`。

矩阵域：

- `staticConfiguration`；
- `ci`；
- `browserJourney`；
- `voiceProvider`；
- `rosSimulation`；
- `realAcousticIo`；
- `realChildJourney`；
- `recoveryDrill`；
- `physicalSafety`。

状态严格区分：

- `pass`；
- `blocked`；
- `evidence-required`；
- `manual-required`。

## Commit 一致性

当 CI 与 Runtime evidence 同时提供时：

- Voice subject Commit 必须等于 CI Commit；
- ROS subject Commit 必须等于 CI Commit；
- Voice 与 ROS subject Commit 必须彼此相同。

任何跨 Commit 拼接都会让对应 domain 变为 `blocked / commit-mismatch`。

这样不能再把旧 Commit 的真实 Voice PASS、另一个 Commit 的 ROS PASS 与当前 CI 绿灯拼成一个看起来完整的候选版本。

## 软件与机器人两个目标

Matrix 同时输出：

`targets.softwarePilot`

`targets.robotCandidate`

软件候选需要静态配置、当前 CI、Browser 和真实 Voice provider evidence；但真实声学 I/O、真实儿童旅程、恢复演练仍保留人工复核。

机器人候选还要求完整 ROS/Gazebo coherent evidence；即使全部运行证据齐全，也始终保留 `physicalSafety`，不会自动认证实体设备安全。

所有情况下：

`releaseApproved=false`

`physicalSafetyCertified=false`。

## 家长面板

`GET /api/release/readiness` 现在同时返回：

- 原 R42 `report`；
- R71 `matrix`。

线上 API 只把服务端现场生成的静态 `report` 传给 Matrix，不读取任意外部 runtime/CI JSON 文件，所以用户不能靠手工放一个伪 evidence 文件让面板变绿。

家长 UI 分开展示静态检查与证据矩阵，明确标出每个 domain 是通过、阻断、缺证据还是必须人工验证。

## CLI

完整离线聚合：

`npm run release:matrix -- --static <static.json> [--runtime <runtime.json>] [--ci <ci.json>]`

该命令只读输入并输出矩阵；`blocked` 返回非零退出，但不会执行部署、发布、升级、回滚、Workflow dispatch 或设备操作。

## 仍未闭环

R71 解决的是证据编排与版本一致性，不代表以下事实已真实发生：

- R68 self-hosted ROS/Gazebo 手动 Workflow 真正执行；
- R69 Voice Provider 手动 Workflow 真正执行；
- 真实麦克风与扬声器链；
- 真实儿童/家庭用户验收；
- 完整恢复演练；
- 实体机器人物理安全；
- 正式发布审批。