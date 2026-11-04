# Alex R6 · 可插拔云端语音 Provider 与短音频协议

2026-11-05。Alex 仍是家庭/儿童通用 AI 终端，英语只是 Skill 之一。R6 不修改 ROS2/Nav2 或实体运动设备。

## 实际实现范围

R6 在 R5 的浏览器 Web Speech 基础上增加 **真正的后端可调用语音供应商适配器**。语音仍是手动触发的短回合：

用户主动点击云端短录音 → 浏览器确认麦克风 → 最长约 15 秒的 MediaRecorder 录音 → Alex 本地后端校验认证和家长云端语音授权 → HTTPS 外部 ASR → **文字预览** → 用户确认后点击发送 → Alex 原有对话/Skill 流程。云端 TTS 是用户额外点击“云端朗读最后回复”后请求生成 MP3，回到浏览器临时播放。

**不包括**全双工实时 ASR/TTS、唤醒词、VAD、连续录音、摄像头、机器人运动、发音测评或自动给儿童学习能力评分。

## 双重权限：浏览器 ≠ 云端录音

R5 原有 `voiceInputAllowed` / `voiceOutputAllowed` 仅授权浏览器自身的 Web Speech 功能；R6 新增：
- `cloudAudioInputAllowed`：家长允许将录音送往自己配置的语音供应商，需要与 `voiceInputAllowed` 同时为 true。
- `cloudAudioOutputAllowed`：家长允许把选中的回复文字送往云端语音合成，需要与 `voiceOutputAllowed` 同时为 true。

原有 R5 JSON 缺少这两个字段时会自动以 false 补全，而非悄悄沿用旧浏览器授权。家长只能为特定独立学习者在控制台设置，原共享 child 账号默认全部禁用；服务端每个音频请求使用受信任的登录身份重新核对。

R6 服务端默认 `ALEX_AUDIO_PROVIDER=disabled`；即使家长已经开启偏好，也只有实际配置并启用音频供应商后才开放新云端音频接口。

## 可插拔 HTTPS Provider

`scripts/audio-provider.mjs` 实现单独的 `CompatibleAudioProvider`，使用系统自带的 `fetch`、`FormData`、`Blob`、`AbortSignal`，不会把密钥发给浏览器。

用于 OpenAI 兼容音频 API 的配置：

```bash
AUTH_MODE=local
ALEX_AUDIO_PROVIDER=compatible
ALEX_AUDIO_BASE_URL=https://api.openai.com/v1
ALEX_AUDIO_API_KEY=YOUR_PRIVATE_SERVER_SIDE_KEY
ALEX_AUDIO_ASR_MODEL=your-supported-transcription-model
ALEX_AUDIO_TTS_MODEL=your-supported-speech-model
ALEX_AUDIO_VOICE=alloy
```

具体模型名称必须按供应商**当前支持的音频模型**填写。OpenAI 官方已公告部分旧 Speech 和 Transcription 模型有 2027 年退役时间；R6 采用 Provider 接口隔离，以便后续替换为新的 Realtime 或批处理音频供应商。示例**没有在 CI 中调用真实云模型**；家长还需核实第三方服务是否允许处理儿童音频以及适用的隐私和数据使用条件。绝不能把密钥写入 `public/` 或浏览器运行时。

- `POST {BASE_URL}/audio/transcriptions`：multipart `file`、`model`、`response_format=json` 和受控语言 `en/zh`。
- `POST {BASE_URL}/audio/speech`：JSON `model`、`input`、`voice`、`response_format=mp3`；返回上限 2 MB 的 MP3。
- 仅允许 HTTPS，无 URL 内嵌凭据/查询；禁止重定向，读取下游结果有明确大小上限，遇到错误不把第三方原文返回客户端。
- Provider 超时最多 30 秒，浏览器中止不保证供应商此前已经收到的数据会删除。

## Alex 本地 HTTP 契约

要求 `AUTH_MODE=local`、登录 Cookie、loopback Host 与已有 Origin 保护。

| 接口 | 行为 |
| --- | --- |
| GET /api/audio/capabilities | 根据当前已验证身份，返回 ASR/TTS 是否真的已授权和已配置，暴露上限，不暴露密钥 |
| POST /api/audio/transcribe | 以原始 `audio/webm`、`audio/ogg`、`audio/mp4`、`audio/wav` 或 `audio/mpeg` body 上传；受权后转写，只返回文字预览和 `requiresManualSubmit=true` |
| POST /api/audio/speak | JSON `{text,language}`，由已授权用户显式调用，返回 `audio/mpeg` 二进制，不缓存 |
| POST /api/audio/cancel | 仅取消当前会话身份的正在进行任务 |

限制：最大 1,500,000 字节上传、最少 128 字节；浏览器声明 300–15,000 毫秒，最多每身份每分钟六个任务，同身份最多一个并发任务；云端合成文字不超过 500 字，返回音频最大 2,000,000 字节。

**重要：时长头是浏览器自报的操作限制，不等于服务端解码验证的真实声学时长。** 不能把它用于需要精确音频长度的生产级计费、风险控制或法规证明。真实产品仍需在可信音频解码器内验证采样率、容器结构、时长、恶意媒体载荷和实际成本额度。

## 浏览器交互与隐私

`public/audio-session.js` 使用 `MediaRecorder` 对应浏览器 MIME，只有用户主动点击并授权麦克风时才录音。停止后流经 HTTPS provider 的是短录音，转写文本放进输入框，必须由用户再次手动确认发送，**语音转写不会自动触发机器人、Agent 工具或 Skill 调用**。

手动点击“云端朗读最后回复”才将选中回复文本发送给云端 TTS。音频只以临时 Blob URL 播放，结束/停止/切换身份时销毁；没有使用 `localStorage`、IndexedDB 或服务器文件存储原始音频。但浏览器本身、第三方提供商和代理网关可能有独立的数据处理/留存行为，不在 Alex 的本地清理能力范围内。

R5 原来的浏览器 Web Speech 保持可选回退。R6 状态机沿用 idle/listening/thinking/speaking/error，并可以取消或打断两种浏览器播放机制。

## 验收边界

自动测试覆盖 HTTPS adapter、权限默认值与旧版 JSON 迁移、体积和 MIME 限制、并发/限流、取消、模拟浏览器录音/播放、真实 localhost HTTP 上传和 MP3 返回（外部 HTTPS 供应商在 CI 中由专用测试 fixture 截获，**没有真实发送音频**）。

仍需实地测试：真实 Chrome/Edge/Safari 各平台麦克风授权、原始音频录制/停止与 HTMLAudioElement 播放、真实模型音质与中英文准确率、供应商对儿童音频的政策、可用成本预算。R6 PR #41 保持 Draft，直到以上验收完成。

## 后续路线

真正接近自然语音伙伴还需要 **R7：流式音频/WebSocket/WebRTC、VAD、打断可观测协议、音频帧鉴权与重放保护**，以及独立学习者长期上下文和加密事务数据库。不要把 R6 的短音频示例宣传成“实时全双工”或生产级合规能力。
