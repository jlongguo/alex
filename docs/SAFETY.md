# 安全与隐私边界（必须在硬件阶段落实）

## 当前实现只用于模拟

- 软件中设置 `emergencyStopped=true` 仅锁定模拟运动；不具备硬件刹车、碰撞认证、机械失效检测。
- 软件中的动态障碍是静态几何点，不代表视觉或 LiDAR 能识别儿童、台阶、宠物或透明物体。
- 软件内角色切换仅供权限测试；家长身份还未验证，任何本机使用者都可以伪装家长。
- 不允许接入实际电机、智能门锁、摄像头持续采集等有安全/隐私后果的设备。
- 服务仅监听 127.0.0.1。不得将端口转发至互联网。

## 接入实体机器人前的门槛

- 独立安全 MCU / 电机禁用线路、实体急停、失联自动停、低速测试、碰撞/悬崖检测和防夹伤设计。
- 导航任务签名或双向设备认证，明确的授权和目标区域限制。
- 本地运动监控的优先级必须高于中枢/云端 Agent；远程命令不可覆盖本地安全停止。
- 儿童相关摄像头、音频、身份与学习数据按最小必要原则处理；家长授权、查看、删除与物理隐私开关。
- 家庭用非载人机器人，应在有人监管的平坦封闭场地测试，不应被当作儿童看护设备。

## 真实 Agent 接入前

所有调用经过 schema 校验 + PolicyEngine + 明确的设备能力匹配；有风险的操作二次确认。防止工具调用注入、越权跨设备访问、任意 Skill 读取家庭数据。

## v0.12 ROS simulation-only acceptance

- `ALEX_ROS_SIMULATION_ONLY=1` and `ALEX_RUN_ROS_INTEGRATION=1` are both required before launching the three-leg acceptance harness.
- Domain `77` with `ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST` is intended to reduce accidental discovery of other ROS networks; **it is not certified isolation**. Do not run any physical robot on the same host/domain.
- Live navigation acceptance requires a *fresh* independently observed TF pose, Nav2 action success and feedback. A passing offline/CI test suite is never a substitute.
- A ROS Nav2 cancellation or process-group termination is not a physical emergency stop, and none of these scripts are approved for real motors.

## R3 独立学习者与虚拟终端

学习者 PIN 只允许经验证的本地家长设置。凭据以带随机盐的 scrypt 摘要保存在私有文件；录入后的明文 PIN 不会在 API/审计中返回。孩子登录的 learnerId 是服务器绑定的，不信任浏览器提交的 profileId。

本地会话原文若开启持久化仍是明文 JSON，因此不应开放公网、共享磁盘或进行云端公开部署。原共享儿童 PIN 是兼容身份，不保证按每个真实孩子隔离；需要由家长逐个设置独立登录身份。家长删除档案时同时撤销登录并清理本地相关对话数据，但远端模型日志与备份不在清理范围。

Virtual Device 协议 v3 的 display.face / audio.output 渲染反馈只说明 **模拟进程自报已输出表情或字幕**，不是实体显示/发声证明。不能把软件会话取消、语音按钮或模拟紧急停止直接当成硬件安全能力。
