# Alex AI Companion R2 — 流式对话、可中断终端、文字学习证据

> 2026-11-04；本阶段是可执行软件研发原型。真实儿童使用体验、模型服务与浏览器语音功能仍需单独验收。PR #37 基于 PR #36，待确认 PR #36 合并后再调整合并目标。

## 本阶段端到端功能

1. 已验证的本地家庭用户打开 Alex 互动终端。英语和互动故事可在完全未配置模型时使用，自由对话必须显式启用云端模型。
2. POST `/api/companion/stream` 接收一次输入后，发送 `ready` 和若干 `delta`（只是未提交预览），只有最终 `committed` 是数据库/内存已经保存完整回合的权威结果。
3. 用户点击“中止本轮”、离开页面或网络断开，前端取消 Fetch、后端 AbortController 终止模型请求；中断文本不能被记作完整对话。
4. 在文字练习固定步骤真实完成时，离线引擎产生 `milestone`，用于可验证的轻量进度。模型自然语言不能直接创造任何教学完成事件。
5. 模拟终端展示等待 / 听写 / 生成 / 朗读 / 错误状态，支持浏览器按用户操作启用听写、可中断本地朗读、可恢复的历史会话和个人学习摘要。

### SSE 协议

```http
POST /api/companion/stream
Content-Type: application/json
Cookie: alex_session=<verified local session>

{"id":"<UUID>","text":"I like apples."}
```

流：`Content-Type: text/event-stream; charset=utf-8`

```text
event: ready
data: {"id":"...","provisional":true}

event: delta
data: {"text":"Nice"}

event: delta
data: {"text":" work!"}

event: committed
data: {"session":{...},"assistant":{...},"source":"offline","milestone":null}
```

失败使用 `event: error` 和 `{"error":"...","partialDiscarded":true}`；若客户端只收到 ready/delta 后被网络中断且没有 committed，不能当作成功。普通非流式 `POST /api/companion/turn` 仍兼容。

OpenAI-compatible 模型端需要返回官方 `stream: true` SSE 文本流与 `[DONE]`。流式解析使用 UTF-8 分片处理、最大 128KiB 原始流、最大 1200 字符完整回复、响应超时、强制检查终结标记，并拒绝模型返回的 `tool_calls` 或 function call。模型仍然**不拥有任何设备能力**；聊天不会绕过原有家长审批、任务和机器人安全控制。

## 文字学习成果（非真实语音测评）

- `english_a1_text`：离线固定句型练习完成 5 个教学步骤；只代表完成这一组文本练习。
- `story_choice`：离线完成 3 次故事选择；只代表互动故事结束。
- 模型的“你学得真好”等回复不能生成上述事件。
- 每次完成记录 `{kind, round, at}`，无答案文本；在当前会话保留时可用于统计。
- `GET /api/companion/progress` 默认只看当前登录身份；经过验证的家长可通过 `?scope=child` 查看共享儿童角色的摘要，儿童不能看家长记录。
- 记录保存在会话状态中，**不是独立的长期学习档案**。用户删除对话、家长擦除、达到会话保留上限会连带清除记录。只有 `ALEX_CONVERSATION_PERSIST=1` 时可在本地重启后恢复。
- 当前只支持一个共享的 `child` 身份，没有多儿童独立隔离、能力等级认证或发音准确度测评。

## 浏览器语音与设备安全边界

- `SpeechRecognition` 仅在用户点击后启用，语音识别可能依赖浏览器厂商在线服务；Alex 服务器不接收原始音频。
- `speechSynthesis` 默认关闭；可选手动开启回复朗读，可取消。此技术不是可保证低延迟的全双工语音通道。
- 页面角色指示来自服务端会话，demo 模式不开放聊天私有 API。
- 所有对话模型返回值只作为纯文本展示（`textContent`），不能通过输出调用 `navigation.goto`、`audio.output` 或其他设备 API。
- 本地存储仍是明文 JSON 原型，仅能在 loopback 使用，不具备生产级别儿童隐私合规或设备安全认证。

## 开发/验证

```sh
git fetch origin
git switch --track origin/feat/alex-companion-stream-learning-r2-20261104
npm install
npm test
bash scripts/start-local.sh
```

页面：`http://127.0.0.1:4317/#overview`。

测试包含：分块 UTF-8 与 SSE 多次 delta、未收到 DONE 时失败、超长输出/工具调用拒绝、取消后原子回滚、真正的本地 HTTP SSE、跨身份授权、文字学习幂等计数、家长查询/清理、断电/重启恢复等。CI 的节点测试不是浏览器语音兼容性或真实模型联调验收。

## 仍未完成（R3–R6）

- 完整语音环路：低延迟音频流、VAD、可靠 ASR/TTS、打断、降噪、声纹/儿童身份与物理隐私开关。
- 真实模型端到端：可信服务商的实测、质量指标、成本控制、失败重试/降级、长期记忆检索、受控工具调用/审批。
- 真实教学 Skill：更丰富的等级课程、学习目标、评分、学习者档案绑定以及多儿童隔离。
- 多端同步：虚拟设备显示/表情协议、设备呈现状态回执、自动化设备生命周期与组件复用。
- 基础设施：事务数据库、数据加密、恢复/迁移、家庭设备安全部署、监测和完整产品级验收。
