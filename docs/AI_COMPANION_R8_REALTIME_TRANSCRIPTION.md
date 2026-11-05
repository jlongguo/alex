# Alex R8 · 真正上游实时转写 WSS、PCM 音频管线和家庭权限

2026-11-05 · 对应 Draft PR #44。Alex 定位是可扩展的通用家庭 AI 智能终端；英语、互动故事和科学问答都只是 Skill。实时音频是核心人机交互层，不是机器人 Nav2 控制能力。

## R7 与 R8 的根本区别

R7 的浏览器会在录制过程中上传 WebM/Opus 音频片段，但**第三方 ASR 供应商要等音频录制完成后才开始处理**。R8 增加独立的实时语音通道：

1. 用户手动选择“开始实时转写（实验）”并批准浏览器麦克风权限；需要家长对当前学习者明确开启 `voiceInputAllowed` 和 `cloudAudioInputAllowed`。
2. 浏览器 `AudioWorklet` 采集 PCM 浮点样本，用基本重采样变换为 24 kHz 单声道 PCM16，小约 100ms、4,800 字节/帧（输入可能是 44.1/48 kHz；生产质量仍需 DSP 验收）。
3. 每个 PCM 帧经同源 `POST /api/audio/realtime/frame` 实时送到 Alex，序号连续，等待 HTTP ACK；每个孩子拥有独立的临时会话 ID。服务端**不将 PCM 拼接成完整音频**。
4. Alex 使用经过身份与权限校验的服务端连接，以 TLS WebSocket（WSS）向当前音频供应商发送 `input_audio_buffer.append`。在用户继续讲话时就开始转写。
5. 上游的 `conversation.item.input_audio_transcription.delta` 返回增量文字，Alex 仅通过该孩子认证后的 `GET /api/audio/realtime/status` 返回最多 500 字的**临时文字预览**，不自动调用聊天、Skill 或设备。
6. 用户手动停止或选择能量型 VAD 静音停录后，浏览器冲刷最后 PCM 帧并等待其 ACK，再由 Alex 调用 `input_audio_buffer.commit`，收到最终 `conversation.item.input_audio_transcription.completed`。
7. 最终转写只填入文字输入框。**还必须由用户检查并第二次点击“发送”**，才能进入正常 Agent/Skill 对话；不存在将语音流自动转发为设备指令的路径。

**这才是“实时上游转写”**，但是仍然不是“全双工实时 AI 语音聊天”。当前不从同一个 WSS 生成/播放增量语音回复，不做真正实时语音对话抢话；既有 R6 独立按需 TTS 能力仍可使用。

## Provider 与配置

默认 `ALEX_REALTIME_PROVIDER=disabled`。只有管理员在本地服务端明确配置以下变量才启用该实验模块：

```bash
AUTH_MODE=local
ALEX_REALTIME_PROVIDER=openai-transcription
ALEX_REALTIME_URL='wss://api.openai.com/v1/realtime?intent=transcription'
ALEX_REALTIME_ASR_MODEL='gpt-live-transcribe'
ALEX_REALTIME_API_KEY='your-private-server-side-key'
```

此模型与事件格式参考供应商当前公开文档：
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/reference/resources/realtime/client-events

与普通 Text Chat 配置、R6 批量音频 Provider 是不同的独立服务；即使 `ALEX_AUDIO_PROVIDER=disabled`，也可单独试验 R8 实时转写。R7 WebM/Opus **不能当作 R8 原始 PCM16** 使用：两者分别有各自的 MIME、API 和类型校验。密钥不会发给浏览器、写入 API 响应或加入隐私导出。

本批的 TLS Upgrade 是服务端调用 Node `https.request`（先按 HTTPS 请求握手，再升级到 WSS），验证响应 `101`、`Sec-WebSocket-Accept`、不允许意外扩展，客户端帧使用 RFC6455 随机掩码，限制上游文字事件和 socket 缓存，并处理关闭、ping/pong 和中断。仅允许管理员配置的 WSS 非本机主机；目前不包括分布式音频网关或多供应商自动故障切换。

## API 契约

所有路由需 `AUTH_MODE=local`、经验证的登录 Cookie、已有同源/Host 保护。儿童身份不能通过请求体指定其他孩子的 ID。

| 方法与接口 | 用途与约束 |
| --- | --- |
| GET /api/audio/realtime/capabilities | 只返回当前身份的可用状态、PCM 类型、上限、手动提交要求、是否已启用 WSS，不含密钥 |
| POST /api/audio/realtime/start | JSON `{language:'zh'|'en'}` → 经过授权后建立独立 WSS，返回临时会话 ID |
| POST /api/audio/realtime/frame | `application/octet-stream` 原始 24k PCM16 小帧；头 `X-Alex-Realtime-Id` 和 `X-Alex-Frame-Seq`，连续编号和已验证身份归属 |
| GET /api/audio/realtime/status?id=… | 当前本人临时会话的阶段、序号、字节数及不超过 500 字的可变转写预览；不能跨孩子读取 |
| POST /api/audio/realtime/commit | JSON `{id}`，等最后帧 ACK 后触发上游 commit，得到最终文本及无内容指标；不自动发送聊天 |
| POST /api/audio/realtime/cancel | JSON `{id}`，只中止当前身份的 WSS 会话 |
| GET /api/audio/realtime/metrics | 本人非内容计数和耗时（无原始音频、无转写正文），家长隐私擦除一并删除 |

## 资源、超时与数据隔离

- 最大 **4 个并行实时转写会话**，每个验证身份同时最多 1 个，每身份每分钟最多新建 6 个。
- 每帧 PCM16 **2～9,600 字节且偶数对齐**，每个会话累计最多 **720,000 字节**（对应按 24k/16-bit/mono 理论约 15s 的 PCM 负载）。
- 录制阶段约 16s 会话上限、10s 无新数据超时；最终转写另给 35s，避免正常供应商延迟被录制超时错误取消。
- WSS 上游单消息最大 128 KiB，客户端发送缓冲上限约 192 KiB；达到边界即拒绝/中断，避免无界内存积压。
- 学习者切换、页面隐藏、点击取消、家长撤销录音权限、删除档案或隐私擦除均触发 best-effort 中断和临时内容清理。已发给云端供应商的 PCM 不能通过本机取消回收。
- 原始 PCM 在 AudioWorklet 和短请求中临时流动，服务端不写入文件、不加入家庭记忆和课程成果，最终显示给用户的文字不自动持久化；但外部供应商可能依据其自己的策略保留数据。
- 每个身份的审计仅记录 `audio.realtime.commit` 事件和身份元数据，不记录录音正文、声纹、逐帧内容或 API 密钥。

**真实风险：** 服务端知道收到的 PCM 字节数，但尚不能证明客户端确实以 24 kHz 采集或进行了准确抗混叠重采样。当前客户端重采样是简单的线性近似，不是生产级数字信号处理；音色、口音、噪声、网络抖动可能影响识别。该接口只用于受控本地试验，不应该作为公网、语音身份验证或对儿童语言能力的测评依据。

## 验收证据等级

本批测试包括：
- WSS RFC6455 握手、证书通道升级、掩码、拆包/分片、服务端错误、限制与背压；
- 实时 Provider `session.update → append → delta → commit → completed`，包括撤销权限及无效数据拒绝；
- 两个学习者的权限隔离、序号重放拦截、取消、会话超时、限流和非内容指标清除；
- 模拟真实 Node localhost HTTP、HTTPS 升级与 WSS 事件的完整协议链路，外部实时供应商由测试专用 Fixture 截获，未连接真实云模型；
- 浏览器 AudioWorklet 的样本转换、帧冲刷/静音、模拟上游转写、麦克风权限取消及不自动聊天；
- 既有 R1–R7、Nav2 静态 preflight 回归。

**仍未验收：** 实际浏览器中 Chrome/Edge/Safari 的 AudioWorklet、用户麦克风环境、真实供应商的转写准确率和首字时延、音频单调采样/重采样质量、网络波动及成本。模拟 WSS 返回很快不等于实际低延迟。真实使用前必须确认供应商对儿童音频数据的许可、处理区域、留存和删除政策。

## 下一轮建议

R9 重点应该转向真正的**双向实时语音响应**：下行流式 TTS/音频播放、网络抖动缓冲、说话打断和听到哪里截断、语音轮次与 AI 文本状态一致性；加上可信音频处理、实际延迟 P50/P95/P99、供应商预算、加密身份隔离和正式隐私验收。仍不强依赖 ROS2 实体机器人。
