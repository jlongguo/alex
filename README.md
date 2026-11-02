# Home Agent OS — 可运行的家庭智能中枢 + 虚拟移动机器人

> **v0.2.0 · Home Agent OS simulation with opt-in model adapter and persistent task history**
>
> 这是一个可运行的架构验证项目，不是具备真实自主导航或通用 AI 能力的成品。

## v0.2 新增

- `AgentProvider` 可替换：默认离线规则解析，显式配置时启用 HTTPS OpenAI-compatible 模型建议；模型只能提出受控意图，实际执行必须通过 PolicyEngine。
- `SkillRegistry` 支持受信任插件的版本、开关、角色权限、能力要求和注销；当前教学及故事仍为演示实现。
- 导航任务支持 `requestId` 幂等重试、超时、冲突检测；任务和事件采用原子 JSON 快照保存。
- 重启后保留任务历史，但所有中断的移动任务会被标记停止，模拟机器人位置重新回到充电点（不会自动续跑）。
- 22 项本地测试（包括真实 HTTP 进程重启测试和模拟 LLM 安全路由测试），详见 `docs/V0.2.md`。

## 本批已实现

- 统一 Device/Robot/Task/Skill 契约（TypeScript）
- 本地 Home Core：设备列表、权限检查、技能注册、任务生命周期、事件流
- 受控导航：A* 网格寻路、家具/墙体障碍、移动/任务进度、取消与急停锁定
- 临时障碍物插入会使运动任务停止；解除障碍后需要重新下达任务
- 家长/儿童两个角色的**模拟权限策略**（不是认证系统）
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

`STATE_FILE` 默认 `.local/state.json`，` .local/` 已忽略，不要上传真实家庭数据。所有 HTTP 身份仍为模拟角色；不得对公网或实体电机开放。

## 本批不包含

- 真实 LLM/Agent、ASR、TTS、相机、麦克风、机器人实体固件
- ROS 2 / Nav2 / SLAM / Gazebo 的真实导航集成
- 完整家庭记忆、用户账户与身份验证（仅持久化模拟任务/事件）
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

优先补**家长认证 / 设备身份 / 操作审计**，之后再扩展真实 Skill 和家庭设备适配；完整计划见 `docs/ROADMAP.md`。
