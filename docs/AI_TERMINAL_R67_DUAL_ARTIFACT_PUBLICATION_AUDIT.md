# Alex R67 — 双 Artifact 最终发布审计与审批 Fail-Closed

## 本轮闭环

R66 已经能够在 self-hosted ROS Job 内回读主 evidence Artifact，但第二个 alex-ros-gazebo-attestation Artifact 上传后还没有独立外部核验。继续生成第三个证明 Artifact 会产生无限递归，因此 R67 改成最终 GitHub-hosted publication-audit Job。

## Workflow 结构

手动 ROS Workflow 现在有三个阶段：

1. approval-gate（GitHub-hosted）：ALEX_SIM_RUNNER_APPROVED 必须严格等于 true，否则 Workflow 明确失败；
2. nav2-simulation（self-hosted）：执行 Gazebo/Nav2 四类验收、Bundle、主 Artifact、GitHub readback、attestation，并上传第二个 Artifact；
3. publication-audit（GitHub-hosted）：只在 nav2-simulation 成功后运行，从 GitHub REST API 外部核验 producer Job 与两个 Artifact。

这样未批准时不再通过 job-level if 静默 skipped；最终 Workflow 成功也必须经过独立 GitHub-hosted 审计。

## publication-audit 核验内容

生产脚本 scripts/github-actions-ros-publication-audit.py 只读访问当前 Run 的：

- Run API
- Artifacts API
- Jobs API（filter=latest）

并要求：

- 当前 Run ID / Attempt / Commit SHA / workflow / branch 完全一致；
- Workflow 读取时仍为 in_progress，结论为 null；
- producer nav2-simulation 已 completed + success；
- producer Job 的 labels 至少包含 self-hosted、linux、x64、alex-ros-sim；
- producer runner_name 非空；
- 当前 publication-audit Job 为 in_progress，并运行在 ubuntu-latest；
- producer completed_at 不晚于 auditor started_at；
- alex-ros-gazebo-acceptance 与 alex-ros-gazebo-attestation 各恰好一份；
- 两个 Artifact ID 不得相同；
- 两个 Artifact ID/Digest 必须等于 upload-artifact step 输出；
- REST sha256:<hex> 与 step 输出的纯 hex 规范化后完全一致；
- 两个 Artifact 都未过期、size > 0、属于当前 Run 与 Commit；
- attestation Artifact 创建时间不早于主 evidence Artifact。

## API 传播延迟

只对可解释的传播状态做最多 4 次、每次 2 秒的有界重读：

- Artifact 尚未出现；
- Artifact Digest 暂不可用；
- producer/auditor Job 记录暂未出现；
- 当前 auditor Job 尚未从 queued 刷新到 in_progress。

重复 Artifact、错误 Digest、错误 Run、producer 失败、labels 不符等配置或证据错误立即失败，不进入重试。

## 为什么不上传第三个 Artifact

publication-audit.json 只存在于最终 GitHub-hosted 审计 Job 的工作区，并通过同一脚本立即离线验证；最终结果写入 Job log 与 GITHUB_STEP_SUMMARY。

如果再把 publication-audit.json 上传成第三个 Artifact，就需要再证明第三个 Artifact 自身，形成没有终点的递归证明链。R67 以 GitHub-hosted final Job 成功 + GitHub REST 双 Artifact 对账作为终点。

## 信任边界

R67 比 R66 更强，因为最终 Artifact 审计不再由执行 Gazebo 的 self-hosted Runner 自己完成，并且 Jobs API 外部核对了 producer success 与 runner labels。

但 runner labels / runner_name 仍不是硬件可信证明。self-hosted Runner 是否被控制、基础镜像/ROS 安装是否被篡改，仍属于后续 runner provenance / immutable environment 闭环。

Gazebo 证据依旧不能替代真实语音 E2E 和实体机器人 PHYSICAL_SAFETY_REVIEW。