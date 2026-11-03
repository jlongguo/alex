# 后续迭代计划

## 当前批次已交付（v0.1）

- P0: 设备与任务契约、简化安全规则与能力注册
- P1: 确定性 Agent 意图解析、三个占位技能
- P2: 2D 家庭地图、A* 路径规划、模拟运动和任务状态
- P3: Home Core ↔ Robot Simulator ↔ Web UI 完整演示链路

*P1 的真实多模型 Agent / 语音并未完成；P3 的 ROS2 桥接也未完成。上述完成度仅代表可运行的竖向切片，不是全阶段最终闭环。*

## 下批（v0.2）

1. 安全优先：本地家庭账户、会话授权、设备身份、输入 Schema 校验、操作审计。
2. 抽象 `AgentProvider`（Mock / LLM Adapter），将非确定性意图转换为受 Policy 保护的结构化工具调用。
3. 改造 TaskEngine，增加超时、幂等键、取消竞争控制、事件持久化和恢复。
4. Skill SDK：能力声明、版本、许可、生命周期、受限工具上下文。
5. 家庭中枢设备适配器：先使用可模拟的本地传感器，再选择性连接 Home Assistant API。

## 后续（v0.3+）

- 音频输入输出、ASR/TTS、表情动作、明确的儿童权限与家长同意。
- Webots / Gazebo 的机器人 URDF/SDF 模型、ROS 2 Navigation bridge。
- 实体运动必须以独立本地安全控制为前提。
- 英语陪读、故事、家庭提醒等 Skill 扩展为真实应用。


## v0.2 本轮实现（2026-11）

- 可替换 AgentProvider：规则默认 + 显式配置的兼容接口；真实远端未做现场验收。
- 模型提议需严格结构校验并通过原始策略，不允许模型自行授权动作。
- 受信任 Skill 插件声明版本、启用状态、角色及硬件能力。
- 导航幂等、任务超时、事件/任务原子快照持久化、异常重启不自动续跑。
- 本地 22 项测试通过，包括 HTTP 重启恢复。见 `docs/V0.2.md`。

## v0.3 最高优先级

1. 真正的本地家长账户认证、权限与审计；严禁把前端传来的 `actor` 当作真实身份。
2. Device pairing 和证书/令牌管理；仍不接物理移动电机。
3. 长期用户记忆数据模型与数据删除控制；如涉及儿童需设计监护人管理与默认最小留存。
4. Agent tool-call 审批/可观测性，以及真实模型服务联调。
5. 可插拔 SQLite/PostgreSQL 事务持久化替换 JSON 快照。

## v0.3 completed (local prototype)
- Opt-in local parent/child login, HTTP session cookie, actor binding and login lockout.
- Manual scoped family memory, metadata-only audit and browser login.
- Device identity, physical safety, remote HTTPS and production-grade privacy remain future work.


## v0.5 — Virtual Device Gateway (2026-11-03)
- Independent paired virtual devices, parent-approved capabilities, bearer-authenticated SSE/poll inbox, feedback and durable task state.
- Agent virtual task route, multi-device simulator CLI and Console inspection.
- Follow-on: a reliable real LAN device protocol, profile-scoped memory, transaction-safe storage, robot safety controller and ROS 2 simulation bridge. No real motion control yet.

### v0.6 — virtual workflow orchestration (implemented)

- Added an allowlisted, durable parent-only workflow coordinator combining virtual navigation, trusted hub skill, and virtual audio output.
- Added deterministic composite command parsing, device capability matching, idempotency, cancellation and restart safety, simulated multi-stage integration tests.
- Real conversational AI, safe ROS bridges and child-restricted delegated motion remain explicitly **not implemented**.


## v0.7 — allowlisted planning and durable plan events (implemented)
- DAG validation, dependency-gated navigation/skill/audio, parent-only plan APIs and local console.
- Device reservation across v0.6 workflows and new plans, idempotency, cancellation, timeout, no replay after restart.
- Bounded monotonic event journal and restart audit trail. Not a free-form LLM planner; no physical device control.

## Proposed v0.8
- Formal typed model plan proposals with explicit plan review and parent approval, not untrusted tool execution.
- Better per-person skill/memory isolation and auditable household event permissions.
- Webots/ROS 2 bridge adapter behind a capability safety gate, simulation only.

## v0.8 implemented (software-only)
- Inert child/parent AI plan proposal with a rules classifier by default, optional explicit HTTPS compatible model adapter.
- Time-limited drafts, role-bound parent approval/rejection, fail-closed dispatch through v0.7 plan engine and restart-safe no-replay state.
- Proposal and plan correlation timeline, protected HTTP APIs and parent console review UI.
- No arbitrary generated DAGs, no direct motor control or real model vendor verification.

## v0.9 implemented (2026-11-03)
- Real A* path stepping **inside the simulated grid** for paired virtual robot clients, with authenticated protocol-v2 pose/progress feedback.
- Strict goal arrival validation, cancellation/permission/duplicate navigation safeguards, durable progress snapshot and parent-only map view.
- Not implemented: ROS 2, Nav2, Gazebo, motor controller, physical collision avoidance, SLAM, LiDAR or robot hardware tests.

## Proposed v0.10
- Extract ROS/Nav2 goal adapter interface separately from simulator, with capability-gated simulated goal/action states.
- End-to-end correlation of plan step/job ID/pose feedback, bounded event timeline and replay-safe device lifecycle.
- Family-specific profile identities and per-profile learning privacy, plus actual cloud LLM provider integration testing.

## v0.10

- Experimental ROS 2 Nav2 ActionClient bridge to the existing virtual device protocol; Gazebo-only, opt-in.
- Goal conversion and pose/feedback/cancel handling with guarded failure semantics.
- Next: add a matching URDF/Gazebo world and run real Nav2 integration tests.
