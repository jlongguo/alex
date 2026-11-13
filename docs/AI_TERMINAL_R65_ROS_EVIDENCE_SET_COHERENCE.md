# Alex R65 — ROS 发布证据集合一致性

## 根因

R60–R64 已经分别具备严格报告验证、Workflow Bundle、Node→Python→Nav2 bridge 证据和 GitHub Artifact attestation，但 Runtime Gate 仍允许这些证据通过独立参数分别传入。

因此理论上可以把 Run A 的 route/cancel/recovery/bridge、Run B 的 workflow bundle、Run C 的 artifact attestation 分别验证为有效，然后组合成一个看似完整的发布判断。每个文件都可能是真的，但它们不是同一次运行的同一证据集合。

R65 修复的是这个跨证据拼接问题。

## 新增 coherent evidence set

新增 scripts/verify-ros-evidence-set.py。它不复制已有业务阈值，而是复用：

- ros-workflow-evidence-bundle.py：重算同一目录 route/cancel/recovery/bridge 四份报告，并调用各自严格 verifier；
- verify-ros-artifact-attestation.py：重算主 Artifact 中五份关键文件的哈希，并核对 Artifact ID/Digest；
- GitHub 外部元数据：Workflow Run ID、Run Attempt、Commit SHA、Artifact ID、Artifact Digest。

统一校验器还要求 bundle context 与 attestation context 在 repository、workflow、workflow_ref、job、workflow_run_id、workflow_run_attempt、commit_sha、runner_environment 上逐项完全一致。

## 固定证据目录

发布级 coherent set 的主 Artifact 目录必须同时包含固定文件：

- acceptance-report.json
- cancel-acceptance-report.json
- recovery-acceptance-report.json
- bridge-acceptance-report.json
- workflow-evidence-bundle.json

文件不得是软链接。Bundle 中记录的四个 scenario run_id 必须和对应报告内部 run_id 完全一致。

attestation 仍来自独立的 alex-ros-gazebo-attestation Artifact。

## Runtime Gate 两种模式

旧的单项参数模式继续保留，用于诊断某个 route、cancel、recovery、bridge、bundle 或 attestation 为什么失败。

发布级 ROS 判断新增 coherent set 模式：

    npm run release:runtime-evidence -- \
      --ros-evidence-folder <downloaded-main-artifact> \
      --ros-evidence-attestation <downloaded-attestation>/artifact-attestation.json \
      --ros-evidence-artifact-id <GitHub Artifact ID> \
      --ros-evidence-artifact-digest <GitHub Artifact Digest> \
      --ros-evidence-run-id <GitHub Workflow Run ID> \
      --ros-evidence-attempt <Run Attempt> \
      --ros-evidence-sha <Commit SHA>

这七项必须一次完整提供。

coherent set 模式禁止同时传入另一组单项 ROS route/cancel/recovery/bridge/bundle/artifact 参数。这样不能在统一发布判断中偷偷替换某一个证据来源。

## Gate 结果

统一集合通过后：

- ros_evidence_set = verified-coherent
- ros_runtime = verified-by-set
- ros_cancel_runtime = verified-by-set
- ros_recovery_runtime = verified-by-set
- ros_bridge_runtime = verified-by-set
- ros_workflow_bundle = verified-by-set
- ros_artifact_attestation = verified-by-set

并移除对应的七项 Gazebo/ROS 证据缺口。

仍然保留：

- REAL_ASR_LLM_TTS_PROVIDER_E2E
- PHYSICAL_SAFETY_REVIEW

因此 coherent set 不能把仿真运行证据升级为真实语音验收或实体机器人安全认证。

## Workflow

手动 ROS Workflow 在主 Artifact 上传、attestation 生成并单独验证之后，会在上传 attestation Artifact 之前额外执行 verify-ros-evidence-set.py。

这保证成功 Workflow 自己也必须满足 bundle、attestation 和外部 Actions 元数据之间的一致性。

## 信任边界

R65 防止的是合法证据之间的跨 Run、跨 Attempt、跨 Commit、跨 Artifact 拼接，以及单个报告被另一份业务上仍合法的报告替换。

它仍不能认证 self-hosted Runner 本身没有被控制，也不能证明物理机器人安全。Runner 信任、仓库权限、Workflow 历史和实体安全仍需独立审核。