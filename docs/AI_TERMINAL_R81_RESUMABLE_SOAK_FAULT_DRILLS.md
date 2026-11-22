# R81：Resumable Soak Campaign 与 Fault Drill Coordinator

## 本轮目标

R80 已提供单段真实 Full Voice Turn Soak 和 segmented campaign。R81 补齐跨多次 Actions Run 的 checkpoint，并强化 Campaign totals 的可重算校验。

## Checkpoint

- checkpoint 绑定 campaign ID、目标时长、Commit；
- 每个 segment 绑定唯一 Run ID、attempt、Commit、时长、turn totals、报告 SHA-256；
- 每次追加后原子写入，使用前一 digest 构成 hash chain；
- 进程重启后重新读取并校验所有 totals 与 chain；
- 不允许跨 Commit、重复 Run、超过 4h segment；
- 达到 8/24/72h target 后状态变为 ready-to-aggregate。

Checkpoint 是防误操作/损坏的完整性结构，不是数字签名，也不能证明报告来自可信硬件。真实报告仍须通过 R80 self-hosted report verifier 和 GitHub Artifact readback。

## Campaign 验证强化

Campaign verifier 现在从 segment 明细重新计算：
- accumulated hours；
- started / completed / failed / cancelled；
- recovery attempts / success；
- overall success rate。

所有汇总字段必须与重算结果完全一致。Digest 仅用于完整性检测，不等价于签名或远程可信证明。

## Fault Drill Coordinator

协调器只编排 adapter 的 prepare → inject → observe → recover → verifyHealthyTurn → cleanup。
目前定义四个场景 ID：provider-503、provider-timeout、capture-device-unavailable、playback-device-unavailable。

重要边界：
- coordinator 不直接执行断网、杀进程、卸载设备或更改系统状态；
- adapter 必须由明确批准的专用环境提供；
- 未批准的真实执行会在调用 adapter 前拒绝；
- cleanup 失败优先报告，不吞异常；
- 当前 R81 只完成协调契约和模拟 adapter 测试，尚未提供生产级 Linux/ALSA/provider fault adapter。

## 尚未实测

- 真实设备消失与恢复；
- Provider 429/503 与真实 timeout；
- runner 中断后跨 Actions Run checkpoint 恢复；
- 真实 8/24/72h campaign；
- 物理环境 AEC / barge-in。
