# Alex R5 · 学习者隐私授权、受控模型上下文与真实浏览器语音桥接

2026-11-04。Alex 是**通用、可扩展的家庭/儿童 AI 终端**。英语、互动故事、科学问答均为 Skill；ROS2/Nav2 仍是独立的可选模拟运行时。这批不涉及实体硬件或自动运动。

## 本轮真正完成的能力

### 1. 按孩子进行显式授权

新增 `scripts/learner-privacy.mjs`。每个经过家长创建的 profile 拥有独立的安全偏好：

| 配置 | 默认 | 约束 |
| --- | --- | --- |
| voiceInputAllowed | false | 仅允许 UI 手动尝试浏览器语音识别；浏览器仍需要用户权限 |
| voiceOutputAllowed | false | 仅允许主动开启浏览器朗读，不等同于服务端 TTS |
| cloudTextAllowed | false | 允许将孩子输入的文字和近期对话发送给家长配置的兼容模型 |
| preferredLanguage | bilingual | zh/en/bilingual 三选一 |
| learningPace | slow | slow/normal |
| topics | [] | 最多五项固定枚举：animals/nature/science/stories/music/art/sports/robots |

家长编辑以上设置；独立学习者只能看到自己的设置。过去共享的 `child` 账号没有专属 profile，因此保留默认全禁云端/语音设置，并不继承其他孩子的授权。家长自己的浏览器音频可以手动使用，但仍需要明确点击，并受浏览器实际能力限制。

配置保存在专门的本机私有 JSON（`ALEX_LEARNER_PRIVACY_FILE` 可自定义），不包含姓名、真实生日、学校、住址、语音原件或自由文本中的隐私事实。

### 2. 云模型访问在服务端强制执行

`CompanionConversations` 在新建由模型支持的会话和**每次模型回合**都执行 `authorizeModel(principal)`，其中 principal 来自经过验证的服务端登录会话，而不是请求体的用户 ID：

- 未给该学习者开启 cloudTextAllowed 时，返回 `CHILD_CLOUD_TEXT_DISABLED`（HTTP 403）；离线 Skill 仍可以使用，且模型无法生成“认证成绩”。
- 允许云模型时，只将枚举的语言、节奏和兴趣标签附加到系统提示中；不会把家长全部记忆、PIN、真实姓名、生活细节和其他孩子的档案上传。
- 关闭 cloudTextAllowed 后，下一次 JSON 或 SSE 模型请求被拒绝；R5 还跟踪按真实身份分组的进行中请求，并在撤销时发起 AbortController 中止。上游模型可能已经收到数据，因此此功能不能追溯删除第三方模型收到的文字。
- 无论配置如何，模型仍**没有设备控制工具**，无法直接导航、启动麦克风、打开摄像头或执行家长控制操作。

注意：`cloudTextAllowed` 表示家长明确允许云端文字传输，不等于供应商合规证明，也不保证其符合儿童信息保护法律。真正部署前需审核模型提供商的存储、处理区域、删除、未成年人政策。

### 3. 浏览器真实语音能力（不是模拟状态）

新增 `public/voice-session.js`：基于浏览器可用的 `SpeechRecognition` / `webkitSpeechRecognition` 和 `speechSynthesis` 实现真实浏览器语音入口：

- 页面不会自动开始录音，须由用户点“语音输入”，并且当前学习者经过家长许可，浏览器本身仍会要求权限。
- 支持临时文字识别和最终文字结果；所有识别结果只预填输入框，由用户检查，**必须另点发送才调用模型**。
- 识别与朗读有独立中断 epoch：用户主动停止、切换身份、切出页面、发送文字或授权被撤销，都会取消相关操作，并忽略旧的异步回调。
- 回复朗读是可选动作；长文本按 180 字符左右分段送给浏览器语音合成，提供停止/打断语音按钮。**不会将音频直接传给 Alex 后端保存**。
- 页面每约三秒重新核对服务端授权；若校验失败则停用语音，使用 fail-closed。实际生效时间取决于浏览器网络/调度，不能宣称绝对即时。
- 支持 en-US / zh-CN 语言模式，既有终端状态机支持 idle/listening/thinking/speaking/error。

**重要限制：浏览器语音识别可能由浏览器服务商处理音频或识别文本；此版本不是我们自建的本地 ASR 服务、服务端流式语音、全双工低延迟对话、声学 VAD 或发音质量评分。** 没有厂商权限时它会失败并提示文字回退；不会假装已识别成功。

### 4. API 与家庭隐私生命周期

本地 `AUTH_MODE=local` 下：

- `GET /api/learner/privacy`：返回当前已验证身份的有效配置；家长默认具有本地手动音频能力，独立儿童读取自身配置，旧共享儿童默认禁用。
- `GET /api/learner/privacy?profileId=profile-UUID`：仅家长可查看指定档案的设置；儿童跨档案访问 403。
- `POST /api/learner/privacy`：仅家长可设置 `{profileId, preferences:{...}}`。不能上传任意提示词或可执行代码。关闭云模型权限时尝试停止此人的进行中生成。
- `GET /api/privacy/export`：额外包含家长保存的 `learnerPrivacy` 元数据。
- `POST /api/privacy/erase`：scope=child/all 时清空儿童音频/云端偏好，恢复默认禁用状态；其它范围不修改孩子授权。
- `POST /api/profiles/delete`：删除具体学习者后连带撤销其授权和已登录会话；家庭全量删除不自动删除第三方模型日志或备份。

### 5. 已覆盖的自动化检查

Unit：默认禁止、角色与学习者隔离、配置的不可变深拷贝、未知标签拒绝、持久化/重启、授权撤销、模型安全上下文、每次请求重新检查、浏览器模拟语音识别/临时文字、禁自动发送、分段朗读与打断回调。

真实 localhost HTTP：两个独立孩子、原共享儿童账号、家长设置授权、跨身份拒绝、导出无 PIN、档案删除后授权消失、重启恢复、scope=child 隐私擦除。

仍需实际人工验收：Chrome/Edge/Safari 不同平台的麦克风授权、失败提示、持续说话/停止朗读、家长关闭授权后的浏览器反应，以及配置真实模型后的网络行为。CI 只证明可执行的 Node 测试与模块兼容，并未执行实际麦克风或真实第三方模型调用。

## 建议本地验证

```sh
git fetch origin
git switch --track origin/feat/alex-r5-child-privacy-voice-20261104
npm install
npm test
bash scripts/start-local.sh
```

先以家长登录，创建两个独立儿童档案并设置 PIN。进入 Family 逐人启用或禁止语音和云模型权限。退出家长后使用两个孩子的不同登录代码与 PIN 登录，检查 UI 状态、隔离和撤销行为。启用真实云模型前先审查服务商的未成年人数据政策。

R5 PR #40 **叠加**在未合并的 R4 PR #39 上，不能直接按 main 分支内容进行 R5 的验收。若 R4 合并，先调整 PR #40 的 base 至 main，并重新执行全部回归。
