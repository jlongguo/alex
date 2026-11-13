# Alex R59 — 独立 Gazebo 中 Nav2 取消后恢复与返回充电位

## 验收目标与范围

R59 不引入平行导航系统，不通过停掉真实 Nav2 服务器模拟故障，也不访问物理设备。它复用 R58 的 **真实 NavigateToPose Action 取消、确认与停止窗口** 和既有 `run_goal` 的导航成功、里程与 fresh TF 检查，在**同一 Gazebo 会话、同一 ROS Node、同一 Nav2 ActionClient** 下执行以下有序步骤：

1. 验证 ROS 图、时钟、地图、TF、激光与 Nav2 生命周期 ACTIVE；
2. 向书桌提交 Nav2 目标，成功接受后取消；
3. 收到明确取消 ACK 与 `STATUS_CANCELED`，再通过 odom、TF 与 cmd_vel 观测确认已停止；
4. 重新向书桌发起 NavigateToPose，要求独立位置误差≤0.12m、有效反馈、里程≥0.4m；
5. 继续导航返回 `dock`，再次满足相同阈值后才写 `passed`。

即使 R58 单次取消和原三段路线分别都通过，也不能证明真实系统能够在取消之后立即重新导航，因此 R59 采用**同会话**的独立恢复证据。

## 执行环境

仅在获批准的、未连接物理机器人或真实控制网络的 Gazebo Harmonic / ROS Jazzy 自托管模拟节点执行。需显式启用模拟域：

```bash
set -euo pipefail
source /opt/ros/jazzy/setup.bash
export ALEX_ROS_SIMULATION_ONLY=1
export ALEX_RUN_ROS_INTEGRATION=1
export ROS_DOMAIN_ID=77
export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST

npm run sim:accept-recovery
```

复用 `scripts/run-ros-acceptance.sh`，其中 `ALEX_ROS_ACCEPTANCE_MODE=recover-probe` 对应独立报告、日志与预检；每次运行在预检前将旧成功报告覆盖为 `blocked`。测试失败会留下当前 run ID 的失败证据，进程组退出时关闭 Gazebo 子进程。

成功报告：`.local/ros/recovery-acceptance-report.json`

启动日志：`.local/ros/recovery-acceptance-launch.log`

## 校验证据

```bash
npm run sim:verify-recovery-report -- \
  --report .local/ros/recovery-acceptance-report.json \
  --run-id <本次恢复验收报告的 run_id>

npm run release:runtime-evidence -- \
  --ros-recovery-report .local/ros/recovery-acceptance-report.json \
  --ros-recovery-run-id <本次恢复验收报告的 run_id>
```

验证器强制独立 schema `alex.dev/ros-recovery-acceptance/v1`、独立 mode `recover-probe`、明确模拟环境与安全声明、相同 run ID、R58 的取消 ACK/终态/停车窗口、两段正确顺序的恢复目标、回到 dock，以及原三段路线的相同误差与里程阈值。任何缺失均 fail-closed。

运行时 Gate 新增 `GAZEBO_NAV2_RECOVERY_RUNTIME`。该门槛与 `GAZEBO_NAV2_THREE_LEG_RUNTIME`、`GAZEBO_NAV2_CANCEL_RUNTIME` 独立，不能互相抵扣。所有证据完成后，仍保留物理安全审批和真实 ASR/LLM/TTS 语音供应商验收。

## 手动 Workflow

`ROS Gazebo Nav2 Acceptance (manual)` 需经 `vars.ALEX_SIM_RUNNER_APPROVED=true` 授权，在隔离 `alex-ros-sim` 自托管 Runner 执行。顺序为：三段路线 → 单次取消 → **取消后恢复并回 dock**，三个场景均使用新进程组、新 Gazebo 会话与独立报告。失败也会上传现存的结构化证据与诊断文件。

默认 PR CI 只会运行脚本语法、证据结构校验及无授权 fail-closed 测试，不执行真实 Gazebo。**实际运行证明必须结合可信 GitHub Actions Runner 的执行记录和报告 run ID**。自行拼接的 JSON 即使结构合法，也不能视作真实执行证据。

## 继续保留的风险

- R59 覆盖的是“已被接受的目标取消后，重新导航”的恢复链路；真实服务崩溃、Nav2 生命周期异常、拒绝目标、DDS 网络中断仍需不同的受控故障策略，不能声称已通过；
- TF/odom 与命令速度的观察窗口只是仿真行为证据，**不是机器人紧急停止、碰撞避免或物理硬件安全认证**；
- 真正的可交付状态应以经过审核的 ROS 真实运行报告、真实语音提供商链路、物理安全检查和人工发布批准为前提。
