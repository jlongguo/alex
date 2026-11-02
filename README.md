# Home Agent OS — 可运行的家庭智能中枢 + 虚拟移动机器人

> **v0.1.0 · P0–P3 vertical slice**
>
> 这是一个可运行的架构验证项目，不是具备真实自主导航或通用 AI 能力的成品。

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

## 本批不包含

- 真实 LLM/Agent、ASR、TTS、相机、麦克风、机器人实体固件
- ROS 2 / Nav2 / SLAM / Gazebo 的真实导航集成
- 持久化家庭记忆、用户账户及身份验证
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

先补设备身份与受控本地账户，再实现可插拔 `AgentProvider`（Mock 和真实 LLM）及带审批的工具调用；后续接家庭设备适配器和 3D/ROS 2 桥接。具体见 `docs/ROADMAP.md`。
