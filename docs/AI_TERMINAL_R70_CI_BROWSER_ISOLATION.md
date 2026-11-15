# Alex R70 — CI Execution Isolation 与 Chromium CDP 启动稳定化

## 根因背景

R69 的主测试连续两次实测 `792/792 PASS`，但同一 HEAD 的 Browser acceptance 连续两次失败，错误均为：

`R54_CHROME_DEVTOOLS_NOT_READY`

同时 Chromium stderr 重复出现 GitHub hosted runner 的 D-Bus session 地址解析失败。由于旧 `ci.yml` 把 `npm test`、`test:browser`、`sim:check`、`sim:preflight` 串在同一个 Job，Browser 一旦失败，两个 ROS 静态检查就被直接跳过，导致一个失败域遮蔽其它验证结果。

R70 只修 Browser 启动握手与 CI 拓扑，不修改家庭 UI、认证、Voice Provider、Nav2 或 ROS runtime 业务逻辑。

## Chromium 启动握手

旧实现：

- `--remote-debugging-port=0`；
- 等 Chromium 写 `DevToolsActivePort` 文件；
- 从文件读取随机端口；
- 再访问 `/json/list`。

新实现：

- 先由 Node 在 `127.0.0.1` 取得一个空闲端口；
- Chromium 使用显式 `--remote-debugging-address=127.0.0.1`；
- Chromium 使用显式 `--remote-debugging-port=<port>`；
- readiness 直接轮询 `http://127.0.0.1:<port>/json/list`；
- 找到真实 page target 和 `webSocketDebuggerUrl` 后才继续 CDP 测试。

这样不再把 `DevToolsActivePort` 文件系统创建时序当作 Chromium readiness 的必要条件。

## D-Bus 环境隔离

Browser acceptance 是纯 headless Chromium/CDP 本地测试，不依赖桌面 session bus。启动 Chromium 时复制当前环境，但显式删除：

- `DBUS_SESSION_BUS_ADDRESS`
- `DBUS_STARTER_ADDRESS`
- `DBUS_STARTER_BUS_TYPE`

目的不是压制 Chromium 错误，而是避免把 GitHub hosted runner 上可能过期或格式异常的桌面 session/starter 地址传给无界面浏览器。

如果 Chromium 进程退出、CDP endpoint 始终不可用、page target 不存在，测试仍然非零失败；没有把 Browser acceptance 降级成可跳过检查。

## CI failure domain 拆分

标准 `Verify` Workflow 从一个串行 Job 拆成三个相互独立的 GitHub-hosted Jobs：

### `test`

- 保留既有 Job key `test`，降低已有 branch protection required-check 名称发生变化的风险；
- checkout；
- Node 22；
- npm install；
- `npm test`。

### `browser`

- checkout；
- Node 22；
- npm install；
- `npm run test:browser`。

### `sim-static`

- checkout；
- Node 22；
- npm install；
- `npm run sim:check`；
- `npm run sim:preflight`；
- 上传 ROS preflight 诊断 Artifact。

三个 Job 不互设 `needs`，因此 Browser 失败不会再阻止 ROS static checks 执行，单元测试失败也不会抹掉 Browser/ROS 的独立诊断证据。

## ROS preflight Artifact 修复

此前 CI 日志实际出现：

`No files were found with the provided path: .local/ros/preflight.json`

`.local` 是隐藏目录。R70 在 `sim-static` 的 upload-artifact step 显式设置：

`include-hidden-files: true`

仍然只上传 `.local/ros/preflight.json` 单个固定文件，不扩大收集范围。

## 验证边界

R70 解决的是 CI 启动可靠性与失败域隔离。它不会把 Browser flaky 自动当作通过，也不会证明：

- ROS/Gazebo/Nav2 runtime 已真实执行；
- Voice Provider Workflow 已真实消费云端供应商；
- 真实麦克风/扬声器链已验证；
- self-hosted Runner 具备硬件可信根；
- 实体机器人已通过物理安全审查。

后续仍需分别用 R68/R69 的手动 Workflow 获取真实运行证据。