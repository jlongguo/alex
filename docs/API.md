# Alex HTTP API（本地原型）

默认地址 `http://127.0.0.1:4317`。默认 demo 是不安全演示模式；家庭会话、私有资料与 AI Companion 必须在 `AUTH_MODE=local` 下使用家长密码/儿童 PIN。API 仅监听本机，不得直接开放互联网。

## AI 互动终端（2026-11-04）

`GET /api/companion/sessions`、`GET /api/companion/session?id=<UUID>` 和 `POST /api/companion/open|turn|delete` 均要求经过验证的本地会话，并按家长/儿童身份隔离；`POST /api/companion/erase` 只允许家长。

创建会话：`POST /api/companion/open` `{"mode":"english"}`，模式还支持 `story` 和 `chat`。交互：`POST /api/companion/turn` `{"id":"<session UUID>","text":"I like apples."}`。

`ALEX_CHAT_PROVIDER=offline` 时英语/故事有实际多轮离线训练，`chat` 明确拒绝伪造自由模型对话；`ALEX_CHAT_PROVIDER=compatible` 加上可信 HTTPS 模型服务配置后启用文本模型回复。对话不能自动执行设备命令，也不代表真实语音模型。

数据默认只保留内存；仅 `ALEX_CONVERSATION_PERSIST=1` 时将明文对话保存到本地文件。家长可用 `GET /api/privacy/export` 导出当前本地会话；`POST /api/privacy/erase` 会清除对应的会话和手动记忆，但不删除第三方模型已收到的数据。更多说明：[AI Companion MVP](AI_COMPANION_MVP.md)。

## 原有模拟接口（兼容）

## 只读

| 方法 | 路径 | 描述 |
|---|---|---|
| GET | `/api/health` | 运行模式与能力真实性声明 |
| GET | `/api/state` | 全量状态：机器人、地图、任务、Skill、事件 |
| GET | `/api/devices` | 已注册设备与能力 |
| GET | `/api/skills` | 已注册技能 |
| GET | `/api/events` | Server-Sent Events，类型 `home-event` |

## 命令

所有 POST 请求 `Content-Type: application/json`，最大 8 KiB；成功返回 `{ok:true,...}`，策略拒绝返回 HTTP 409 和 `{ok:false,message}`，请求参数无效返回 HTTP 400。

| 方法 | 路径 | JSON Body |
|---|---|---|
| POST | `/api/command` | `{"actor":"parent","text":"去书桌"}` |
| POST | `/api/tasks` | `{"actor":"parent","capability":"navigation.goto","params":{"destination":"study_desk"}}` |
| POST | `/api/tasks/cancel` | `{"actor":"parent","taskId":"task-1"}` |
| POST | `/api/safety/stop` | `{"actor":"child"}` |
| POST | `/api/safety/reset` | `{"actor":"parent"}` |
| POST | `/api/environment` | `{"actor":"parent","obstaclePresent":true}` |
| POST | `/api/skills/invoke` | `{"actor":"child","id":"story.interactive"}` |

### destinations

- `dock`
- `study_desk`
- `sofa`
- `story_corner`

### roles

- `parent`
- `child`

注意：`actor` 只是模拟器中的测试角色，不是可用于实体控制的真实身份验证。HTTP 应急停止不是物理急停。
