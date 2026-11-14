# Alex R66 — GitHub Actions Run / Artifact 只读回读审计

## 根因

R64/R65 已把 upload-artifact 的 step 输出、Workflow Bundle、Artifact attestation 和 coherent evidence set 绑定起来，但外部 Artifact ID/Digest 仍主要依赖调用方输入。

GitHub REST API 实际返回的 Run 与 Artifact 记录可以作为另一条只读对账来源。R66 在主 ROS Artifact 上传后，使用当前 Workflow 的只读 GITHUB_TOKEN 回读当前 Run 和 Artifact，再把结果纳入 coherent set。

## 实测 API 形状

仓库现有 GitHub Actions Artifact API 返回字段包括 id、name、size_in_bytes、expired、digest、created_at、updated_at、workflow_run。其中 REST digest 形式为 sha256:<hex>。

actions/upload-artifact@v4 官方 README 的 artifact-digest step 输出则是纯 64 位 SHA-256 hex。因此 R66 对两种表示做严格规范化；算法必须是 sha256，最终值仍必须是 64 位小写 hex。

## 只读网络范围

生产 audit 模式只允许 GET：

- https://api.github.com/repos/jlongguo/alex/actions/runs/<run_id>
- https://api.github.com/repos/jlongguo/alex/actions/runs/<run_id>/artifacts?per_page=100

不接受调用方自定义 API host，不执行 POST / PUT / PATCH / DELETE，不打印 GITHUB_TOKEN。

Workflow 权限从仅 contents:read 扩展为：

- contents: read
- actions: read

没有写权限。

## 回读条件

github-actions-ros-readback.py 要求：

- GITHUB_ACTIONS=true
- event=workflow_dispatch
- repository=jlongguo/alex
- job=nav2-simulation
- RUNNER_ENVIRONMENT=self-hosted
- workflow ref 指向 ros-sim-acceptance.yml 的 heads ref
- REST Run ID / Run Attempt / head SHA 与环境完全一致
- Run event/name/path/head branch 完全匹配
- 读取时 Run 必须是 in_progress + null conclusion，或 completed + success
- 当前 Run 内 alex-ros-gazebo-acceptance Artifact 必须恰好一份
- Artifact ID 必须等于 upload-artifact step 输出
- REST sha256 Digest 规范化后必须等于 upload-artifact step 输出
- Artifact 未过期、size > 0
- Artifact 内嵌 workflow_run.id/head_sha 与当前 Run 一致。

## Artifact 刚上传后的传播延迟

主 Artifact 上传后，REST 列表可能短暂还未出现目标 Artifact。R66 只对以下两种可解释的传播状态做有界重读：

- 目标 Artifact 尚未唯一出现
- REST digest 尚未可用

最多 4 次，每次间隔 2 秒。其他 Run、Workflow、Digest、过期状态等错误立即失败，不进入重试。

## 生成报告

成功后生成：

.local/ros/github-actions-readback.json

schema：alex.dev/github-actions-ros-readback/v1。

报告记录 GitHub REST 读到的 Run、Artifact ID、规范化 SHA-256、原始 api_digest、Artifact 大小、读取时 Run 状态和 API 版本；同时固定：read_only=true、simulation_only=true、release_approved=false、physical_safety_certified=false。

## 与 coherent evidence set 绑定

R65 verify-ros-evidence-set.py 现在额外要求 --github-readback。

统一集合必须同时通过：

1. 四类 route/cancel/recovery/bridge 严格验证；
2. workflow-evidence-bundle 校验；
3. artifact-attestation 校验；
4. github-actions-readback 校验；
5. Bundle / Attestation / Readback 的 repository、workflow、workflow_ref、job、Run ID、Attempt、Commit SHA、runner_environment 一致；
6. Attestation 与 Readback 的 Artifact ID / SHA-256 一致。

因此另一 Run、另一 Attempt 或另一 Commit 的 GitHub readback 不能被拼入已有 evidence set。

## Runtime Gate

发布级 coherent set 参数新增：

--ros-evidence-github-readback <github-actions-readback.json>

该字段与其余 coherent set 参数必须一次完整提供。

成功时新增：

ros_github_readback = verified-by-set

并解除 GAZEBO_GITHUB_ACTIONS_READBACK_AUDIT。

仍保留 REAL_ASR_LLM_TTS_PROVIDER_E2E 与 PHYSICAL_SAFETY_REVIEW。

## 第二个 Artifact

alex-ros-gazebo-attestation 现在同时上传：

- artifact-attestation.json
- github-actions-readback.json

主 ROS Artifact 仍保持原固定白名单。

## 信任边界

R66 证明 GitHub REST API 在 Workflow 执行期间实际返回的 Run/Artifact 元数据与本地 evidence set 一致，减少人工抄写元数据造成的错误和跨 Run 拼接空间。

它仍不能证明 self-hosted Runner 没有被控制，也不能把 Gazebo 仿真升级为实体机器人安全认证。第二个 attestation Artifact 自身的独立外部 Digest 对账仍可以在后续迭代继续收紧。