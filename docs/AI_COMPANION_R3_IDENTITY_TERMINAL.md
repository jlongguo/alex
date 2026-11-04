# Alex R3 — 独立学习者身份与虚拟终端协议

2026-11-04。本版本是本地软件模拟原型。Alex 的产品定位是通用、可扩展的家庭/儿童 AI 终端，英语学习只是一个 Skill。ROS2/Gazebo/Nav2 是可选模拟后端，不影响主线。

## 一、独立学习者身份

过去所有孩子使用同一个 child PIN，导致不同孩子的对话、学习进度混在一起。R3 引入家长管理的独立档案凭据：

1. 家长创建昵称、年龄段和兴趣标签档案。
2. 家长为每个档案设置 6～12 位数字 PIN，服务器返回 12 位十六进制登录代码。登录代码是可公开给该孩子的账号标识，不是 PIN。
3. 服务器在独立凭据文件中存放随机 salt + scrypt 哈希，文件使用本地 0600 权限，不在 API、导出或审计中泄漏 PIN。
4. 孩子使用角色 learner、登录代码、PIN 登录；Session 由服务端绑定 profileId，继承 child 权限，但对话所有权是 learner:profile-UUID。
5. 不同学习者不能读取、继续、删除对方的聊天记录，也不能查阅其他孩子的文字练习完成记录；家长可明确查询所有儿童汇总或单个孩子的进度。
6. 旧共享儿童 PIN 保留兼容，但只能使用自己的 legacy child 会话，不得枚举其他独立学习者的档案。
7. 重设 PIN 会注销该学习者旧 Session；撤销凭据阻断再次登录；删除档案进一步清除相应会话和学习记录。第三方模型已经收到的内容及本地备份、审计不会自动清理。

## 二、家长与孩子操作

本地启动：bash scripts/start-local.sh

家长打开 http://127.0.0.1:4317/#family，新建档案，选择档案后设置独立 PIN，取得登录代码。退出后孩子选择“独立学习者”，输入代码和 PIN。其后在 #overview 进入 Alex 互动终端，使用文本英语、故事或显式配置的模型聊天。

家长接口：
- POST /api/learners/set-pin : profileId、pin；设置或重设凭据。
- GET /api/learners/access : 已开启的 profileId、代码和更新时间（无哈希和 PIN）。
- POST /api/learners/revoke : profileId；撤销代码与已有登录会话。
- POST /api/profiles/delete : 删除档案时一并撤销凭据、登录会话、聊天与文字进度。
- GET /api/companion/progress?scope=child : 所有儿童完成步骤总计。
- GET /api/companion/progress?scope=learner:profile-UUID : 单个学习者汇总。

儿童接口：
- POST /api/auth/login : role=learner、code、secret。
- GET /api/auth/session : actor=child、learnerId=profile-UUID。
- GET /api/companion/progress?scope=self : 只能看自身文字练习进度。
- 其它 /api/companion/ 会话操作均自动使用服务端认证的 owner 身份。

## 三、虚拟终端协议 v3

虚拟设备新默认宣布 protocolVersion=3，保留 v1/v2 兼容。

- sim.navigation.goto：v3 沿用 v2 的严格位姿/进度到达反馈校验，不能通过协议升级削弱导航证明。
- display.face：虚拟终端实际更新内存表情状态，并输出到 CLI。
- audio.output：虚拟终端只输出字幕，不调用物理扬声器、TTS 或第三方语音服务。
- v3 的表情/字幕任务不能直接上报 succeeded。它须先使用设备 Bearer 令牌向 POST /api/gateway/presentation 上报 jobId、sequence=1、kind、phase=rendered、observed；服务器检查任务归属、当前运行状态、能力授权和观测字段。
- v3 回执只是虚拟设备进程的自报呈现，不是物理屏幕或音频真实播放证明。
- 新接口不是模型工具调用；仍只有家长能批准并派发虚拟设备任务。

## 四、交互状态机与语音边界

新增 public/terminal-runtime.js，状态为 idle/listening/thinking/speaking/error，具有合法转换检查、单调 revision 和有界事件记录。用户打断后，过期的浏览器朗读/识别事件不会错误结束新一轮。

Web Speech 接口由浏览器决定，可依赖厂商在线服务；只有用户明确操作后尝试启用。它不是低延迟实时流式 ASR/TTS，也不等于发音测评或孩子可独立无人监管使用。

## 五、测试与未完成内容

必须通过：多学习者身份隔离、未知代码和错误 PIN 拒绝、旧 Session 撤销、跨学习者聊天拒绝、独立学习成果、删除后的重启恢复、虚拟终端 v3 表情/字幕回执、旧版 v2 路径到达反馈、现有 v0.5/v0.6/v0.9 集成。

目前仍未完成生产级账号/传输、加密数据库、云同步、真实全双工语音、课程体系、个性化长期学习档案、第三方模型实测、实体运动安全认证。只在本地回环地址使用。

本轮分支：feat/alex-r3-learner-identity-terminal-20261104。CI 通过不代表浏览器语音或真实硬件验收。
