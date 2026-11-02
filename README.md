# Home Agent OS — 可运行的家庭智能中枢 + 虚拟移动机器人

> **v0.7.0 · allowlisted plans, durable events, family auth and multi-device simulation**
>
> 这是一个可运行的架构验证项目，不是具备真实自主导航或通用 AI 能力的成品。

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
- ROS 2 / Nav2 / SLAM / Gazebo 的真实导航集成
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
