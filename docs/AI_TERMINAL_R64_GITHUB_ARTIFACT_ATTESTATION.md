# Alex R64 — GitHub Actions ROS Artifact Attestation

## 目标

R60–R63 已把 route、cancel、recovery、Node→Python→Nav2 bridge 四类 Gazebo 证据绑定到同一次 GitHub Actions Run/Attempt/Commit SHA。但 workflow-evidence-bundle.json 仍生成于 Artifact 上传之前，因此不能证明“上传到 GitHub 的不可变 Artifact”与本地验证过的文件完全一致。

R64 增加第二层证据：在主 ROS Artifact 成功上传之后，读取 actions/upload-artifact 返回的 artifact-id 与 artifact-digest，生成独立 artifact-attestation.json，并把该证明作为第二个 Artifact 上传。

## 不升级现有 Action

仓库继续使用现有 actions/upload-artifact@v4，不做依赖版本升级。v4 的上传结果提供 artifact-id 与 artifact-digest，Artifact 上传后不可修改。R64 只消费这些已有输出。

由于证据路径位于 .local/ros，属于隐藏目录，Workflow 对两个上传步骤都显式设置 include-hidden-files=true；上传路径仍是固定白名单，不使用整个 .local 目录通配，避免把无关或敏感文件带入 Artifact。

## 成功 Workflow 顺序

1. 执行 route / cancel / recovery / bridge 四类 Gazebo 验收。
2. 组装并验证 workflow-evidence-bundle.json。
3. 使用 actions/upload-artifact@v4 上传 alex-ros-gazebo-acceptance。
4. 从该 upload step 读取 artifact-id 和 artifact-digest。
5. write-ros-artifact-attestation.py 对五份关键 JSON 做 SHA-256：
   - acceptance-report.json
   - cancel-acceptance-report.json
   - recovery-acceptance-report.json
   - bridge-acceptance-report.json
   - workflow-evidence-bundle.json
6. 证明同时绑定 GitHub Run ID、Run Attempt、Commit SHA、Workflow Ref、Job 和 Artifact ID/Digest。
7. 本地立即运行 verify-ros-artifact-attestation.py 再校验一次。
8. 将 artifact-attestation.json 单独上传为 alex-ros-gazebo-attestation。

如果前面的 Gazebo 验收失败，原有主 Artifact 仍会按 always() 上传诊断数据，但不会生成成功 attestation。

## 离线审核

下载主 ROS Artifact 与 attestation Artifact 后，还必须从 GitHub Actions UI/API 独立取得对应的 Artifact ID、Artifact SHA-256 Digest、Workflow Run ID、Run Attempt 和 Commit SHA，然后执行：

    npm run sim:artifact-verify -- \
      --attestation <attestation>/artifact-attestation.json \
      --folder <downloaded-main-artifact> \
      --artifact-id <GitHub Artifact ID> \
      --artifact-digest <GitHub Artifact SHA-256 Digest> \
      --run-id <GitHub Actions Run ID> \
      --attempt <Run Attempt> \
      --commit-sha <40-char Commit SHA>

验证器重新计算下载后五份关键 JSON 的 SHA-256 和字节数。任何文件被替换、截断、缺失或改为软链接都会失败。

## Runtime Gate

新增独立门槛：GAZEBO_ACTIONS_ARTIFACT_ATTESTATION。

只有完整提供以下参数时 Gate 才尝试核验：

- --ros-artifact-attestation
- --ros-artifact-folder
- --ros-artifact-id
- --ros-artifact-digest
- --ros-artifact-run-id
- --ros-artifact-attempt
- --ros-artifact-sha

缺少任一字段直接作为参数错误；摘要或文件不一致则 ros_artifact_attestation=invalid 并使 Gate blocked。

即使 Artifact attestation 通过，也不会解除 route、cancel、recovery、bridge、真实语音或 PHYSICAL_SAFETY_REVIEW 等其他独立门槛。

## 信任边界

Artifact attestation 证明的是：调用方提供的 GitHub Artifact 元数据与 attestation 一致，且下载后的关键证据文件与上传时记录的内容哈希一致。

它仍不能单独证明自托管 Runner 本身可信，因为具有 Runner/工作区控制权的执行者可能在上传前伪造内容。最终审核仍需结合 GitHub Actions 的仓库权限、Runner 配置、Workflow 历史、Run/Attempt、Commit SHA 和 Artifact 元数据。

它也不构成实体机器人或物理安全认证。