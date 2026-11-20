# Precision Diagnostics Workbench Prototype

`ui-prototype/`（通过 `scripts/build_preview.py` 同步到 `docs/preview/`）是独立离线运行的**精密仪器风双舱交互原型**。所有集群、工作负载、耗时指标均为纯前端确定性模型，严禁网络请求（`connect-src 'none'`），不代表正式后端网关已完成对应能力。

## 核心架构与交互变革

1. **100dvh 锁定双舱工作台（Light Precision Shell + Obsidian Evidence Stage）**
   - 取消传统后台“顶部大横幅 + 表格 + 底部滚屏看结果”的上下盖楼结构。
   - **左舱（冷白 1px 机械网格）**：承载环境切换、Namespace/工作负载胶囊带、容器真实 Java PID（如 `PID 8`，跳过 `PID 1` 启动脚本与已完成的 `init-image-tools` 初始化容器）及行内 CPU/Heap 微水位条。
   - **右舱（深曜石高对比证据舞台，支持明暗一键切换）**：默认打开**多副本横向差分（Replica Diff）**，一眼标出偏离基线的异常副本（如单副本锁阻塞或慢调用），下方联动渲染带比例火焰底条的调用树、锁等待线程栈、内存分代或方法观测样本。
2. **悬浮指令发射船坞 + 未挂载副本一键自举（Auto-Bootstrap & Diagnose）**
   - 保持“发现 Pod 不自动 Attach”的安全底线，但消灭“先点连接等半天、再点诊断”的两段式手工操作。
   - 勾选包含未挂载目标（`discovered`）的批次直接按 `⌘↵` / `Ctrl+Enter` 执行时，模型自动串联 **WS 握手 → 内网 HTTP Pull / 流式缓存核验 → `jattach` 零额外 JVM 挂载 → 推进采样队列**。
3. **Web / MCP 共用不可变批次账本与固定分享链接**
   - 每次提交冻结精确目标快照（`clusterId`、`namespace`、`podUid`、`containerId`、`jvmIdentity`）。
   - 采样或排队途中若发生 Pod 滚动重建（UID 变更），仅对应子任务立即标记中断，**绝不在同名新实例上静默重放**，也绝不把缺失结果伪造为 `0`。
   - 支持 `#run=...&task=...` 固定证据快照链接与 `Ctrl+K` / `⌘K` 全局命令面板。

## 验证命令

```sh
python -B scripts/build_preview.py
node --check ui-prototype/model.js
node --check ui-prototype/app.js
node scripts/check_preview.mjs
```
