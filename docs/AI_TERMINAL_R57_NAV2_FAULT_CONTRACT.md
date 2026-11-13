# Alex R57 — Nav2 异常生命周期与独立故障契约证据

## 现有架构复用

R56 已合并到 `main`。R57 不创建平行导航控制器，复用原有 `Nav2SimulationBridge`、`tests/fixtures/fake-nav2-client.mjs`、R55/R56 只读发布验收门槛。

## 可重复执行

```bash
npm run sim:fault-contract -- --report .local/ros/nav2-fault-contract.json
```

测试使用本地 Node 子进程模拟 Nav2 Action JSONL peer，不连接 ROS Domain，不发布 Twist，不访问真实 Gazebo，也不会控制物理机器人。

本轮强制验证以下阶段：

1. 目标被拒绝：桥接器返回 `failed/rejected`，不会把拒绝目标解释为到达。
2. 用户取消：伪服务在目标发起后确认取消，桥接器返回 `cancelled`。
3. 超时后取消无确认：伪服务刻意忽略取消，桥接器有界返回 `failed/NAV2_CANCEL_UNCONFIRMED`。
4. 故障后恢复：同一桥接器实例重新发起合规目标，必须返回 `arrived`；每一步都必须释放活动状态。

输出报告包含状态码、耗时、活动状态；不记录命令行、环境变量、凭据或子进程 stdout/stderr。

## 验证证据和发布边界

```bash
npm run sim:verify-fault-contract -- \
  --report .local/ros/nav2-fault-contract.json \
  --run-id <报告里的 run_id>

npm run release:runtime-evidence -- \
  --nav2-fault-report .local/ros/nav2-fault-contract.json \
  --nav2-fault-run-id <报告里的 run_id>
```

`verify-nav2-fault-contract.mjs` 检查精确 run ID、四种异常/恢复结果和显式 `source=injected-subprocess` / `ros_runtime_verified=false` / `release_approved=false`。运行时 Gate 只会将 `nav2_fault_contract` 标记为 `verified-injected`；**无论此报告是否通过，均不得移除 `GAZEBO_NAV2_THREE_LEG_RUNTIME`**。

## 尚未完成的真实运行验收

当前仅验证桥接器与伪 peer 的确定性异常处理；真实 ROS2 Jazzy / Gazebo Harmonic 仍必须在独立隔离机器执行 `sim:accept`，并通过 `verify-ros-report.py` 校验三段导航时钟、TF 和目标姿态。

真实 Nav2 的拒绝/取消/超时专项运行验收尚未在 Gazebo 中执行，也不能由这个子进程契约矩阵代替。物理硬件安全未认证。
