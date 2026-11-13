# Alex R63 — Node → Python → Nav2 真实桥接运行验收

## 目标

R63 补齐产品实际导航调用链的独立运行证据：Node Nav2SimulationBridge 启动 Python nav2_action_client.py，由 rclpy ActionClient 调用 Nav2 /navigate_to_pose，并在隔离 Gazebo 中连续完成 study_desk → dock。

这条证据与既有三段 ROS/TF/odom 路线、取消停止、取消后恢复相互独立，不能互相替代。

## 执行链

    Node Nav2SimulationBridge
      -> JSONL child process
      -> Python nav2_action_client.py
      -> rclpy ActionClient
      -> Nav2 /navigate_to_pose
      -> Gazebo

同一个 Node 桥实例依次导航到 study_desk 和 dock。每段必须出现 planning、至少一个 moving、恰好一个 arrived；反馈 sequence 连续；最终 progress=100；桥最终 active=false 且 stopUnconfirmed=false。

## 注入测试与真实报告严格分离

普通 CI 可以注入 Fake Bridge 测试报告生成状态机，但这类报告固定标记：

    source = node-python-nav2-injected-test
    execution_class = injected-test
    runtime_chain = injected-bridge-test

真实默认实现才允许标记：

    source = node-python-nav2-live
    execution_class = live-gazebo
    runtime_chain = node->python-rclpy->nav2-action

verify-nav2-bridge-live-report.py 明确拒绝 injected-test，因此单元测试不能直接生成可冒充真实 Gazebo 的 PASS 报告。

## 手动运行

仅允许 ROS Jazzy、ALEX_ROS_SIMULATION_ONLY=1、ALEX_RUN_ROS_INTEGRATION=1、ROS_DOMAIN_ID=77、ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST 的隔离环境。

运行命令：

    npm run sim:accept-bridge

产物：

- .local/ros/bridge-acceptance-report.json
- .local/ros/bridge-acceptance-launch.log
- .local/ros/bridge-preflight.json
- .local/ros/bridge-diagnostics.json

验证命令：

    npm run sim:verify-bridge-report -- --report .local/ros/bridge-acceptance-report.json --run-id <run_id>

## Workflow 与 Bundle

手动 ROS Workflow 当前按顺序执行：三段路线、取消停止、取消后恢复、Node→Python→Nav2 bridge，之后才组装 workflow-evidence-bundle.json。

R60 Bundle 已扩展为四份报告：route、cancel、recovery、bridge。四份报告必须全部来自本次 Workflow reset 之后，run ID 互不重复，并通过各自严格验证器。

## Runtime Gate

新增门槛 GAZEBO_NODE_PYTHON_NAV2_BRIDGE_RUNTIME。即使桥报告通过，也不会解除 GAZEBO_NAV2_THREE_LEG_RUNTIME、GAZEBO_NAV2_CANCEL_RUNTIME、GAZEBO_NAV2_RECOVERY_RUNTIME、GAZEBO_NAV2_WORKFLOW_EVIDENCE_BUNDLE、REAL_ASR_LLM_TTS_PROVIDER_E2E 或 PHYSICAL_SAFETY_REVIEW。

## 证据边界

R63 final pose 来源是 Nav2 feedback 经 Node 桥映射到 Alex 网格，因此报告固定 independent_tf_verified=false。它证明产品 Node→Python→Nav2 链路实际执行，不是第二份独立 TF 到达证明。

JSON 与 SHA-256 也不能单独认证自托管 Runner。真实交付仍需对账 GitHub Actions Run、Artifact、Commit SHA、Run Attempt 和受控 Runner 配置。

R63 仍是 Gazebo 仿真测试，不证明实体机器人急停、驱动断电、碰撞安全或真实家庭环境物理安全。
