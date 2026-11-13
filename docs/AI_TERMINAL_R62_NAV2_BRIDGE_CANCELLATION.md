# Alex R62 — Nav2 Node 桥取消完整性与未知停止隔离

## 本轮根据实际代码定位的三个缺陷

当前 `scripts/ros2-navigation.mjs` 使用子进程运行 R61 已加固的 Python `nav2_action_client.py`。审阅两端的 JSONL 协议和 `virtual-device` 的调用后，发现：

1. Node 桥接器在用户请求取消但始终没有 Nav2 确认时，可能返回 `cancelled`，容易让上层误以为已经停止；
2. Node 的取消等待默认 **2 秒**，Python R61 最长允许取消确认等待 **3 秒**，可能过早结束 Python 客户端；
3. 取消无法确认时，Node 桥实例原先立即允许下一次 `navigate()`，而旧目标可能仍在 Gazebo Nav2 Action 服务器运行。

R62 直接修复该桥接器、扩展已有伪 Nav2 客户端、调整 R57 伪故障契约的隔离方式，并增加子进程行为回归测试。没有修改电机、GPIO、Twist 或生产网络。

## 结果分类

| 实际证据 | 对上层返回 | 同实例是否允许再次导航 |
| --- | --- | --- |
| 用户主动取消；Python 已确认取消并返回 `cancelled` | `cancelled` | 允许 |
| 目标超过 Node 目标等待时限；Python 随后确认取消 | `failed / NAV2_GOAL_TIMEOUT_CANCELLED` | 允许；不能计为用户主动取消 |
| 用户主动取消后，仍返回 Nav2 `SUCCEEDED` | `failed / NAV2_COMPLETED_AFTER_CANCELLATION` | **禁止** |
| 用户取消后没有 ACK 或终态，超过 Grace | `failed / NAV2_CANCEL_UNCONFIRMED` | **禁止** |
| Python 返回取消 ACK 拒绝或取消终态不符 | `failed`，保留固定故障码 | **禁止** |
| 目标提交状态未知、协议损坏、子进程异常退出 | `failed` | **禁止** |
| Action 明确拒绝目标 | `failed / rejected` | 允许 |
| Action 返回确认成功且最后位置反馈满足既有目标阈值 | `arrived` | 允许 |

**禁止**意味着：`Nav2SimulationBridge.stopUnconfirmed=true`，后续 `navigate()` 直接抛出 `NAV2_STOP_UNCONFIRMED`。没有提供无验证的一键清除方法。这个机制仅约束当前桥对象；**重新实例化桥对象不能证明 ROS 服务器上的旧目标已停止**，因此必须由额外的隔离环境验收或人工审核证明旧目标终态后才能在真实仿真运行中重新接入。

Node 的默认 `cancelGraceMs` 更新为 **5000 ms**，给 Python 最长 **3000 ms** 的 ACK/终态检查留出 IPC 及调度余量。Python 的取消 ACK 和 `STATUS_CANCELED` 严格检查保持 R61 原有实现。

## 回归验证

```bash
npm test
npm run sim:fault-contract
```

`tests/r62-nav2-bridge-cancel-integrity.test.mjs` 直接运行内置 JSONL 子进程，覆盖：用户取消确认与未确认、超时确认与未确认、取消后成功、取消 ACK 拒绝、终态不一致、重复导航阻断、正常目标拒绝、错误终态和后续隔离的模拟恢复。测试不启动 `rclpy`、不连接 ROS DDS，也不代表真实 Gazebo 已通过。

R57 的 `injected-subprocess` 故障契约仍维持原格式、原四种场景与严格验证器，但**每个场景使用独立模拟桥实例**。这是为了在“取消状态未知”后不复用前一个对象；由于所有目标都是隔离的伪子进程，不代表可以在实际机器人上靠重新启动桥进程清除故障。

## 尚需真实验收

目前真实 Gazebo/Nav2 的三段路线、取消、取消后恢复仍分别由 R58–R60 的手动自托管 Runner 验收。R62 增强的是产品 Node 桥与 Python 子进程之间的**安全状态解释**，不能替代这些运行证据。

特别是 `stopUnconfirmed` 仅阻断**新命令提交**，它不是 `cmd_vel` 急停、Nav2 目标强制取消成功的证明，更不是实体机器人的安全认证。现场出现不确定终态时，必须使用独立验证/运维隔离流程处理。
