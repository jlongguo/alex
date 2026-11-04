# Alex R6 主线更新（2026-11-05）

R6 PR #41 从已包含 R5 源码的最新 main 开发：[短音频 Provider、云端 ASR/TTS、媒体传输与家长权限](AI_COMPANION_R6_AUDIO.md)。完成 typed HTTPS adapter、独立 cloudAudioInputAllowed/cloudAudioOutputAllowed 授权、默认禁止的旧配置迁移、音频二进制接口、请求限流与终止、浏览器主动录音/播放及配套回归测试。外部供应商由 CI fixture 截获，不表示已现场调用真实儿童语音供应商。

下一阶段 R7：真正的流式音频 / VAD / 双向实时协议、可评估的音频延迟和声学质量；随后是多学习者加密事务数据库、预算配额、数据保留/删除和家庭产品 UX。导航仿真继续作为可选支线，不得阻塞 AI 终端主线。

---

# Alex R5 主线进度（2026-11-04）

R5 的实际编码包括：[逐人隐私授权与真实浏览器 Web Speech 规范](AI_COMPANION_R5_VOICE_PRIVACY.md)。PR #40 基于尚未合并的 R4 PR #39。家长管理每个孩子的云模型、麦克风、朗读开关；有明确的服务端授权和模型回合复核、受控提示偏好、浏览器语音打断与人工提交、角色隔离及隐私清理。离线 Skill 不因云模型未授权而被禁用。

这些是**可执行的浏览器语音能力**，不等于自建实时流式 ASR/TTS、VAD、低延迟全双工和音素发音评测。R6 需要真正的可拔插服务端音频 Provider、音频队列、安全传输、持久数据库/加密、模型供应商现场验收和真实家庭体验。ROS2/Gazebo 机器人路线仍为可选子系统。

---

# AI Companion R4 主线迭代（2026-11-04）

PR #39：版本化课程及不同 Skill（英语/故事/科学）、家长学习目标、与聊天快照原子提交的独立文字完成事件、R3 迁移/有界保留/明确清除，真实 HTTP 两名孩子的交互与隐私验证。详情：[R4 验收基线](AI_COMPANION_R4_CURRICULUM.md)。

主线剩余：**R5 真正实时语音和多模态交互**、儿童个性化课程和目标跟踪、**R6 事务数据库/备份/合规安全部署**、第三方模型与浏览器的现场验收。实体运动机器人是可选后端，不能当作 AI 终端功能的交付证据。当前 R4 的完成仅指代码与 CI，非实际儿童教学效果。

---

# AI Companion R3 主线更新（2026-11-04）

独立学习者专属登录（家长配置 PIN、服务端绑定 profileId、撤销与删除）、按人隔离的聊天及文字学习记录、虚拟设备 v3 呈现回执与终端打断状态机已经进入 PR #38。新文档：[R3 需求及验收](AI_COMPANION_R3_IDENTITY_TERMINAL.md)。

下一批优先：R4 实际学习 Skill（课程资源/能力记录/家长计划）、R5 可靠音频流与儿童隐私设置、R6 持久数据库与生产化协议；真实语音/摄像头/硬件不应被本轮模拟回执混淆。

---

# 主线更新：2026-11-04

Alex 产品目标是 **通用、可扩展的儿童/家庭 AI 智能终端**，不等于英语陪读机或专用导航机器人。软件虚拟设备优先，实体硬件后置。主线改为 AI Brain → 语音/显示终端 → 可用 Skill → 家庭资料与隐私 → 平台稳定化。

新增可执行工作：[AI Companion MVP](AI_COMPANION_MVP.md)。PR #36 为多轮会话、互动文字 Skill 和隐私基础；PR #37 在其上增加流式模型对话、取消、虚拟终端状态以及真实文字步骤完成事件。二者仍需真正的浏览器和模型现场验收；ROS2 三段导航属独立可选分支。

后续主线重点：R3 可靠音频流/打断和真实设备呈现，R4 可量化教学内容及多类 Skill，R5 每个儿童独立身份及长期档案，R6 事务数据库、安全部署与真实家庭验收。

---

# Current v0.13 status (2026-11-03)

- **Launch-time crash fixed** (`nav2_bringup` path), Launch function executed under ROS API stubs, headless GPU LiDAR mode added.
- Acceptance reports fail closed: old `passed` is cleared at start, and only an actual three-leg ROS run may mark `passed`.
- Offline suite passes **98 tests**, including report integrity and semantics. **ROS 2/Gazebo/Nav2 runtime remains unverified** because required simulators are absent locally.
- Next: manual simulation-only ROS runner -> obtain real log and TF/scan/odom/goal evidence -> fix any observed integration defects; do not widen physical features until accepted.

# Current v0.12 status (2026-11-03)

- **Code complete, live ROS/Gazebo acceptance unverified.** Strict Jazzy Nav2 parameter generator, ROS-independent goal/TF evidence validators, optional multi-leg real Nav2 smoke, preflight and report files added. See `docs/V0.12.md`.
- v0.12 normal Node tests and sim static checks do **not** validate physics or real ROS 2 middleware. Next action: execute `npm run sim:accept` on Ubuntu 24.04 + Jazzy/Harmonic and fix observed runtime failures before expanding robot hardware features.

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

## v0.11 implemented: reproducible Gazebo assets (static verification only)
- A generated household Gazebo world and Nav2 occupancy map share the canonical TS grid.
- Differential-drive Gazebo model, ROS URDF/TF, simulated lidar/odometry, topic bridge and Jazzy/Nav2 bringup scaffold.
- Opt-in ROS integration smoke suite requiring an installed ROS 2 Jazzy/Gazebo/Nav2 system, plus offline asset tests.
- Pending: **actual** ROS 2/Gazebo/Nav2 execution, SLAM, validated navigation traces, safe hardware controller.


## v0.14 · ROS runtime acceptance reliability (offline verified)

- Share the sourced ROS workspace between Nav2 server and independent acceptance client.
- Validate a per-attempt run ID and preserve fail-closed reporting; emit read-only diagnostics as CI artifacts.
- Test overlay environment propagation using isolated shell and ROS stubs. Real Gazebo navigation still needs an approved Ubuntu runner.
