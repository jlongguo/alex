# Home Agent OS HTTP API v0.1

默认地址：`http://127.0.0.1:4317`。此 API 仅供本机开发，**没有认证**，不可公网开放。

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
