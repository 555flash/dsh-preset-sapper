# 工兵军团 Sapper

把 sapper-v2 的条令搬进 DSH，并按 DSH 的能力重写了它的「手」。

## 它提供什么

**三个原生工具**（Host 层，无外部 CLI、无 Python 依赖）：

- `sapper_state` — 读事实图：`status` / `frontier` / `graph` / `show` / `doc` / `recall` / `validate`
- `sapper_write` — 写事实图：`init` / `fact` / `intent` / `done` / `complete` / `hint` / `claim` / `release` / `confirm` / `flag` / `doc`
- `sapper_kb` — 随包内置的 56 条离线技术条目

三个工具只在 sapper 会话可见（按 `session.header.agentPreset` 门控）；每次提示装配还会把
`[sapper 板]`（终态／计数／frontier／待提交 flag／认领超时／上下文%）注入系统提示，
`sapper_write` 的 worker 默认按会话身份署名（根=commander，子代理=其路径名）。

**一个模式** `sapper`（菜单名「工兵军团 Sapper」）：standard 全套工具 + 常驻终端 + 跨会话检索 + 子代理/工作流 + 7 个内置技能。

## 怎么用

1. 选「工兵军团 Sapper」开新会话，工作目录落在战役目录。
2. 给它一句终态（例如「确认 10.0.0.5 的初始访问路径并拿到可复现证据」）。
3. 它建图 → 研判 → 派 scout/soldier/general → 事实入图 → 收口。

## 三条硬规矩

- **commander 只调度不亲打**：触达目标的动作一律派子代理。
- **图是唯一记忆**：对话不算证据，写进 `.sapper/` 才算。
- **先证后判**：没跑过写未验证；阴性结论要过协议/出口/姿势三问。

## 边界与限制

- 事实图跟着**会话工作目录**走，不跨机器同步。
- 没有 watchdog：子代理结束由 commander 补位，不自动重启。
- 上游的 `dispatch` / `auto` / `fleet` / `arena` / `bench` / `view` 未移植；`sapper_state action=graph` 或聊天里的 `[sapper 板]` 可替代看图。
- 看板是同步渲染 + 缓存：外部 CLI 原地改图不会立刻刷新，下一次目录变化或 `sapper_write` 才重算；取不到 preset 的会话按「放行」处理（工具仍可见）。
- 不改变任何权限策略；使用前提是**授权范围内**（见 `sapper-triage` 与 `sapper-sensors` 的合规红线）。
