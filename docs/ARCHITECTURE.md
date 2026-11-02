# Home Agent OS — 冻结架构 v0.1

## 边界

1. **Home Core**：设备清单、任务生命周期、权限和事件。它不决定电机速度，也不包含任何机器人固件。
2. **Agent Brain**：将自然语言转换为能力调用的意图；本批只有明确标记的确定性规则解析器，后续通过 Provider 接口接入 LLM，所有命令必须经过 Policy。
3. **Skill Runtime**：技能描述、授权和调用；Skill 无权直接写机器人电机状态，物理动作只能通过受控能力执行。
4. **Device Protocol**：将动作表达为 `capability + params + actor`，独立于模拟器与真实固件。当前版本采用本地 HTTP；扩展真实设备时增加双向认证、设备证书与独立事件传输。
5. **Robot Runtime**：独立实现状态、定位、导航计划、执行回报；本批是离散网格的确定性模拟器，非实体 SLAM。
6. **Safety Controller**：永久保持独立于 Agent；当前只有仿真急停/障碍逻辑。硬件版本必须由机器人本地单独实现。

## 端到端任务链

```text
User → /api/command → parseIntent → PolicyEngine
     → HomeCore.navigate → SimulatedRobot.navigate (A*)
     → HomeCore.tick → task status / HomeEvent
     → /api/state + SSE → Web Console
```

## 最小领域模型

- `DeviceDescriptor`：设备 ID、在线状态、能力集合。
- `RobotState`：位姿、电量、移动状态、障碍开关、急停锁存。
- `RobotTask`：任务 ID、能力、目标、角色、状态、进度、原因。
- `HomeEvent`：序列号、时间、类型和事件载荷。
- `SkillDescriptor`：技能 ID、能力需求及允许调用的角色。

## 技术决策

- **Node 内置 HTTP + SSE**：零运行时 npm 依赖、方便测试；这不是最终公网设备网关方案。
- **A* 路径规划**：方便验证规划与执行分离；未来 ROS 2 Nav2 适配器代替它。
- **确定性 Agent**：在没有密钥或模型服务时，保证端到端闭环可重复测试，不伪造真实 AI 能力。
- **无持久化**：本批仅验证状态机和接口，重启清零。下批再增加 SQLite/ PostgreSQL 事件与设备存储。
- **权限仅模拟**：`actor` 来自客户端，无法证明用户身份。上线前必须实现认证、授权和配对。
