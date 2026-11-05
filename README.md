# Alex — 软件优先的通用 AI 家庭智能终端与虚拟设备平台

> AI Companion 主线开发（2026-11-04）：新会话 API、可选真实模型多轮文字聊天、A1 互动英语、分支故事、家庭隐私和浏览器可选语音入口。详情见 [AI Companion MVP](docs/AI_COMPANION_MVP.md)。机器人 ROS2/Gazebo 是可选后端，三段导航仍需真实验证；不能据此推断语音/AI 已验收。

## AI Companion R9 · 流式朗读、PCM16 播放队列与用户主动插话（Draft PR #45）

- R9 新增一个与 R8 实时 ASR **独立的可选下行流式 TTS Provider**。服务器以 HTTPS 按需读取供应商裸 PCM16/24kHz 音频，并由用户授权的 WebAudio 逐片安排播放，原 R6 MP3 朗读保留作为回退。
- 最大 3 段未 ACK 音频、浏览器最多预排程 2 段、每段最大 100ms；播放回调的 ACK 只代表**客户端宣称播放完毕**，不能验证扬声器真实发声或儿童听到了。服务端拒绝重放序号、跨孩子访问和无授权领取。
- “停止播放”“开始麦克风”“打断朗读并开始语音输入”都要求显式用户操作。身份切换、家长撤销合成权限或隐私擦除会终止流式语音。
- [R9 交付协议与验收](docs/AI_COMPANION_R9_STREAMING_SPEECH.md)。**尚不是全双工实时 AI 对话**，不进行自动录音和自动发消息，不依赖真实机器人。

## AI Companion R8 · 上游实时转写 WSS 与 PCM24k AudioWorklet（Draft PR #44）

- **不同于 R7**：浏览器现在可在主动录音时，把原始 PCM16/24k 小帧交给 Alex，再由服务端 WSS 持续发送给配置的实时转写供应商，并在用户讲话时获得增量文字预览。
- 浏览器麦克风需要用户明确点击；儿童需要已验证的独立身份及家长对浏览器语音和云端录音的分别授权，服务器逐帧校验权限。最终识别文字必须再由用户确认发送，不会自动执行 Agent 工具、导航或设备命令。
- 原 R6/R7 WebM 短录音和批量 ASR 保留；R8 PCM 流是单独接口及可选 Provider，**默认 disabled**，不与 WebM/Opus 混用。
- WSS 连接包含 TLS 握手、mask、消息大小限制、背压、会话取消；内存中的临时音频与转写信息不自动落盘，家长撤销与隐私擦除清理对应记录。
- [R8 实时转写架构、数据上限及验收](docs/AI_COMPANION_R8_REALTIME_TRANSCRIPTION.md)。目前**不是**全双工 AI 语音回复或生产级儿童音频合规，真实模型质量需现场测试。

## AI Companion R7 · 增量音频入口与静音停录（Draft PR #43）

- 浏览器主动录音时可按序发送小音频片段到 Alex，本地服务器校验登录身份、音频授权、连续序号、总字节数、并发和过期；ASR Provider **仍在 finish 后批量转写**，暂未完成真正上游流式语音。
- 新增可选的本机能量型 VAD：根据音量和静音间隔尝试自动停录或无语音取消；不是机器学习语音检测、说话人识别和发音评分。
- 新增只含字节数、片段数和延迟的非内容指标，音频临时缓冲按结束/取消/超时清理；仍有安全限制和浏览器现场验收缺口。
- [R7 技术协议与验收](docs/AI_COMPANION_R7_INCREMENTAL_AUDIO.md)。R6 原录完再上传模式保留作为回退。

## AI Companion R6 · 后端短音频 ASR/TTS（Draft PR #41）

- 新增真正可配置的 HTTPS ASR/TTS Provider：短音频通过本地 API 认证后上传至家长配置的供应商，语音合成返回 MP3，密钥不传到浏览器。
- 浏览器按需启用 MediaRecorder 录音（最多约 15 秒；服务端只核对**客户端声明**的时长，尚未解码核实）；识别文字不自动发送消息，需再次人工确认。
- 儿童的云端录音和云端朗读各自拥有**默认关闭的独立家长授权**，不会继承 R5 的浏览器 Web Speech 开关；旧版隐私数据会以保守权限迁移。
- 限制音频体积、请求频率、并发任务，支持取消和断连时中止，媒体响应不缓存、不持久存储录音。
- [R6 技术与验收](docs/AI_COMPANION_R6_AUDIO.md)。R6 核心已随 PR #41 进入 main，随后补的审计和测试收口以独立后续 PR 交付。**这不是全双工实时语音或生产级儿童合规方案**。

## AI Companion R5 · 逐人云模型授权与浏览器语音

- 家长对每个独立学习者管理**默认关闭**的浏览器语音输入、朗读和第三方模型文字使用权限。服务端拒绝未经授权的云端文字调用，不只是隐藏浏览器按钮。
- 不授权云模型时，英语、故事、科学等固定规则离线 Skill 仍可使用；自由聊天因为没有离线通用模型而保持禁用。
- 新增真实浏览器 Web Speech 桥接器，支持手动语音识别、预览后发送、朗读分段、停止和打断；声学识别可能调用浏览器厂商服务，**不是自行部署的实时 ASR/TTS**。
- 家长可设置受控枚举的语言、学习节奏、兴趣；云模型只获得获准学习者的最小偏好，不上传孩子的家长 PIN 或家庭全部记忆。
- [R5 逐人隐私与语音验收](docs/AI_COMPANION_R5_VOICE_PRIVACY.md)；本批 PR #40 叠加尚未合并的 R4 PR #39，仍需实际浏览器和供应商验证。

## AI Companion R4 · 可扩展 Skill 课程与独立学习成果

- **可信、版本化内容**：A1 英语自我介绍/打招呼/日常作息、互动故事和基础科学小问答，全部提供明确的多轮文字输入校验，非 AI 自行生成的教学成绩。
- **家长按孩子分配计划**：指定课程、次数目标、暂停/恢复、删除；课程执行仍走 Skill Registry / PolicyEngine。
- **独立成果台账**：明确完成的文字练习在 16 个聊天会话自动淘汰后仍有有界记录；家长显式删除、隐私擦除和删除学习者会清理相应记录。
- **真实目标进度**：按每个孩子和课程显示已完成次数及目标达成；记录只来自离线固定步骤，不代表语音、学习能力、正式教育成绩。
- [R4 接口、数据保留及验收说明](docs/AI_COMPANION_R4_CURRICULUM.md)。代码在 Draft PR #39，仍需浏览器真实体验验收。

## AI Companion R3 · 独立学习者与虚拟终端 v3

- 家长可为每个学习者档案设置独立 PIN，使用公开登录代码与服务端验证的 learnerId 隔离会话和文字学习记录；共享儿童 PIN 不再能查看其他学习者档案。
- 终端具备可中断的状态机和受 revision 保护的浏览器朗读/听写回调。
- 真实虚拟设备进程升级 v3 模拟呈现协议：表情和文字字幕在成功前需回传匹配任务的认证回执；**不代表真实扬声器播放**。
- 参见 [R3 身份与终端说明](docs/AI_COMPANION_R3_IDENTITY_TERMINAL.md)。本批仍未完成实际儿童体验、实时音频和真实云端模型质量验收。

## AI Companion R2 · 流式与可中断的虚拟终端

- [R2 Streaming Contract](docs/AI_COMPANION_R2_STREAM.md)：流式文字回复、显式中止、完整提交标记和安全的失败回滚。
- 离线英语与故事会在完成明确步骤后保存文字学习标记；只有家长可主动查看儿童身份的摘要。**不是发音评分或学习水平认证**。
- Web 终端可显示生成/听写/朗读状态；浏览器语音能力仍需兼容性验收，可能使用厂商在线语音服务。
- 这批改动在 PR #37 中，叠加于尚未合并的 PR #36；不代表 ROS2 三段导航或真实模型已通过验收。

## Console navigation fix

The four sidebar entries now navigate to real workspace views (overview, devices, skills, events), support hash deep links and browser history, and remain accessible through a four-tab mobile bottom bar. The Devices view explains parent-session requirements instead of silently appearing empty. See [docs/CONSOLE_NAVIGATION.md](docs/CONSOLE_NAVIGATION.md) for details and checks. Navigation never bypasses server permissions.

> **v0.14.0 · shared ROS overlay, acceptance run IDs and diagnostics**
>
> 这是一个可运行的架构验证项目，不是具备真实自主导航或通用 AI 能力的成品。

## v0.14 ROS workspace sharing and acceptance diagnostics

- `scripts/prepare-ros-sim.sh` is now **sourced by both** the acceptance parent and Gazebo/Nav2 launcher. Colcon workspace and Python imports are shared; wrong domain, missing simulation opt-in or mismatched `alex_sim` package path fail closed.
- Each live acceptance run has a unique `run_id`; final verification requires the same ID, preventing accidental reuse of stale `passed` evidence.
- All attempts write `.local/ros/diagnostics.json`, with read-only preflight blockers and bounded log hints. This is not evidence of successful navigation.
- `npm test` includes an offline fake-ROS overlay test plus tampering and blocked-run tests. **Live Gazebo/Nav2 remains unverified here.**
- See [`docs/V0.14.md`](docs/V0.14.md) for the exact acceptance boundary.

## v0.13 ROS startup & acceptance integrity

- Fixes a genuine `nav2_bringup` launch-time NameError and tests the **executed** Launch description offline (not just Python syntax).
- Enables explicit Gazebo EGL headless GPU LiDAR rendering for the live acceptance runner; no ROS runtime is claimed on machines without it.
- Resets stale `passed` evidence on every attempt, writes `blocked`/`failed` for startup errors, and verifies all three legs before reporting acceptance.
- Adds an **opt-in manual** GitHub Actions job for a dedicated ROS/Gazebo simulation-only runner, never automatic PR or push execution.
- Local offline suite: **98 automated tests passed**; real Gazebo/Nav2 integration still not run in this environment.
- See [`docs/V0.13.md`](docs/V0.13.md) for precise requirements and safety limitations.

## v0.12 simulation acceptance (new)

- Adds ROS-free acceptance evidence checks, a strict nested Nav2 parameter generator, and a simulator-only three-leg Nav2 route (dock → desk → story → dock).
- Run `npm test` and `npm run sim:check` anywhere. Run `npm run sim:preflight` to detect missing ROS/Gazebo without pretending simulation succeeded.
- On a dedicated Ubuntu 24.04 ROS 2 Jazzy + Gazebo Harmonic workstation, **explicitly opt in** with `ALEX_ROS_SIMULATION_ONLY=1`, `ALEX_RUN_ROS_INTEGRATION=1`, `ROS_DOMAIN_ID=77`, `ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST`, then `npm run sim:accept`.
- Acceptance produces `.local/ros/acceptance-report.json` and `.local/ros/acceptance-launch.log`. Success requires live `/clock`, LiDAR, odom, map, TF, Nav2 feedback, and independently verified positions and odometry travel for **three goals**.
- The current development/CI environment has **no ROS 2 / Gazebo**; `sim:preflight` reports `blocked` and **no live physics navigation has been verified**.
- See [`docs/V0.12.md`](docs/V0.12.md) for commands, expected evidence and safety limits.

## v0.11 Gazebo + ROS2 simulation package (new)

- Generated Gazebo world + ROS Nav2 occupancy map from the existing shared 60×34 TypeScript household grid, with consistent map origin and named destinations.
- Simulation-only differential-drive robot SDF, robot URDF, lidar, odometry, TF and ROS/Gazebo topic bridges.
- ROS 2 Jazzy `alex_sim` launch package, Nav2/AMCL initial-pose integration and an explicit opt-in live ROS smoke test.
- `npm run sim:check` validates assets without installing ROS. `ALEX_ROS_SIMULATION_ONLY=1 npm run sim:launch` requires an **actual Jazzy + Gazebo environment**.
- **No actual Gazebo/ROS2 execution has been validated in this environment.** See [`docs/V0.11.md`](docs/V0.11.md).

## v0.10 Nav2 simulation bridge

Optional experimental `ALEX_NAV_BACKEND=ros2` adapter for a **matching ROS 2/Nav2 Gazebo simulation only**. The existing grid simulator remains the default. This version provides goal/feedback/cancellation protocol and strict final pose verification, but **has NOT been tested against an installed ROS 2/Nav2/Gazebo stack**. It never sends motor commands. See [`docs/V0.10.md`](docs/V0.10.md).

## v0.9 新增

- 机器人虚拟设备采用共享的 A* 网格寻路，不再使用固定延时假装完成导航；通过受控 `GridNavigationBridge` 反馈路线进度、位置和朝向。
- Device Gateway v2 接收经过设备认证的导航状态，并验证序号、进度、地图和目标点；未到达的导航任务不可报告成功。
- 家长控制台新增外部虚拟设备的位置地图，配合多设备工作流验证。没有实体电机控制，也没有真实 ROS 2/Gazebo 物理仿真。
- 原有 v1 设备协议仍保留兼容；v2 设备要求到达证明。见 `docs/V0.9.md`。
- 本地 68 项测试通过；包括真实 Node 虚拟设备进程通过 SSE/HTTP 回传导航轨迹。

## v0.8 新增

- 儿童或家长可通过本地认证创建 AI 计划建议；建议不执行动作，家长审核后才使用既有 PlanOrchestrator。
- 默认离线规则分类器，`ALEX_PLAN_PROVIDER=compatible` 才发送自然语言给 HTTPS 模型提供商（需显式配置模型凭据）。
- 10 分钟审批期限、崩溃后停止、幂等请求、审计与任务事件关联。详见 `docs/V0.8.md`。
- 仍然只支持固定模拟任务模板；没有真实电机或开放式 AI 编排。

## v0.3 新增

- 可选 `AUTH_MODE=local`：家长密码、儿童 PIN、HttpOnly 会话与登录限速；由服务端确定角色，不再相信客户端的 `actor` 字段。
- Web Console 增加家庭登录及退出界面；已登录角色不能通过下拉框冒充其他角色。
- `.local/memory.json` 提供家庭/家长/儿童范围的**手动**记忆记录和删除，儿童不可写入，也无法查看家长私有记忆。
- `.local/audit.jsonl` 保存操作类型、结果和经验证的角色，不保存原始对话内容或密码。
- 全部 API 仍只允许 loopback 访问。默认 `demo` 为**不安全的兼容演示模式**，真实家庭试用必须显式开启 `AUTH_MODE=local`。
- 27 项 Node 本地自动化测试通过；详见 `docs/V0.3.md`。

## v0.2 新增

- `AgentProvider` 可替换：默认离线规则解析，显式配置时启用 HTTPS OpenAI-compatible 模型建议；模型只能提出受控意图，实际执行必须通过 PolicyEngine。
- `SkillRegistry` 支持受信任插件的版本、开关、角色权限、能力要求和注销；当前教学及故事仍为演示实现。
- 导航任务支持 `requestId` 幂等重试、超时、冲突检测；任务和事件采用原子 JSON 快照保存。
- 重启后保留任务历史，但所有中断的移动任务会被标记停止，模拟机器人位置重新回到充电点（不会自动续跑）。
- 22 项 v0.2 本地测试（包括真实 HTTP 进程重启测试和模拟 LLM 安全路由测试），详见 `docs/V0.2.md`。

## 本批已实现

- 统一 Device/Robot/Task/Skill 契约（TypeScript）
- 本地 Home Core：设备列表、权限检查、技能注册、任务生命周期、事件流
- 受控导航：A* 网格寻路、家具/墙体障碍、移动/任务进度、取消与急停锁定
- 临时障碍物插入会使运动任务停止；解除障碍后需要重新下达任务
- 家长/儿童两个角色的权限策略（`demo` 模式仅模拟，`local` 模式有登录验证）
- 确定性的中文/英文命令解析器（**没有接入任何 LLM**）
- 3 个演示技能：英语学习、互动故事、家庭状态（**占位响应，不是真正教学或语音 AI**）
- 纯前端可视化指挥中心（家庭地图、机器人位置、指令、技能、事件、状态）
- HTTP JSON API + SSE 事件流，自动化测试可在本地运行

## 环境要求

Node.js >=20，npm。依赖仅包含开发时的 TypeScript 编译器，运行时无需第三方 npm 包。

```bash
npm install
npm run build
npm test
npm start
```

浏览器打开 **http://127.0.0.1:4317**。默认仅监听本机 loopback，不要修改 `HOST` 对公网开放。

无需安装依赖（但本机已有 `tsc`）时也可以先 `npm run build && npm start`。

## 本地家庭身份认证（v0.3）

```bash
AUTH_MODE=local \
ALEX_PARENT_PASSWORD='replace-with-your-unique-long-password' \
ALEX_CHILD_PIN='654321' \
npm start
```

`ALEX_CHILD_PIN` 示例值仅用于测试，请自行设置私密 PIN。登录后浏览器使用 `HttpOnly; SameSite=Strict` 的会话 Cookie；家长和儿童角色由服务端验证。该模式仍仅允许本机访问，不提供公网 TLS、真实儿童隐私合规或实体安全能力。默认 `AUTH_MODE=demo` 仅用于快速演示，**不可作为家庭安全权限边界**。

- `GET /api/auth/session` 获取当前会话角色；`POST /api/auth/login` 接受 `{role,secret}`；`POST /api/auth/logout` 退出。
- `GET /api/memory` 列出当前身份允许看到的手动记忆；`POST /api/memory` 和 `POST /api/memory/delete` 仅家长可写。
- `GET /api/audit` 仅家长可查。具体格式见 `docs/V0.3.md`。

## 实际体验路径

1. 在地图下点击「去书桌」，任务变为运行中，看到机器人沿路径移动。
2. 在「当前角色」切换为儿童，点击「充电基站」，观察权限拒绝。
3. 点击「讲故事」，运行占位 Skill，并在事件区看到 `skill.invoked`。
4. 移动过程中打开「模拟临时障碍物」，机器人停下，任务变为 stopped。
5. 点击「紧急停止」，任何角色都可以停止；只有家长可以复位。
6. 发送自然语言「去客厅」「学英语」等指令，验证意图路由。

## API 使用示例

```bash
curl http://127.0.0.1:4317/api/state
curl -H 'Content-Type: application/json' \
  -d '{"actor":"parent","text":"去书桌"}' \
  http://127.0.0.1:4317/api/command
curl -N http://127.0.0.1:4317/api/events
```

接口完整说明见 `docs/API.md`。

## 可选连接模型

默认无需 API Key：`AGENT_PROVIDER=rules npm start`。
真实模型需要在私有环境配置 `AGENT_PROVIDER=compatible`、`AGENT_BASE_URL`、`AGENT_MODEL`、`AGENT_API_KEY`。服务端调用 OpenAI-compatible chat-completions JSON 接口。请先运行模拟命令；适配器目前仅通过 mock 测试，未验证特定真实服务商。

`STATE_FILE` 默认 `.local/state.json`，` .local/` 已忽略，不要上传真实家庭数据。`demo` 下 HTTP 角色仍为模拟；`local` 下使用服务端验证的会话。任何模式均不得对公网或实体电机开放。

## 本批不包含

- 真实 LLM/Agent、ASR、TTS、相机、麦克风、机器人实体固件
- ROS 2 / Nav2 / Gazebo 的真实运行与导航联调（仅有仿真资源及待运行的集成测试）；SLAM 尚未实现
- 完整家庭记忆/账户系统（v0.3 仅本机密码会话和手动记忆条目）
- 第三方 Skill 沙箱、真实设备配对/远程固件升级
- 经认证的功能安全及防撞控制

**重要安全声明：** A* 路径搜索、机器人屏幕位置和急停逻辑只用于软件模拟。**绝不能将该项目的碰撞模型、HTTP 急停或角色选择直接用于实体机器人安全控制。** 真实移动设备必须具备本地、硬件独立的安全机制，并在有人监管的环境内测试。

## 目录说明

```text
src/contracts.ts          统一契约
src/home/agent.ts         确定性意图解析
src/home/policy.ts        权限规则
src/home/skills.ts        Skill 注册与占位执行
src/home/core.ts          中枢、任务与事件调度
src/robot/map.ts          环境与 A* 路径规划
src/robot/simulator.ts    运动执行模拟
scripts/server.mjs        本地 HTTP + SSE
public/                   零依赖 Web 指挥中心
tests/                    Node 自动化测试
docs/                     架构、协议、安全与后续路线
```

## 下一批建议

优先补**设备身份 / 配对 / 家庭资料删除与加密保护**，之后再扩展真实 Skill 和家庭设备适配；完整计划见 `docs/ROADMAP.md`。

## v0.4 local household features
See [`docs/V0.4.md`](docs/V0.4.md) for device pairing, minimal learner profiles, parent privacy export/erase and optional role-filtered Agent memory hints. Device pairing requires `AUTH_MODE=local`; **do not expose the HTTP server to your LAN**. These features are APIs for the first developer prototype, not a production secure cloud platform.

## v0.5 — Virtual Device Gateway

Alex can now bind multiple independent **virtual** devices and dispatch parent-authorized, simulated tasks. The devices report capability sets, receive SSE messages, and acknowledge execution through authenticated HTTP. The Home Core's 2D robot remains a separate built-in simulator.

**Start in local family auth mode:**

```bash
npm install
npm test
AUTH_MODE=local ALEX_PARENT_PASSWORD='your-private-12-plus-character-secret' ALEX_CHILD_PIN='123456' npm start
```

Pair virtual devices via the parent-only device pairing API, then launch each simulation with:

```bash
ALEX_DEVICE_ID='dev-...' ALEX_DEVICE_TOKEN='the-one-time-token' npm run virtual-device
```

The token must remain private and should not be committed. Approve a device's declared virtual capabilities as a parent. In the browser control center, the multi-device section shows device grants and virtual jobs and allows sending `sim.navigation.goto` tasks.

See [v0.5 specification and API guide](docs/V0.5.md) for the complete workflow, security boundaries, reboot behavior and sample request bodies. **No physical movement is supported.**

## v0.6 — Composite robot + skill workflows

Alex can now execute **two allowlisted simulated workflows** from the same parent-only local console:

- `study.english`: navigate a paired virtual robot to the study desk → invoke trusted English demo skill on Home Core → send bounded `audio.output` text to the same device.
- `story.corner`: navigate to the story corner → invoke story demo skill → send virtual audio text.

Prerequisites: `AUTH_MODE=local`, a paired running virtual client, and **explicit parent approval** of `sim.navigation.goto` plus `audio.output`. Open the **Workflow Orchestrator** panel or submit “去书桌陪我学英语” in the command input. New endpoints: `GET /api/workflows`, `POST /api/workflows/start`, `POST /api/workflows/command`, and `POST /api/workflows/cancel`.

Workflows persist to `WORKFLOW_FILE` (default `.local/workflows.json`), are idempotent via request ID, and **stop without replay** after restart, device outage, revoked grant or cancellation. These are *simulated* device acknowledgements, not real navigation, sound playback or real AI teaching. See [docs/V0.6.md](docs/V0.6.md).


## v0.7 — 受控计划编排 / Durable Plan Events

- 三个已审查的计划模板支持依赖步骤（虚拟导航 → 演示 Skill → 虚拟语音输出），不会接受任意 AI 生成的硬件动作。
- `GET /api/plans`、`GET /api/plans/events?after=0`、`POST /api/plans/start`、`POST /api/plans/command`、`POST /api/plans/cancel` 仅支持本地家长登录。
- `PLAN_FILE` 可配置持久化路径；中断/重启后的计划一律停止、不自动重放。
- 虚拟设备接入后，在 Web Console **受控计划编排** 区域操作。详见 `docs/V0.7.md`。
- 仍然是纯模拟器，真实模型规划、ROS 2 和实体运动控制尚未实现。

## Docker simulation deployment (v0.15 tooling)

Use Docker Desktop or Linux Docker to build an isolated Ubuntu 24.04 + ROS 2 Jazzy + Gazebo Harmonic environment. See [Docker simulation guide](docs/DOCKER_SIMULATION.md).

```bash
bash scripts/docker-sim.sh setup
bash scripts/docker-sim.sh check
bash scripts/docker-sim.sh preflight
bash scripts/docker-sim.sh accept
```

Docker checks do not substitute for a successful three-leg Gazebo/Nav2 navigation report. No hardware is attached.

## Console v2 workspace recovery

The six-workspace console restores previously hidden controls and puts simulated stop and action feedback outside the route area. Workflows, plans, device gateways, skills, events, and parent-scoped family settings retain their original API contracts. See [`docs/CONSOLE_V2.md`](docs/CONSOLE_V2.md). This is a simulation UI, not a physical safety system.
