# Alex R4 · 版本化 Skill 课程、家长计划和独立文字成果台账

2026-11-04 · 本文是实际代码范围及验收契约，**不是正式教学认证**。Alex 定位为可扩展的通用家庭 AI 智能终端；英语、故事、科学只是三个不同的互动 Skill 方向，ROS2 是可选机器人运行时。

## R4 的实际交付

### 可信的版本化课程目录（scripts/skill-curriculum.mjs）

当前包含五项人工编写、固定规则的课程或互动内容：

| ID | Skill | 教学范围 | 固定步数 | 成果类型 |
| --- | --- | --- | --- | --- |
| english.a1.intro | learning.english | 名字代称、喜好、能力、感受 | 5 | english_a1_text |
| english.a1.greetings | learning.english | 英语问好、感受、致谢 | 3 | english_a1_text |
| english.a1.daily | learning.english | 起床、早餐、上学、睡觉 | 4 | english_a1_text |
| story.library.choice | story.interactive | 分支故事 A/B 选择 | 3 | story_choice |
| science.everyday.discovery | quiz.science | 阳光/植物、冰融化、过马路安全 | 3 | science_quiz_text |

目录每项包含 id、version、mode、skillId、level、title、description、objectives、targetStep 和 kind。

- 课程不是任意用户提交的 JS：只能选择在服务端已注册且版本化的内容，不能通过客户端传入任意代码。
- 文字练习只验证极少数句型或选择题的明确答案，不进行语音识别、发音评分、年龄/语言水平或教学效果认证。
- 可通过 Skill Registry 的授权入口启动相应课程；模型回复完全没有设备动作权限。
- 如果配置真实模型，模型生成的自然语言只能是互动文本，**不能生成系统的“课程已完成”证明**。确定性成果只来自离线规则的状态完成。
- 课程计划只是家长建议的练习目标；不禁止孩子探索别的已授权内容，也不限制其它 Skill。

### 家长分配学习计划（scripts/learning-plans.mjs）

为独立学习者 profile 设置课程目标 1–20 次，并提供 active/paused 和删除操作。一名学习者与同一课程之间最多一项计划；计划进度由已存在、可审计的文字完成事件实时汇总，而不是客户端上报分数。

安全边界：只有经验证的本地家长可以创建、修改、暂停或删除计划。独立学习者只能看自己被分配的计划；旧共享儿童身份不能读取各个具体孩子的分配。计划元数据保存至本机 0600 JSON，不含原始回答。

### 独立学习成果台账（scripts/companion-conversations.mjs）

早期完成次数只能在最近的聊天会话里读取。R4 将具有固定格式的完成证据独立存放于会话存储的 evidence 数组，保持一份**原子写入**的 JSON 快照：

- 事件含 sessionId、principal、课程 ID、内容主版本、完成轮次、事件类型、时间戳；不含具体答题文本。
- 自动淘汰超过 16 个/人聊天会话时，保留有界的完成事件；每个身份最多 128 项、整个进程最多 1024 项。超过上限自动淘汰较旧记录，进度**不是无期限永久总数**。
- 用户显式删除现存会话时清理其来源证据；家长执行隐私擦除或删除学习者时清理该身份及其所有残留证据。家长导出包含会话和成果记录。
- 从旧 R3 JSON 加载时做一次幂等迁移，防重复记账；会话仍存在时要求成果的 owner、lessonId 与会话一致，禁止不同学习者串号。
- 如果 `ALEX_CONVERSATION_PERSIST` 未启用，这份证据和聊天一样只保存在进程内存，**重启即消失**。如开启，聊天和成果保存于明文 JSON，不是生产级加密数据库。

注意：R4 家长计划保存在另外一个本地 JSON 文件。跨两个文件的多阶段删除无法提供数据库事务保证；生产化仍须专门处理迁移、崩溃恢复和多端同步。

## HTTP API（本地 Auth 模式）

- GET /api/learning/catalog — 登录后列出可信课程目录、版本、内容目标。
- GET /api/learning/plans — 家长所有、独立学习者自己的课程计划；可用 profileId 仅家长跨学习者过滤，拒绝跨孩子读取。
- GET /api/learning/overview — 计划 + 可信完成计数：completed、remaining、goalReached、textExerciseOnly。父母可通过 profileId 筛选，儿童仅查看自己。
- POST /api/learning/assign — 家长：profileId、courseId、targetCompletions（1–20）；同课程重复提交更新目标。
- POST /api/learning/change — 家长：id、status（active / paused）。
- POST /api/learning/delete — 家长：id。
- POST /api/companion/open — 支持 mode 与可选 lessonId，例如 mode=english、lessonId=english.a1.daily；mode=chat 不允许携带课程 ID。
- POST /api/skills/invoke — 互动 Skill 支持对应 lessonId，仍首先由 Skill Registry 和 PolicyEngine 授权。
- GET /api/companion/progress?scope=self — 返回按课程的 byCourse 和各文字类型完成次数，children 不可跨身份读取。
- GET /api/privacy/export — 家长导出含 learningPlans、learningEvidence；家长对 child/all 做隐私擦除时同时清理相关计划与学习证据。
- POST /api/profiles/delete — 清理该 profile 专属凭据、会话、文字成果及家长计划。远端模型日志及备份仍需另行处理。

所有对话动作仍不会直接触发机器人运动或设备操作；现有 v3 虚拟呈现协议及 ROS2/Nav2 验收语义保持不变。

## 浏览器体验

在“Alex 互动终端”选择英/故事/科学模式和特定内容，文字练习会按固定步骤给出反馈，完成后展示非评分性质的文字成果记录；家长在“家庭与设置”中可选具体学习者、课程及次数目标，并查看已完成/目标次数，可暂停/继续计划。浏览器语音输入和朗读依旧只是浏览器支持时的可选功能，不是全双工语音实现。

## 本批验收与限制

Node 与真实本地 HTTP 测试验证：版本化课程、跨学习者数据隔离、课程选择、家庭计划权限、学习成果、自动会话轮换、重启、R3 升级、异常磁盘写入回滚、隐私擦除、删除档案、非英语科学 Skill 不触发机器人设备任务。

人工验收仍需进行：
1. 浏览器实际用两个孩子身份登录，完成不同课程，确认页面和目标展示。
2. 真实模型提供商流式响应质量与隐私策略、实际浏览器语音兼容性测试。
3. 完整产品 UX、安全部署、长期加密存储、多个孩子的长期个性化学习内容，低延迟 ASR/TTS、更多通用 Skill。
4. 真实 Gazebo 三段路线仍属独立可选机器人子项目，CI 的 sim:preflight 不是移动机器人通过证明。

开发分支：feat/alex-r4-curriculum-learning-ledger-20261104。PR #39 保持 Draft，未合并即不应假设 main 已包含 R4。
