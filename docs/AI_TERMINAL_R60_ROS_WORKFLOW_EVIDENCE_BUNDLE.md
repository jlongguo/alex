# Alex R60 — ROS 三场景工作流证据对账与防旧缓存

## 目标

现有 R57–R59 已分别建立三段导航、Nav2 Action 取消、取消后恢复三类运行时验收，并有独立严格验证器。R60 新增**跨报告校验**，解决自托管 Runner 保留旧报告、不同 Actions Run 的报告拼接、文件被替换，以及 Commit/Workflow Run 关联缺失的问题。

这是一项证据完整性和可审计性改进，**不是加密证明**。报告 JSON、GitHub 环境变量和 SHA-256 都可以由有权控制工作区的执行者伪造；是否确实由获批准的 Runner 运行，必须再与 GitHub Actions 的执行日志、Artifact、提交 SHA 和相关安全控制进行外部对账。

## 正常工作流

手动 ROS 工作流由 `vars.ALEX_SIM_RUNNER_APPROVED == 'true'` 控制，仍限定 `[self-hosted, linux, x64, alex-ros-sim]`，只允许 ROS Domain 77 + LOCALHOST、仿真环境：

1. 检出源码后，**立即**执行 `ros-workflow-evidence-bundle.py --reset`，覆盖旧的 `assembled` 状态，保存本次 Workflow Run ID/Attempt/SHA 和开始时间；
2. 在三个不同的 Gazebo 进程会话运行 `sim:accept`、`sim:accept-cancel` 和 `sim:accept-recovery`；
3. 三项全部通过，才允许 `--collect`，此时重新执行原有报告验证器并要求不同的 ROS run ID、每个文件晚于本次 reset；
4. 对每份报告记录 **文件名、模式、run ID、字节数、SHA-256**，生成 `workflow-evidence-bundle.json`；
5. `--verify` 再次读取原始报告，以工作流 Run ID、Commit SHA、Attempt 进行对账；
6. 无论是否成功，Artifact 上传现存报告与 Bundle。若中途失败，Bundle 留在 `blocked`，不得复用旧的成功清单。

脚本只读报告、写入清单；**不会**调用 ROS Action、不控制电机、不终止 Gazebo 进程。

## 实际命令

在获批准、未连接真实机器人的手动 Runner 中，工作流自动执行：

```bash
python3 scripts/ros-workflow-evidence-bundle.py --reset
# 三个 Gazebo 场景分别完成之后
npm run sim:bundle-collect
npm run sim:bundle-verify -- \
  --expect-run-id "$GITHUB_RUN_ID" \
  --expect-sha "$GITHUB_SHA" \
  --expect-attempt "$GITHUB_RUN_ATTEMPT"
```

离线复核从 GitHub Artifact 取回的同目录四个 JSON：

```bash
npm run sim:bundle-verify -- \
  --bundle .local/ros/workflow-evidence-bundle.json \
  --expect-run-id <GitHub Actions Run ID> \
  --expect-sha <对应的 40 位 Git Commit SHA> \
  --expect-attempt <Actions Run Attempt>
```

新 Bundle 的文件名和三个证据报告的文件名在代码中固定，不接受自报任意文件名或外部路径。严格验证器继续复用 R55/R58/R59 既有的 TF、Nav2 生命周期、12 厘米误差、里程、取消 ACK、终态和停止窗口阈值。

## 发布 Gate

```bash
npm run release:runtime-evidence -- \
  --ros-workflow-bundle .local/ros/workflow-evidence-bundle.json \
  --ros-workflow-run-id <GitHub Actions Run ID> \
  --ros-workflow-sha <Git Commit SHA>
```

新增独立阻断 `GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE`，校验通过时只标记 `ros_workflow_bundle=verified-structure`，**不会**把 `ros_runtime`、`ros_cancel_runtime`、`ros_recovery_runtime` 标记为已通过，也不解除 `PHYSICAL_SAFETY_REVIEW`。

实际释放任何 ROS 运行门槛，仍需要相应报告显式输入本次运行 ID 并通过自身验证；任何报告都不能代替实体硬件安全认证。

## 仍存在的可信度边界

- 一份结构有效、SHA 一致的 Bundle 并不等于可信的真实 Gazebo 运行，它只是便于人工/自动对账的证据索引；
- 普通 PR CI 使用构造的 **synthetic fixture** 测试验证器拒绝篡改、过期缓存和不合规环境；不会创建可发布的真实运行报告；
- 若需达到高可信软件交付，还要在获授权的 Actions Run 下审计 Runner 的隔离配置、日志、上传的 Artifact、Commit SHA、Run Attempt，以及同一实验对应的三个原始报告；
- 本轮未模拟 Nav2 服务崩溃或 ROS 网络分区。继续对这些故障做实验，应在隔离 Gazebo 环境制定专用注入策略，避免误伤其他 ROS Domain。
