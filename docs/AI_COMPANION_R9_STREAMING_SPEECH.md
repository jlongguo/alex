# Alex R9 · 流式 PCM TTS、播放队列与用户主动打断

2026-11-05 · R9 是基于 R8 Draft PR #44 的叠加 PR #45。当前主线仍是通用 AI 家庭终端，英语只是独立 Skill；语音属于人机交互能力，导航属于可选后端。本轮没有接入真实电机和机器人行为。

## 已实现的真实协议

R9 的可选 `StreamingPcmSpeechProvider` 使用**既有音频 Speech API 的 HTTP 流式响应**，请求 `POST /audio/speech`，选择 `response_format:pcm` 与 `stream_format:audio`。当前供应商文档确认 PCM 是 **24 kHz 单声道、16-bit signed little endian 的裸音频**，没有 WAV 头。上游的 HTTP 响应在产生音频的过程中，允许 Alex 一段段读取。源码为逐个 pull/read 读取，**不是先下载整段 MP3 才播放**。

选定最后一条回复 → 用户主动点击“流式朗读最后回复（实验）” → 服务端验证家长对当前孩子的 `voiceOutputAllowed` 与 `cloudAudioOutputAllowed` → 使用服务端密钥打开独立 HTTPS 流式合成请求 → 浏览器向 Alex 拉取单个 PCM16 小块 → Browser AudioContext 将小块排程播放 → 浏览器每片的 `onended` 回调后发送有序 ACK → 服务端记录非内容的客户端估计播放长度。用户随时可点击停止，或主动点击“打断朗读并开始语音输入”来中止播放器与后端合成请求。

**这是用户主动发起的流式语音合成与手动抢话。** 它不是把上游实时转写与自然语言模型的生成、TTS 和音频播放耦合成同一个双向实时对话循环；仍无自动唤醒、常驻监听、无接触抢话或真正的全双工语音模型会话。

## 配置与隔离

默认关闭，不影响 R6 的 MP3 合成、R7 的短片段上行或 R8 的上游实时 ASR。

```bash
AUTH_MODE=local
ALEX_SPEECH_STREAM_PROVIDER=compatible
ALEX_SPEECH_STREAM_BASE_URL=https://your-trusted-speech-provider.example/v1
ALEX_SPEECH_STREAM_API_KEY=your-private-server-secret
ALEX_SPEECH_STREAM_MODEL=your-current-supported-speech-model
ALEX_SPEECH_STREAM_VOICE=alloy
```

实际模型名需要根据当前服务商的可用型号配置，**不要在应用中固定已被公告退役的老 Speech 模型**。OpenAI 2026 年的 Speech API 仍提供 PCM 选项，但部分老模型有 2027 年退役计划，后续应支持实时输出 Provider 的更换。服务端密钥从不下发浏览器。用户仍需查看供应商对未成年人语音与文字的使用、保留、删除和计费政策。

只有在 `AUTH_MODE=local`、当前验证身份与两层语音权限通过时才能开始、读取或确认流式音频。家长可以立刻撤销特定学习者的合成权限；在会话进行过程中撤销会调用取消。跨孩子无法读取、确认、取消另一个孩子的音频。家庭隐私删除和单个学习者删除会清空相关会话与非内容计数。

## R9 HTTP API

所有端点都在 Alex 本机环回地址，由已有的会话 Cookie 与 Host/Origin 校验保护。

| 方法 | API | 内容 |
| --- | --- | --- |
| GET | `/api/audio/playback/capabilities` | 当前用户是否真的已配置并授权，PCM sampleRate=24000、3 个未确认块额度 |
| POST | `/api/audio/playback/start` | `{text}` 最大 500 字，显式打开流式 HTTPS Provider；返回本人专属 opaque session ID |
| POST | `/api/audio/playback/next` | `{id,seq}`，按连续序号拉取下一个 **最多 4800 字节** PCM16 块；返回二进制，204 代表音频流结束 |
| POST | `/api/audio/playback/ack` | `{id,seq}`，浏览器片段 `onended` 后确认已播放；严格递增且不能重复 ACK |
| POST | `/api/audio/playback/status` | `{id}` 返回当前身份的队列、累计已下发/客户端宣称已播放采样数量等非内容状态 |
| POST | `/api/audio/playback/cancel` | `{id}`，中止当前用户的会话与尚未读取完的上游流，返回估计已播放毫秒数 |
| GET | `/api/audio/playback/metrics` | 当前身份的请求、完成、取消、过期和采样计数；不含音频和文字 |

浏览器拿到 PCM 数据之后只在内存中转换成 WebAudio `AudioBuffer`。最多提前排程两片（各约 100ms），浏览器尚未确认播放的片段数超过 3 时服务端拒绝继续发送，构成有限的浏览器→Alex→供应商**反压**。当前的 TCP/HTTP fetch 可能存在内部网络缓冲，不能声称供应商实际立刻停止消耗成本，也不保证端到端零复制。

## 资源上限

- **PCM16 24 kHz 单声道**，每片最多 **4800 字节、100ms**，样本必须为偶数字节、完整 16-bit little-endian。
- 供应商响应整个会话最多 **1,920,000 字节（约 40 秒音频）**，最大单次原始网络读取块 128KiB。
- 最多 **4 个并行流式播放会话**，同一身份最多一个，每身份每分钟最多创建六次。
- 最多 **3 片尚未确认**的媒体，限制浏览器预测缓冲和一次性下载；浏览器自身最多预排程两片。
- 空闲超过 12 秒、会话超过 65 秒时清理；取消时中断响应读取并尝试销毁流。
- 外部请求超时最多 60s；供应商网络错误不会把其私有错误响应、Token 和音频正文交给客户端。

## 播放进度、插话和对话一致性

R9 特意区分下列三个含义：

1. **已生成/已下发**：供应商或 Alex 已经提供 PCM 数据，不能保证浏览器播放过。
2. **客户端声称已播放**：浏览器在音频 `onended` 事件触发时，向服务端对该片发送 ACK，可估计 `playedMsClaimed`。这不等于证实扬声器有声音，更无法确认孩子真的听到了。
3. **AI 对话历史已提交**：仍仅由原来的聊天/Skill 流水线建立，与 TTS 的音频播放状态**独立**。停止音频不会编造模型已说完的事实，也不会擅自重写模型回复。

R9 没有使用客户端播放事件伪造用户的学习成绩、语音记忆或能力评分。麦克风按钮和“打断朗读并开始语音输入”都需要用户明确操作。打断后本地音频节点立即停止，并 best-effort 取消服务端和云端请求；已发出的媒体/文字不能在供应商侧撤回。后台化、切换身份、家长撤销或页面关闭同样停止本地流。

## 自动化测试验收

测试涵盖：外部 HTTP PCM 供应商协议、头类型/密钥隔离、前置文本限制、分片与字节对齐、供应商超大数据、停滞网络取消；逐人会话额度、严格序号、首次播放估计和中断已播放进度、取消/超时/隐私擦除；浏览器 WebAudio 两片预测缓冲、`onended` 才 ACK、不自动执行对话/机器人命令；真实 Node localhost HTTP 与测试模拟的 HTTPS 供应商（不会对互联网发送录音或文字）。

**尚未实测：** 真正的 Chrome/Edge/Safari 音频播放行为、AudioContext 自动播放策略、真实供应商端到端首音时延、网络抖动、成本与长时运行稳定性。自动化的事件时序和临时 PCM 不等于现场听感；不能作为儿童数据生产合规验收。

## 后续 R10

应优先让实时 ASR → 受控 LLM 生成 → 流式 TTS 出声形成一个**由明确用户/家长授权的统一语音轮次编排器**，包括文本增量与实际播放偏移一致性、显式打断状态传递和取消响应、真正供应商首音时延 P50/P95、音频设备实时测试、第三方费用预算与安全治理。原有 ROS/Gazebo 仿真仍是可选能力，不要把没有验证的导航行为并进本轮语音验收。
