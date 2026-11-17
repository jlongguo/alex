# R76：Real Acoustic I/O Acceptance Harness

## 目标

R56/R69 已验证真实云端 ASR → LLM → PCM TTS，但输入来自 Provider 合成音频，因此不能证明麦克风真的可采集、扬声器真的可输出，以及当前设备的物理音频路径能闭环。

R76 不修改 Provider 验收语义，而增加独立物理层证据。

## 真实执行链

manual workflow_dispatch
→ approval-gate
→ self-hosted / linux / x64 / alex-acoustic
→ 生成 731Hz + 1103Hz + 1667Hz 校准 WAV
→ aplay → 真实扬声器
→ 空气/物理声学路径
→ arecord ← 真实麦克风
→ PCM16 / 48k WAV parser
→ RMS + clipping + Goertzel 多频检测
→ alex.dev/acoustic-io-acceptance/v1
→ Runtime Gate acoustic_io=verified-self-hosted
→ Release Matrix realAcousticIo=pass

## 防伪边界

- GitHub Hosted runner 不能得到真实声学通过。
- 必须是 RUNNER_ENVIRONMENT=self-hosted。
- Job 必须是 acoustic-io。
- 必须显式设置 ALEX_ACOUSTIC_PHYSICAL_PATH_APPROVED=true。
- 设备原始名称不写入报告，只保存 SHA-256 指纹。
- WAV 只存在临时目录，验收结束即删除。
- synthetic/fake mode 的报告 verifier 明确拒绝。
- Evidence 必须绑定 Run / Attempt / Commit。
- 物理声学通过不等于实体机器人安全认证。

## 仍未闭环

1. 真实 Voice Provider workflow 尚未 dispatch。
2. 真实 ROS/Gazebo self-hosted workflow 尚未 dispatch。
3. R76 acoustic workflow 尚需在带麦克风/扬声器的真实 runner 上执行。
4. 仍缺同一轮真实麦克风 → ASR → LLM → TTS → 扬声器的组合 E2E。
5. 真实家庭/儿童 Pilot。
6. 实体机器人 Physical Safety。
