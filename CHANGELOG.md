# CHANGELOG — 工兵军团 Sapper（dsh-preset-sapper）

## 1.1.0（2026-11-27）

把「靠 persona 自律」的三件事换成 DSH 原生机制。磁盘格式不变，1.0.0 的图直接可读。

### 原生集成

- **preset 门控**：`sapper_state` / `sapper_write` / `sapper_kb` 用 `tools.register(..., { when })`
  按 `session.header.agentPreset === 'sapper'` 暴露，其它模式不再背这三份 schema
  （约 3–4 KB/请求）。认不出 preset 时放行，宁可多给也不让 sapper 会话失去工具。
- **每步自动读板**：`ctx.systemPrompt.context({ name: 'sapper-board', order: 95 })` 在
  每次提示装配时同步渲染 `<cwd>/.sapper` 的紧凑看板：终态、事实/就绪/认领计数、
  待提交 flag、frontier 前 3、认领 ≥15 分钟未收口、上下文压力（`tokenMeter`，
  ≥85% 提示写 STATE）。无图返回空串，渲染失败绝不抛；目录签名 + `sapper_write`
  主动失效双保险（in-place 外部改动要等下一次目录变化）。
  order 95 排在 memory(90) 之后，板变化只让缓存尾段失效。
- **worker 归因**：`sapper_write` 的 worker 默认按会话身份解析（根=commander，
  子代理=subagents 的路径名，取不到用会话 id 短码），不再要求每个子代理重复手填；
  显式 `worker` 仍然优先。
- **`claimed_at`**：`claim` 写入、`release` 清空，供看板判断认领超时；旧图缺这个字段
  时看板只是不显示年龄，不报错。

### 修正

- persona 里的 CLI 语法（`sapper fact` / `sapper status` / `sapper init --goal`）全部
  改成实际工具调用（`sapper_write action=fact` 等）——旧写法会被模型当 bash 命令跑。
- `sapper-doctrine` 的读板段、board 映射、收口示例同步到新工具名。
- bundle 头注释删掉「CLI 已内置在 vendor/sapper.py」的过期描述（1.0.0 已移除）。

### 验证

- `test/smoke.mjs`：1.0.0 全链路（init→…→complete→flag）仍通过。
- `test/native.mjs`（新增）：门控（sapper 可见 / standard 隐藏）、无图不注入、
  子代理自动署名、claimed_at、认领超时提示、上下文百分比、同子代理不传 worker 收口。

## 1.0.0（2026-11-26）

首个版本。上游 [N1nEmAn/sapper-v2](https://github.com/N1nEmAn/sapper-v2) @ `7b75e6f`（MIT）。

### 事实图改为 DSH 原生实现

初版曾把上游 `lib/sapper.py` 内置并软链到 `~/.local/bin/sapper`——这是"外部 CLI"路线，
被否掉：要的就是**原生在 DSH 里**。现在整条链路没有任何 Python / 外部可执行文件：

- `index.js` 用 Node 标准库实现事实图的全部读写（Store / 计数器 / 原子写 / 进程内串行化）；
- 三个原生工具 `sapper_state` / `sapper_write` / `sapper_kb` 注册在 Host 层；
- 图的位置由 `ctx.workingDirectory.ensure(agent)` 解析为**会话工作目录**下的 `.sapper/`；
- 磁盘格式与上游逐字段一致（`project.json` + `facts/` + `intents/` + `hints/`），
  上游 CLI 仍可打开同一张图，数据不锁定在任何一方。

踩过的两个坑（留档）：

- `output.schema` 走**标准 JSON Schema**，`required` 必须是字符串数组；
  属性级 `required: true` 只适用于 `parameters` 的 ParameterSchemaSpec。
  写成属性级会得到 `unsupported JSON schema: ... is not supported on type "boolean"`，整行激活失败。
- `Tool.listTools` 的 `input` 省略即可，传 `{}` 或额外字段都会被参数校验拒掉。

### 模式

- persona：commander 战地敕令（三条铁律、编制、循环、升级决策表、经济、自管理、禁令）。
- 工具面：standard 全套 + `terminal`（隔离常驻 PTY）+ `session_search`（隔离）+ 计划模式 + 压缩 + 子代理/工作流 + 定时任务 + `ask_user_question`（仅作授权闸门）。
- `agent-instructions` 增加 `.sapper` / `.dsh-root` 作为项目根标记，战役父层章程可自动加载。

### 7 个内置技能

`sapper-graph`（图操作）、`sapper-doctrine`（条令全本）、`sapper-legion`（DSH 编排）、
`sapper-sensors`（uni-mcp 五源 + IP 地理 + cve-mcp）、`sapper-strike`（弹药与打击链）、
`sapper-triage`（研判与归因分级）、`sapper-handoff`（STATE/压缩/接力/收口）。

### 数据资产

- `kb/entries/*.json`：上游 56 条离线知识库（含 kb050–055 的版本→CVE→nuclei 阶梯）。
- `templates/*.md`：上游 reason/explore/verify 等 prompt 模板，供写 mission 参考。

### 验证

- 单元级：init → fact → intent → claim → done → frontier → recall → validate → hint → kb → complete → graph → flag 全链路跑通。
- 插件级：`sapper-native`、`preset-sapper` 两行 `fiberPhase: active`；`sapper_state` / `sapper_write` / `sapper_kb` 出现在 Host 工具目录。
- 待人工确认：在 GUI 模式菜单里选中「工兵军团 Sapper」后开新会话的实际体感（preset 不进已有会话）。
