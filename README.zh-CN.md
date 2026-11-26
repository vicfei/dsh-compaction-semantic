# dsh-compaction-semantic —— DeepSeek Harness 的语义化上下文压缩

**留任务还需要的，丢不需要的——靠判断，不靠字符数。** DeepSeek Harness
出厂的压缩用算术回答上下文膨胀（超过 8,192 码点的工具结果保头 4,096 +
尾 1,024），再用 LLM 摘要把你的错误堆栈洗成散文。本插件把**决策**换成校准
判断——保留的内容 **verbatim 不改写**，丢弃的按相关性**散布**取舍（相关内容
也会出现在中段），任何失败都降级回官方行为。

[English](README.md) | 简体中文

## 为什么（agent 使用中最普遍的痛点）

每个长会话 agent 用户终会撞上压缩，而得到的是"最旧的寒暄活过了字节预算，
三步前的错误堆栈没有"。跨 harness 数据集里最响的痛点信号：`fast-jev-compaction`
原仓**一天 8,002 星**（2026-09-17，此后休眠，社区 fork 续命）——为 Claude Code
做的正是这件事：keep/drop 判断 + verbatim 保留。DSH 出厂的是**确定性**剪枝
（`dsh-compaction-tool-result-pruner`），但把判断位留空了：引擎按**可选的、按名
解析的服务**消费 pruner，且总是先剪枝、后考虑 LLM 摘要。那个空位就是本仓。

## 交付什么（计划）

- **V1 语义化工具结果剪枝器**：挂在 `agent/pre-step`（先于压缩引擎自己的监听器），
  对所有超预算工具结果**合并一次判断请求**（共享 state=近期用户请求+计划；每段
  一问，~300ms 级），按官方回放安全协议（`compaction/prune` 遮蔽事件 →
  `tool/result` replace surfaceOp）落盘 keep/drop。判断器关闭/超时/出错 → 整体
  跳过，官方行为不变。
- **V2 keep/drop 压缩引擎**：用逐消息 keep/drop 替换摘要器（完整主张），走设计好的
  `summarize()` 钩子。

挂载机制精读（官方 pruner 如何接入、塑造 V1 的同步调用约束、两个插入点）：
[docs/analysis-official-pruner.md](docs/analysis-official-pruner.md)（英文）。
跨 harness 对照分析——Claude Code（三层体系 + PreCompact/function hooks）与
Codex（单层、无钩子、AGENTS.md 挂载）的压缩实现，及 DSH 为何是最佳宿主：
[docs/analysis-cc-codex-compaction.md](docs/analysis-cc-codex-compaction.md)（英文）。

## 安装与挂载验证（2026-11-26 活机验证，宿主 0.2.2-rc.1）

```bash
dsh plugin --profile <name> add dsh-compaction-semantic
# bundles 落雷：plugin add 只装不激活——须手工把 "dsh-compaction-semantic"
# 加进 package.json 的 dsh.profile.bundles 列表
```

包内 `cordis.patch.yml` 以 `- insert:` 插入插件行（顶层行是对**既有**行的
配置覆写，静默无效）；行内 `name` 是 loader 从 profile 的 `node_modules`
解析的**模块说明符**。两步验证挂载：

```bash
dsh --profile <name> --dump-config | grep -A3 dsh-compaction-semantic   # 行在合成树里
dsh --profile <name> "hi" 2>&1 | grep "semantic pruner armed"           # 插件自己的挂载证明，每次启动一行
```

2026-11-26 起插件把武装行（及每次剪枝摘要、每次 fail-closed 转移）打到
**stderr**——`ctx.logger` 喂的是不上终端的结构化缓冲，这正是首轮活机检查
什么都没看到的原因。开发落雷：pnpm `file:` 安装是硬链接——改了源仓再
`git checkout` 还原，profile 的 `.pnpm` 存里留着坏副本；重测前先同步或重装。

## 状态

Spike #1（本分析）2026-11-21 交付。见 [ROADMAP.md](ROADMAP.md)。

与 DeepSeek、TypeSafe 及任何上游无关。MIT。
