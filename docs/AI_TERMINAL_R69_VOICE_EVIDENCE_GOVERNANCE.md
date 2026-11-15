# Alex R69 — Voice Provider Evidence Governance

## 目标

R56 已经能对真实 ASR → streamed LLM → PCM TTS → provider revocation/usage 做隐私安全运行时验收，但原 Voice Workflow 只上传一个 `.local/voice/runtime-report.json`，没有 Run/Attempt/Commit 绑定，也没有 Artifact ID/Digest 回读、attestation、coherent set 或最终 publication audit。

R69 不修改 ASR/LLM/TTS 业务逻辑，而是把真实 Voice Provider 报告升级成与 ROS 证据链一致的发布级治理结构。

## Workflow 三阶段

1. `approval-gate`：GitHub-hosted；`ALEX_VOICE_ACCEPTANCE_APPROVED` 必须严格等于 `true`，否则明确失败，拒绝消费供应商额度。
2. `voice-provider`：GitHub-hosted producer；执行真实 provider 验收、报告验证、Workflow evidence、主 Artifact、GitHub readback、Artifact attestation 和 coherent set。
3. `publication-audit`：只在 producer 成功后执行；通过 GitHub Actions REST API 外部核对 producer Job 与两个最终 immutable Artifact。

原来的 job-level `if: vars.ALEX_VOICE_ACCEPTANCE_APPROVED == 'true'` 被移除，避免未批准时整个 Workflow 只显示 skipped。

## 隐藏目录上传修复

Voice 报告位于 `.local/voice`。`actions/upload-artifact@v4` 新版本默认不会自动包含隐藏文件/目录，因此 R69 对两个固定 Artifact 都显式设置：

`include-hidden-files: true`

同时仍使用固定文件清单，不做 `.local/**` 宽泛上传，避免把其它本地状态或敏感文件带进 Artifact。

## Workflow evidence

`scripts/voice-workflow-evidence.py` 在 provider 调用前先 `--reset`，生成 `blocked` evidence；真实报告完成并通过既有严格 `verify-voice-runtime-report.mjs` 后再 `--collect`。

assembled evidence 绑定：

- GitHub Run ID
- Run Attempt
- Commit SHA
- workflow ref
- job=`voice-provider`
- runner environment=`github-hosted`
- Voice 内部 `run_id`
- `runtime-report.json` 文件大小和 SHA-256

因此旧报告、跨 Run 报告、被修改但业务上仍“看起来合法”的报告都不能直接复用。

## 主 Artifact 与 failure diagnostics

主 Artifact 名：

`alex-voice-provider-runtime-evidence`

成功时固定包含：

- `.local/voice/runtime-report.json`
- `.local/voice/workflow-evidence.json`

主 upload step 使用 `if: always()`，保留原有失败诊断能力。如果 provider 调用失败，脚本仍会写 privacy-safe failed report，Workflow evidence 保持 blocked；失败 Artifact 可以用于排查，但后续 readback/attestation/coherent set/final audit 全部不会继续执行，因此失败证据不能被升级为通过。

## GitHub Actions readback

`scripts/github-actions-voice-readback.py` 只读调用当前 Run 的 GitHub Actions API，核对：

- repository / workflow / branch
- Run ID / Attempt / Commit SHA
- 当前 Workflow 仍为 in_progress
- 当前 upload step 输出的 Artifact ID
- GitHub API 返回的 `sha256:<digest>`
- Artifact size > 0、未过期
- Artifact 属于当前 Run 和 Commit

Artifact 使用 upload step 返回的 ID 精确选择，因此 Workflow rerun 下即使保留历史同名 Artifact，也不会误判当前 evidence。

Token 只用于 HTTP Authorization，不进入可序列化 metadata。

## Artifact attestation

`scripts/write-voice-artifact-attestation.py` 在主 Artifact 上传并 readback 成功后生成：

`alex.dev/voice-artifact-attestation/v1`

它绑定：

- 主 Artifact ID
- 主 Artifact Digest
- Run / Attempt / Commit
- `runtime-report.json` SHA-256
- `workflow-evidence.json` SHA-256

随后 `verify-voice-artifact-attestation.py` 使用调用方提供的外部 Artifact metadata 和本地下载文件重新验证。

## Coherent evidence set

`scripts/verify-voice-evidence-set.py` 把 runtime report、Workflow evidence、Artifact attestation 和 GitHub readback 当作一个整体验证，要求所有上下文完全一致。

它禁止：

- 把 Run A 的 runtime report 与 Run B 的 attestation 拼接；
- 把另一个 Attempt 的 evidence 混入；
- 把不同 Commit 的合法文件拼成一个发布集合；
- 用修改后的 runtime report 继续沿用旧 Workflow/Artifact 哈希。

## 第二 Artifact 与最终审计

第二 Artifact：

`alex-voice-provider-runtime-attestation`

固定包含：

- `.local/voice/artifact-attestation.json`
- `.local/voice/github-actions-readback.json`

producer 成功后，独立 `publication-audit` Job 通过 REST API 核对：

- `voice-provider` 已 completed + success；
- producer 和 auditor 都运行在 `ubuntu-latest`；
- 两个 Artifact ID/Digest 与 producer step outputs 完全一致；
- 两个 Artifact 都属于当前 Run/Commit、未过期、size > 0；
- attestation Artifact 创建时间不早于主 evidence Artifact；
- producer 完成时间不晚于 audit Job 开始时间。

最终 audit 不再上传第三个证明 Artifact，避免产生无限递归的“证明证明本身”问题；Workflow 的最终 GitHub-hosted audit Job success 作为终点。

## Runtime Gate

新增四个 Voice 治理门槛：

- `VOICE_PROVIDER_WORKFLOW_EVIDENCE`
- `VOICE_ACTIONS_ARTIFACT_ATTESTATION`
- `VOICE_PROVIDER_COHERENT_EVIDENCE_SET`
- `VOICE_GITHUB_ACTIONS_READBACK_AUDIT`

仅提供旧的 `--voice-report + --voice-run-id` 时，只能解除：

`REAL_ASR_LLM_TTS_PROVIDER_E2E`

不能解除上述治理门槛。

只有完整 `--voice-evidence-*` coherent set 通过后，Runtime Gate 才标记：

- `voice_real_provider = verified-by-set`
- `voice_workflow_evidence = verified-by-set`
- `voice_artifact_attestation = verified-by-set`
- `voice_github_readback = verified-by-set`
- `voice_evidence_set = verified-coherent`

并同时解除五项 Voice 软件运行证据缺口。

## 隐私与信任边界

R69 延续 R56 的隐私边界：真实 Workflow 只使用固定 synthetic phrase，不读取儿童真实录音或对话；报告不保存原始音频、转录正文、LLM 回复正文或供应商凭据。

R69 证明的是 GitHub-hosted Workflow 中真实云端 provider 协议链与不可变 Artifact 的一致性。它仍然明确不证明：

- 真实麦克风 acoustic capture；
- 真实扬声器播放；
- 儿童真实会话体验；
- 实体机器人安全；
- release approval。

因此 `acoustic_capture_verified=false`、`physical_safety_certified=false`、`release_approved=false` 保持不变。