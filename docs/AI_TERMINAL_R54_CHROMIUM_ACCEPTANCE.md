# Alex R54：真实 Chromium 浏览器家庭使用验收

## 为什么本轮使用 CDP，而没有引入 Playwright

项目 `package.json` 当前只声明 TypeScript 开发依赖，原有 R53 提供 Node VM 浏览器状态机测试与真实 HTTP 测试，但并没有用浏览器引擎执行 HTML、DOM 和用户交互。直接引入 Playwright 会改变依赖与锁文件，超出本轮默认授权范围。

R54 使用 Node.js 22 内置 WebSocket 与 Chromium 的标准 Chrome DevTools Protocol（CDP），不增加 npm 依赖。它是**真实 Chromium 无界面渲染、鼠标点击与表单提交**，不是 VM 模拟 DOM；不测试 Safari/Firefox，也不声称和真实儿童操作完全相同。

## 已实现自动化流程

`npm run test:browser` 启动一个独立的临时 Alex HTTP 服务及新的 Chromium 用户数据目录，执行：

1. Chromium 加载正式控制台，使用登录对话框完成家长密码验证。
2. 家长在真实页面提交首次配置表单，创建独立学习者。云端及语音权限保持默认关闭。
3. 使用测试专属家长 HTTP 会话创建第二名学习者，仅用于后续隔离验证。
4. 浏览器退出家长身份，使用第一个孩子的代码及 PIN 登录。
5. 通过真实页面按钮创建英语会话、通过表单提交离线文字回合。
6. 点击“查看可继续学习内容”，确认最近会话按钮启用。
7. 真正刷新 Chromium 页面，再点击“继续最近会话”，验证已存在的消息重新显示。
8. 浏览器退出孩子甲，登录孩子乙，验证甲的消息不会显示、乙的最近会话为空。
9. 切回孩子甲，验证自己仍能恢复已有会话。
10. 家长通过独立测试会话重置甲的 PIN。浏览器原 Cookie 失效后，定时认证检查必须清除聊天 DOM，停止旧身份操作。
11. 验收结束后仅关闭由测试启动的 Alex 和 Chromium 进程，并删除该次创建的临时目录。

输出仅包含各阶段名称及通过状态，不输出 PIN、孩子登录代码、Cookie 或聊天正文。

## 执行及限制

```bash
npm test
npm run test:browser
npm run sim:check
npm run sim:preflight
```

R54 在 GitHub Actions 的现有 Verify 工作流中把 `npm run test:browser` 设为强制步骤。使用托管运行器提供的 Chromium/Chrome；若运行器未提供可执行浏览器、DevTools 连接失败、应用运行出错或页面条件未满足，命令非零退出，**不能把缺失浏览器当成通过**。

可以使用 `CHROME_BIN` 指向本机真实 Chrome/Chromium 可执行文件（例如 macOS Chrome 应用）。Chromium 通过 `--headless=new` 与独立 `--user-data-dir` 运行，仅用于本地测试。测试为了适配隔离 CI 使用 `--no-sandbox`，因此不能用此命令访问不受信任的网页或用户生产资料。

## 尚未验收

- 真实麦克风、浏览器语音识别提供商与云端 ASR/LLM/TTS 完整计费及错误恢复；
- Gazebo/ROS2/Nav2 实时目标导航、硬件碰撞风险与实体儿童真实使用；
- Safari/Firefox/移动设备以及长期压力、断网后重连、真实生产状态迁移；
- 该验收只使用本地模拟家庭数据和离线 AI，不意味着发布获得批准。

R55 应优先将真实云语音供应商的 E2E 验证与 ROS2/Nav2 运行时验收单独纳入明确可审计门槛，而不是继续无限扩张前端测试基础设施。
