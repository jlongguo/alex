# Alex R68 — Self-hosted ROS Runner Environment Provenance

## 目标

R67 已经用独立 GitHub-hosted publication-audit 对 self-hosted producer Job 与两个 immutable Artifact 做最终只读核验，但 producer 运行时到底使用了什么 OS、Kernel、Node、Python、Gazebo、ROS/apt 包版本，之前仍没有进入证据链。

R68 增加 runner-provenance.json，并把它绑定进 Workflow Bundle v2、主 ROS Artifact、Artifact Attestation v2、coherent evidence set 和 Runtime Gate。

## 捕获时机

Workflow 顺序：

1. approval-gate 明确批准 self-hosted 仿真 Runner；
2. checkout；
3. reset Workflow Bundle，同时覆盖上一 Run 遗留 provenance 为 blocked；
4. setup-node 22；
5. source /opt/ros/jazzy/setup.bash；
6. 捕获并立即严格验证 runner-provenance.json；
7. 才执行 npm install、sim:check 和 Gazebo/Nav2 运行。

这样 provenance 描述的是启动本轮仿真前的真实执行环境，而不是运行结束后再补写的环境声明。

## 强制基线

capture 只有满足以下条件才会产生 status=verified：

- GitHub Actions 手动 workflow_dispatch；
- repository=jlongguo/alex；
- job=nav2-simulation；
- RUNNER_ENVIRONMENT=self-hosted；
- RUNNER_OS=Linux；
- RUNNER_ARCH=X64；
- Ubuntu 24.04 / Noble；
- platform.machine()=x86_64；
- ROS_DISTRO=jazzy；
- ROS_DOMAIN_ID=77；
- ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST；
- ALEX_ROS_SIMULATION_ONLY=1；
- ALEX_RUN_ROS_INTEGRATION=1；
- ALEX_GZ_HEADLESS_RENDERING=1；
- Node major=22；
- Python=3.12.x；
- Gazebo Sim major=8（Harmonic）；
- git HEAD 必须等于 GITHUB_SHA；
- tracked Git worktree 必须 clean；
- 指定 ROS Jazzy apt packages 必须存在并能读取版本；
- 指定 ros2 packages 必须全部解析到 /opt/ros/jazzy。

## 记录内容

报告记录：

- Workflow Run ID / Attempt / Commit SHA / workflow ref；
- Ubuntu ID、版本、codename；
- kernel release、machine architecture；
- Node、npm、Python、git、Gazebo Sim 实际版本；
- ROS Jazzy 关键 apt package 的精确 Debian package version；
- ros_gz/nav2/tf2 等关键 ROS package prefix；
- git HEAD 与 tracked_worktree_clean；
- 仿真隔离 flags。

报告不记录 hostname、GITHUB_TOKEN、完整环境变量、用户 home path 或其他凭据。

## Fingerprint

除 captured_at 外，Actions context、isolation、platform、tools、apt packages、ROS package prefixes 和 source 状态按 canonical JSON 计算 SHA-256，写入 fingerprint_sha256。

离线 verifier 会重新计算 fingerprint；只改 kernel/package/tool/source 任一字段而不重新生成一致 fingerprint 都会失败。

## Bundle / Artifact 升级

workflow-evidence-bundle 升级为 alex.dev/ros-workflow-evidence-bundle/v2：

- provenance 必须由同一 Run/Attempt/Commit 生成；
- provenance 文件 mtime 必须晚于本轮 reset；
- Bundle 记录 provenance 文件 SHA-256 与 fingerprint_sha256；
- Bundle verify 会重新运行 provenance verifier。

artifact-attestation 升级为 alex.dev/ros-artifact-attestation/v2，固定关键文件从 5 份增加为 6 份：

- acceptance-report.json
- cancel-acceptance-report.json
- recovery-acceptance-report.json
- bridge-acceptance-report.json
- runner-provenance.json
- workflow-evidence-bundle.json

因此 provenance 同时受主 Artifact Digest、attestation 文件哈希和最终 GitHub-hosted 双 Artifact audit 保护。

## Stale self-hosted workspace

自托管 Runner 工作区会跨 Run 保留文件。Bundle --reset 现在除了把 Bundle 置 blocked，还会覆盖 runner-provenance.json 为 RUNNER_PROVENANCE_CAPTURE_PENDING。

如果新一轮 provenance 捕获失败，failure Artifact 不会误带上一轮 status=verified 的环境证明。

## Runtime Gate

新增 remaining 项：GAZEBO_RUNNER_ENVIRONMENT_PROVENANCE。

单独验证旧 Bundle 或单独验证 Artifact attestation 都不会解除该门槛。只有 provenance 已被 Bundle、Attestation、GitHub readback 和 coherent evidence set 一起验证后：

ros_runner_provenance = verified-by-set

并移除 GAZEBO_RUNNER_ENVIRONMENT_PROVENANCE。

## 信任边界

R68 提供的是可审计、可哈希绑定、可跨 Artifact 对账的环境事实。它能够发现版本漂移、错误 ROS 发行版、错误 Gazebo major、错误架构、tracked source 修改和 Run/SHA 拼接。

它不能证明被攻陷的 self-hosted Runner 没有伪造命令结果，也没有提供 TPM/TEE/远程硬件证明。真正的强 provenance 仍需要 immutable runner image / image digest、包仓库快照或更强的远程 attestation。

R68 也不替代真实 Gazebo Workflow 执行、真实 Voice Provider E2E 或实体机器人 PHYSICAL_SAFETY_REVIEW。