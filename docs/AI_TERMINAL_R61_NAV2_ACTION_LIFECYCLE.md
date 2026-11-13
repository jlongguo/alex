# Alex R61 — ROS2/Nav2 Action 子进程故障边界加固

## 基线与根因

R60 已合并到 `main`。审阅真实 `robotics/ros2/nav2_action_client.py` 发现三类具体风险：

- `send_goal_async()` 可能永久不返回；原代码会无界等待，且收到取消时仍继续等待；
- 取消已经发出时原客户端只等待某个时限，没有要求 `CancelGoal.Response` 成功，亦没有强制确认 Nav2 最终状态为 `STATUS_CANCELED`；
- 目标取消与成功终态可能竞争，原客户端可能把已取消的目标当作普通成功结束；此外部分失败终态曾返回进程退出码 0。

因此 R61 精准修改 Python Action 客户端，不创建另一个 ROS 控制器、不修改 GPIO/Twist/设备驱动。

## 生命周期与失败语义

| 阶段 | 故障或边界 | 结果 |
| --- | --- | --- |
| /clock | 8 秒没有模拟时钟 | `SIMULATION_CLOCK_MISSING` |
| Action server | 8 秒未就绪 | `NAV2_ACTION_UNAVAILABLE` |
| 目标提交 | 8 秒内未收到是否接受的响应 | `NAV2_GOAL_SUBMISSION_UNCONFIRMED`，不声称已取消 |
| 提交之前取消 | 未实际发送目标 | `cancelled/NAV2_CANCEL_BEFORE_GOAL` |
| 目标接受后取消 | Cancel ACK 拒绝/缺失 | `NAV2_CANCEL_NOT_ACKNOWLEDGED` 或 `NAV2_CANCEL_UNCONFIRMED` |
| 取消与终态竞争 | 终态不为 `CANCELED` | `NAV2_CANCEL_TERMINAL_NOT_CANCELED` |
| Action 无终态 | 75 秒强制请求取消 | 结果只能失败，不能伪造成功 |
| ROS 断联 | 不再产生有效终态 | `NAV2_DISCONNECTED` |
| Action Abort | 真实失败 | `NAV2_ACTION_FAILED`，非 0 退出码 |

取消确认不构成物理急停证据；脚本既不传输电机指令，也不保证 Nav2 服务器在客户端死去时已经停止运行。因此**目标提交状态未知**被定为独立失败码，而不是 `cancelled`。

直接调用 Python 也必须要求 ROS Jazzy、`ALEX_ROS_SIMULATION_ONLY=1`、`ROS_DOMAIN_ID=77`、`ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST`。阻断非隔离 DDS 域，避免调试脚本误连接其他机器人。

## 离线测试

```bash
npm test
```

新增 `tests/fixtures/mock-ros2-nav2-action.py` 以标准库模拟 `rclpy`、`NavigateToPose` 与真实 Action future 状态变换；测试运行**实际 Action 客户端源码**，而不是复制被测算法。包括拒绝目标、接受请求挂起、父进程提前取消、取消 ACK 拒绝或永不返回、取消先于 ACK 得到终态、动作成功与取消竞争、超时后取消、ROS 停止等情形。

这个 fixture 仅模拟 ROS Python API，不使用 DDS，不会让节点接入模拟器或实体机器人。它只能验证 Python 客户端状态机和终态码；不能证明真实 `rclpy`、Nav2、Gazebo 的行为一致。

## 现有独立运行时验收不变

原三段真实 Gazebo 路线、取消停止、同会话恢复以及 R60 Workflow Bundle 仍使用各自独立证据门槛。R61 不以离线 Action 测试替代任何真实运行时验收，也不解除 `PHYSICAL_SAFETY_REVIEW`。

后续若要提高 ROS 真实运行可信度，应在获批准的隔离 Gazebo Runner 中测试 Nav2 行为异常，并附 Github Actions 执行记录、运行 ID、失败/恢复证据和具体日志。不得在自托管机器上直接终止未知 ROS 服务、向共享域注入故障或使用真实运动硬件。
