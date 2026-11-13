# Alex R59 — 真实 Nav2 超时后的取消、恢复与返回停靠点

## 本轮范围

在 R58 已合并到 `main` 的现有 Gazebo/ROS2 Jazzy 仿真验收链路上加入独立的、受控的真实 Action 超时场景。

- **R55–R57**：三段路线、运行时门槛、伪进程故障契约。
- **R58**：真实 Gazebo/Nav2 目标取消确认、终态 `CANCELED`、独立 TF/odom/速度命令停稳。
- **R59**：Nav2 目标被接受并收到反馈后，故意令固定 1.5 秒的“客户端验收预算”到期；要求取消并停稳，再次正常导航到书桌，最后返回停靠点。

本轮“超时”来自验收进程**固定的本地运行预算**，并非通过断网、关闭 Nav2 或制造规划器失效实现。不能把它理解为 ROS 网络中断或真实服务器故障恢复。

## 运行条件与命令

仅在专用 Gazebo 模拟环境、确认**没有真实硬件连接**时执行：

```bash
set -euo pipefail
source /opt/ros/jazzy/setup.bash
export ALEX_ROS_SIMULATION_ONLY=1
export ALEX_RUN_ROS_INTEGRATION=1
export ROS_DOMAIN_ID=77
export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST

npm run sim:accept-timeout-recovery
```

`run-ros-acceptance.sh` 仅允许 `route`、`cancel-probe`、`timeout-recovery` 三种固定模式。开始前会覆盖同一模式的旧报告为 `blocked`，为每个模式保存独立报告和日志，并对 `sim:accept-timeout-recovery` 使用独立 Gazebo 会话。

本轮禁止外部配置随意修改超时、目标或终点：超时固定为 1.5 秒，先要求至少一次真实 Nav2 Action feedback，若目标已完成则拒绝冒称超时。

执行顺序：

1. ROS 图、LiDAR、odom、TF、Nav2 生命周期 ACTIVE 检查。
2. 向 `study_desk` 发送目标，要求明确接受并收到至少一帧反馈。
3. 开始 1.5 秒受控验收时限，要求到期时 Action 仍在运行。
4. 向真实 Nav2 Action 发出 `cancel_goal_async`，必须得到有效 ACK 和 `STATUS_CANCELED` 终态。
5. 复用 R58 停稳观测：TF 有效、odom 与 /clock 前进、1.5 秒期间位移 ≤0.08 米且受监控的速度指令非零计数为零。
6. 停稳后重新导航到 `study_desk`，再导航到 `dock`，两段均由原有 `summarize_leg` 独立验证真实运动距离、Action feedback 与到达位置误差 ≤0.12 米。

任何步骤失败，整体报告状态都是 `failed`；不会把部分成功或旧的测试报告当作本次通过。

## 证据与门槛

默认报告：`.local/ros/timeout-recovery-report.json`，日志：`.local/ros/timeout-recovery-launch.log`。

```bash
npm run sim:verify-timeout-recovery -- \
  --report .local/ros/timeout-recovery-report.json \
  --run-id <该次报告的 run_id>

npm run release:runtime-evidence -- \
  --ros-timeout-report .local/ros/timeout-recovery-report.json \
  --ros-timeout-run-id <该次报告的 run_id>
```

新增的发布阻断码为 `GAZEBO_NAV2_TIMEOUT_RECOVERY_RUNTIME`，与 R57 模拟故障、R58 真实取消、R55 三段路线分别验证。单项通过不会解除其他独立阻断；即使全部报告满足结构验证，`release_approved=false`、`physical_safety_certified=false` 仍保留。

## GitHub Actions

原 `ROS Gazebo Nav2 Acceptance (manual)` Workflow 保持 `workflow_dispatch` 和 `vars.ALEX_SIM_RUNNER_APPROVED` 门槛，必须在专用 self-hosted `alex-ros-sim` 上运行。R59 增加第三段独立会话，按顺序先三段路线，再取消、最后超时恢复，并始终保存可用报告和诊断材料。

普通 PR CI 仅能运行脚本语法/结构校验及故障数据拒绝测试，**不会实际启动 Gazebo/Nav2**。

## 未涵盖的故障与认证

本轮没有主动崩溃 Nav2 Server、干扰 DDS 网络、破坏地图、制造传感器故障或模拟真实物理障碍紧急制动。专用 Gazebo 的人工审批、完整运行日志、run ID 与相应 CI/Runner 关联仍需真实执行后核对，报告 JSON 本身不具备不可伪造性。

在任何情况下，不以 R59 作为实体机器人安全认证或量产放行依据。
