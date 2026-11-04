# Alex HTTP API（本地原型）

默认地址 `http://127.0.0.1:4317`。默认 demo 是不安全演示模式；家庭会话、私有资料与 AI Companion 必须在 `AUTH_MODE=local` 下使用家长密码/儿童 PIN。API 仅监听本机，不得直接开放互联网。

## AI 互动终端 R6：短音频与云端 Provider

- `GET /api/audio/capabilities`：认证后返回实际可用的 ASR/TTS、MIME 和大小上限（不含服务端密钥）。
- `POST /api/audio/transcribe`：原始 audio/webm / ogg / mp4 / wav / mpeg，请求头 `X-Alex-Audio-Duration-Ms` 为 300～15000 的浏览器声明，`X-Alex-Language` 为 en/zh；仅在对应独立儿童获 voiceInputAllowed + cloudAudioInputAllowed 双重授权（或已验证家长）且配置 Provider 时转发。响应 `{ok:true,text,source:'cloud-asr',validated:false,requiresManualSubmit:true}`，文字不得自动发往 Agent。
- `POST /api/audio/speak`：JSON `{text,language}`，只允许经同级授权的显式云端语音操作；返回 `audio/mpeg` 二进制（≤2 MB），no-store。
- `POST /api/audio/cancel`：仅取消当前会话身份的正在进行音频操作。
- 实际 Provider 兼容选项见 [R6 文档](AI_COMPANION_R6_AUDIO.md)。录音时长仅是客户端自报，**目前未做可信音频解码时长验证**。云端供应商实际隐私、音质和价格仍需单独验收。

## AI 互动终端 R5：逐人 AI / 浏览器语音隐私策略

- `GET /api/learner/privacy`：需要本地已验证会话，默认返回当前用户允许的 `voiceInputAllowed`、`voiceOutputAllowed`、`cloudTextAllowed`、`preferredLanguage`、`learningPace` 和 `topics`。独立儿童只能读自己的有效配置。
- `GET /api/learner/privacy?profileId=profile-UUID`：仅家长查看具体孩子的配置；跨孩子 403。
- `POST /api/learner/privacy`：仅家长，JSON `{profileId,preferences:{voiceInputAllowed,voiceOutputAllowed,cloudTextAllowed,preferredLanguage,learningPace,topics}}`，支持字段局部更新但不可写任意提示词。云模型授权撤销时对该孩子正在生成的请求尝试中断。
- 已配置云模型时，所有模式每回合都按验证的学习者判断是否允许向第三方上传对话；未授权的儿童仍可使用确定性的本地英语、故事、科学 Skill，但不能使用无离线实现的自由聊天。
- 浏览器识别文本只是输入框预览，未经用户二次点击“发送”不调用聊天 API；语音录制不会由 Alex 后端保存。
- 家长隐私导出新增 `learnerPrivacy`；scope=child/all 的清理、删除学习者档案都会清除/重置相应授权。远端模型的已接收数据不在本地删除范围。
- 完整约束和人工验收见 [R5](AI_COMPANION_R5_VOICE_PRIVACY.md)。

## AI 互动终端 R4：课程、计划及独立学习成果

- GET /api/learning/catalog：经本地验证的用户可查看已安装、允许执行的固定文本课程 ID、版本和描述。
- POST /api/companion/open：新增可选 lessonId（仅对应 english/story/quiz 等互动模式），打开指定的课程会话；自由 chat 不能携带 lessonId。
- POST /api/skills/invoke：仍经过 SkillRegistry / PolicyEngine 检查，可为互动课程携带匹配的 lessonId。
- GET /api/learning/plans 和 GET /api/learning/overview：家长可查看所有课程计划、按 profileId 筛选，独立学习者只能看自己的计划和已完成/目标次数。
- POST /api/learning/assign、/api/learning/change、/api/learning/delete：家长分配、暂停/恢复、删除课程目标；不会自动执行任何设备动作。
- GET /api/companion/progress?scope=self：新增 byCourse、scienceTextQuizzesCompleted、retentionLimit；仅统计系统确认完成的离线文本练习，不是模型生成成绩。
- GET /api/privacy/export 包含 learningPlans、learningEvidence；POST /api/privacy/erase 在 child/all 范围清理相关课程计划及文字完成证据。明确删除聊天或学习者也清理对应记录；自动会话轮换除外。
- 完整保留、升级及功能限制见 [R4](AI_COMPANION_R4_CURRICULUM.md)。

## AI 互动终端 R3：独立学习者与虚拟呈现回执

- POST /api/auth/login 支持 role=learner、code（家长提供的 12 位十六进制登录代码）和 secret（该学习者专属 PIN）；成功的服务器会话返回 child 角色及 learnerId。
- GET /api/profiles 按身份裁剪：家长查看所有档案，独立学习者只能查看自身，旧共享儿童身份不再能列出所有孩子。
- 家长接口 POST /api/learners/set-pin、POST /api/learners/revoke、GET /api/learners/access。后两者分别管理撤销和查看公开登录代码（不返回 PIN/哈希）。
- GET /api/companion/progress?scope=self 读取当前独立学习者文字学习完成情况；家长可以 scope=child 汇总所有孩子或 scope=learner:profile-UUID 查看指定孩子。
- POST /api/gateway/presentation 使用已配对设备 Bearer Token 接收 v3 虚拟终端表情/字幕的严格回执；不是物理扬声器或真实 ASR/TTS。
- 更多规范：[R3](AI_COMPANION_R3_IDENTITY_TERMINAL.md)。

## AI 互动终端 R2：流式、学习记录（2026-11-04）

- `POST /api/companion/stream`，JSON 请求 `{"id":"<UUID>","text":"I like apples."}`，返回 `text/event-stream`。流依次出现 `ready`、多个 `delta`、成功时唯一权威 `committed`；失败时出现 `error`。**仅接收到 delta 不代表提交成功**。
- `GET /api/companion/progress`：当前经验证会话的文字练习完成摘要。家长用 `?scope=child` 查看儿童摘要，儿童无权读取家长记录。
- 浏览器中止后未提交的流式文本不会进入对话记录。学习完成记录只源于离线句型/剧情步骤，不能作为发音或真实课堂考核证明。

完整协议与限制见 [AI Companion R2](AI_COMPANION_R2_STREAM.md)。

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
