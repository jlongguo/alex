# R78：Full Voice Turn Physical E2E

## 目标

R56 证明真实 Provider ASR/LLM/TTS，R76/R77 证明真实 ALSA 物理声学路径，但两者此前不是同一 Turn。

R78 把它们组合为一个真实物理回路：

```text
Provider PCM seed
  ↓
ALSA speaker
  ↓
physical acoustic path
  ↓
ALSA microphone capture
  ↓
ASR
  ↓
streamed LLM
  ↓
PCM TTS
  ↓
ALSA speaker
  ↓
microphone playback proof
```

报告 schema：`alex.dev/full-voice-turn-acceptance/v1`。

## 隐私边界

报告不保存原始 WAV/PCM、转录文本、模型回复文本、设备原始标识或凭据。临时音频只存在于隔离临时目录，流程结束后删除。

## 当前证明边界

R78 的成功报告证明同一 GitHub Actions Run/Attempt/Commit 中物理输入、真实 Provider 链与物理输出均完成。

它仍不是 Release Permit，也不等于实体机器人 Physical Safety；进入正式软件候选前仍需像 R77 一样增加 Artifact attestation/readback/coherent evidence governance。
