# Alex R58 — Gazebo/Nav2 真实取消与停止后观测验收

## 设计边界

从 R57 已合并的 `main` 扩展既有 ROS Jazzy + Gazebo Harmonic 验收路径，复用已有图检查、Nav2 生命周期门槛、TF/odometry 观测与独立 ROS Domain 77。没有创建第二套导航控制器，也不触碰 GPIO、电机驱动、真实设备或用户账户。

R58 与 R57 的证据不可互换：

| 证据 | 执行环境 | 能证明什么 |
| --- | --- | --- |
| `sim:fault-contract` | Node 子进程，伪 Nav2 peer | R57 拒绝、取消、超时与恢复的桥接器契约 |
| `sim:accept` | 真实 Gazebo + Nav2 | 三段路线及 TF/里程计达标（原有验收） |
| `sim:accept-cancel` | 真实 Gazebo + Nav2 | **新增加**取消 ACK、终态 `CANCELED` 以及停止后的观测窗口 |

## 执行入口

仅在**不连接物理机器人**、已安装 ROS 2 Jazzy / Nav2 / Gazebo Harmonic 的专用模拟机执行：

```bash
set -euo pipefail
source /opt/ros/jazzy/setup.bash
export ALEX_ROS_SIMULATION_ONLY=1
export ALEX_RUN_ROS_INTEGRATION=1
export ROS_DOMAIN_ID=77
export ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST

npm run sim:accept
npm run sim:accept-cancel
```

取消探针先确认 TF、地图、激光、odom 和 `/bt_navigator` ACTIVE；在初始位置向 `study_desk` 提交一次 Nav2 NavigateToPose 目标，并在目标被接受后调用 `cancel_goal_async()`。只有实际取消响应包含目标且 Action 返回 `STATUS_CANCELED` 才能继续。

随后等待 0.4 秒让速度消息退场，在 1.5 秒观察窗口中要求：
- TF 仍有效；
- odom 时间戳前进且模拟时钟继续前进；
- TF 位移不超过 **0.08 米**；
- 已订阅的 `/cmd_vel_nav`、`/cmd_vel_smoothed`、`/cmd_vel` 无新的非零指令。

检测不通过，验收即失败。**这是 Gazebo 模拟的取消与停止证据，不是实体机器人的急停认证。** 若某些 Nav2 版本采用未桥接到上述话题的命令链路，仍需额外检查真实轮速/传感器，不能依赖本报告宣称安全。

## 证据与运行时门槛

取消成功报告默认位于 `.local/ros/cancel-acceptance-report.json`，独立于原三段导航报告；过程日志为 `.local/ros/cancel-acceptance-launch.log`。旧 PASS 会在本次预检前写回 `blocked`，启动错误不会复用旧证据。

```bash
npm run sim:verify-cancel-report -- \
  --report .local/ros/cancel-acceptance-report.json \
  --run-id <本次 cancel-report 的 run_id>

npm run release:runtime-evidence -- \
  --ros-report .local/ros/acceptance-report.json \
  --ros-run-id <本次 route-report 的 run_id> \
  --ros-cancel-report .local/ros/cancel-acceptance-report.json \
  --ros-cancel-run-id <本次 cancel-report 的 run_id>
```

新门槛 `GAZEBO_NAV2_CANCEL_RUNTIME` 与原 `GAZEBO_NAV2_THREE_LEG_RUNTIME` 完全独立；伪 Nav2 peer 测试通过不解除任何一项。报告包含明确的 `simulation_only=true`、`release_approved=false` 和 `physical_safety_certified=false`。

## GitHub Actions 运行方式

既有 `ROS Gazebo Nav2 Acceptance (manual)` Workflow 仅能由批准的 `alex-ros-sim` 自托管 Runner 手动触发，新增一段独立的真实取消验收，按步骤先通过三段导航再启动新的 Gazebo 会话做取消探针。无可用 Runner 或失败时仅上传可用报告与日志，**不会将未运行流程标记为已验证**。

普通 PR CI 只运行结构验证、预检、脚本语法和伪证据拒绝回归；不会在默认 GitHub Runner 上执行真实 Gazebo/ROS。要得到真实运行验收结论，必须查看手动 Workflow 的实际结果与对应 run ID。

## R58 未覆盖

此轮未对真实 Nav2 强制制造 Goal Rejection、服务器崩溃、ROS 网络分区或取消永久无响应；这几类故障仍由 R57 伪进程契约覆盖，不能宣称 ROS 运行时也已验证。真实麦克风、实体机器人停止和物理安全审核仍需单独验收。

JSON 验证器只能证明报告字段一致性，无法单凭自报 JSON 对执行环境做密码学证明；可信运行来源应同时使用批准的 Runner、GitHub Actions run 和生成时的日志/报告进行审核。
