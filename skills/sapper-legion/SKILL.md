---
name: sapper-legion
description: 军团的 DSH 编排手册：把 sapper-v2 的 tmux 军团换成 subagent + 团队任务板，含派单模板、并发与模型分级路由、8 行回传卡、写盘分片、中途纠偏、失败补位与 signalman 角色。要派人、要拆单、要决定用哪个模型时读本技能。
whenToUse: 决定这一轮派谁去干什么、写任务卡与 mission 文本、选择 provider/model、需要中途 steer 一个跑偏的 worker、收割子代理产出、或者一个任务能切成 3+ 角度要批量扇出时。
---

# 编制 — 用 DSH 原语搭一支军团

sapper-v2 在 tmux 里开 pane 当手；DSH 里没有 pane，但有等价物，而且更省：

| sapper-v2 | DSH | 差别 |
|---|---|---|
| `tmux spawn claude` | `subagent` / `subagent_fork` | 有上下文隔离、有完成通知、可中断 |
| `worker.sh msg` | `send_message` + `wait_agent` | 中途纠偏仍可用 |
| `worker.sh peek` | 子代理最终答复 / 任务板状态 | 不保留滚动缓冲，所以**回传必须结构化** |
| `worker.sh list` | `list_agents` | 谁在跑、谁 idle |
| `worker.sh board` | `sapper_state action=status` + `team_task_list` | 每轮必读 |
| `-p --minutes 4` 短工 | 一个时间盒写进 prompt 的 subagent | 同样便宜 |
| `worker.sh kill` | 子代理自然收尾 / 不再等 | 不留僵尸 pane |

**关键差异**：DSH 子代理跑完就没了，你不会再有它的「屏幕」可看。所以派单时就把**产出格式写死**，收工时只看它交的卡 + 图里的事实。

## 一、编制

| 角色 | 谁 | 模型档 | 职责 | 典型时长 |
|---|---|---|---|---|
| **COMMANDER** | 你（主线程） | smart | 读板、判难度、派单、配模型、升级/停放、收口 | 全程 |
| **GENERAL** | subagent | smart | 啃硬目标 / 多阶段链；可自己再派 scout | 20–30 min |
| **SCOUT** | subagent | flash | 4 分钟侦察 + 难度判定，不出利用链 | ≤4 min |
| **SOLDIER** | subagent | flash | 执行单个 intent，产出事实 | 10–20 min |
| **SIGNALMAN** | subagent | flash | 只做一件事：收割散落的旗标/关键值、去重、统一记账 | ≤3 min |

并发上限来自 profile：`maxActiveSubagents = 8`、`maxDepth = 2`。**你自己占一个**，实际能派 6–7 个，但 smart 档要自压到 2–3（含你）。

## 二、派单模板（照抄，别自由发挥）

```
[战役] <代号> / <目标 ID>
[终态] 这一单结束时要拿到什么（一句话，可验证）
[已确认] 
  - f001 443 上是 nginx 1.24.0（Server 头 + favicon hash 一致）
  - f003 同族目标有 /download 路径穿越
  （只给最关键的 3–5 条，带 id；不要让它自己去读全图）
[范围] 只碰 <IP/域名/路径/账号>；不得触碰 <平台/计分/其他目标/生产>
[动作] 方向 + 工具（nmap -sV / httpx -sc / nuclei -tags / 手工确认）。不要给死命令，
       给它说清"要证明什么"，让它自己选打法。
[产出] 必须写进图：sapper_write action=fact，kind=<host|service|vuln|cred|loot|flag>，
       data 里放精确值（host/port/product/version/cve/path/回显原文）。
       结论不确定就写"未验证"，不要猜。
[时间盒] <N> 分钟内没有增量：把死路证据写进图，收工回报，不要继续钻。
[回传] 8 行卡，不要长报告（格式见下）。
[写入] 你只写 raw/<你的名字>/ 下你的文件；事实写进同一个 .sapper/，别的文件不要动。
```

回传卡固定 8 行：

```
目标：web-01 / 443
结论：路径穿越可读 /etc/passwd（已确认）
证据：GET /download?file=../../../../etc/passwd → 200，回显 root:x:0:0
关键值：f004 path=/download?file=../../../../etc/passwd
风险：该接口可能被 WAF 拦，已用 // 双写绕过
下一步：读 nginx.conf 找凭据面
死路：尝试读 /etc/shadow 返回 403
产物：raw/scout-a/20261126-1502-lfi.txt；事实 f002 f004
```

## 三、模型分级（经济）

profile 里已授权的路线（`subagent-model-selection-settings`）：

| 档 | provider / model | 用途 |
|---|---|---|
| **smart** | `opencode-go` / `deepseek-v4-pro`；`opencode-go-github` / `deepseek-v4-pro` | GENERAL、关键决策、判不准的研判 |
| **flash** | `opencode-go` / `deepseek-v4.1-flash`；`opencode-go-kaisa` `/ deepseek-v4.1-flash`；`opencode-go-google` `/ deepseek-v4.1-flash`；`opencode-go-github` `/ deepseek-v4.1-flash` | SCOUT、SOLDIER、SIGNALMAN、chore |

规则：
- **默认全 flash**。派单不写 provider/model 就用默认路线，那是可以的，但**别随手升 smart**。
- smart 的四个合法用途：硬目标的 GENERAL、中场审计、终局重开、判不准的关键决策。
- **一个 worker 固定一条路线跑完**。中途换模型 = 丢证据链。
- 配额墙/连续报错 → 换一条**不同套餐**的路线重派（`opencode-go-kaisa` / `-google` / `-github` 是三个独立套餐，可并发），不是换档。
- 换路线时把已知事实重新写进 mission（新 worker 不会继承前一个的上下文，除非用 `subagent_fork`）。

**什么时候用 `subagent_fork`**：任务需要复用你当前的判断（比如"基于我刚才的分析继续"）。  
**什么时候用 `subagent`**：任务自包含（给 mission 就能干）——绝大多数情况，因为更省上下文。

## 四、任务板（不是可选）

派单前先落板，好处是：可观测、可 claim、可去重、跨会话还在。

```
team_task_create(
  subject="web-01 LFI 验证",
  description="<就是上面的派单模板全文>",
  write_scopes=["raw/scout-a", "artifacts/web-01"]
)
→ 拿到 task_id
subagent(prompt="<派单模板 + 任务板 id>" + "完成后用 team_task_update 把该任务标 complete")
```

- **一个目标同时只有一个 worker 在打同一面**。同目标第二个 worker 必须换面，mission 里明写"w2：走源码审计角度，先读图别重复 w1"。
- 任务卡的 `write_scopes` 是写盘分片的声明——两个任务不要有重叠的 `raw/` 子目录。
- 收工：`team_task_update(action=complete)`。**没标 complete 的任务等于没干完**，下一轮板子上会挂着，你会误判还在跑。

## 五、批量扇出：`workflow`

当一次要扇出 ≥4 个**互不依赖**的探测（每个目标一次指纹、每个域名一次归属），用 `workflow` 写脚本，而不是连发十个 `subagent`：

```js
const targets = args.targets
const results = await pipeline(
  targets,
  (t) => agent(`<派单模板，目标=${t}>`, { label: t }),
)
return results.filter(Boolean)
```

`pipeline` 没有阶段屏障，比 `parallel` 省时间。脚本里没有文件系统/网络——**干活的是子代理，脚本只编排**。

## 六、中途纠偏

子代理跑偏时，`send_message(agent, "...")` 一条**具体指令**，不是鼓励：

- ✅「先别继续爆破。把已拿到的 302 → /dashboard 写进图，然后只做一件事：用 admin/Admin@123 登进去看后台有没有上传点。」
- ❌「加油，再试试别的。」

发完不要立刻追问；让它跑。要判断它是不是死了，看 `list_agents` 的状态，而不是反复发消息。

## 七、收割与补位

- 子代理结束 → 先看**图里有没有事实**，再看回传卡。**没有事实的汇报等于没干**（除了纯研判结论，那也该是一条 `note`）。
- 声称成功但图里没证据 → 派一个 3 分钟 SIGNALMAN 复核；复核不过就不算成功，按死路记账。
- 子代理超时/无输出 → 不再等，把它留下的部分产物入图，重派一个**更小**的 mission。
- 子代理之间结论冲突 → 新增一条 `note` 事实标 `SUPERSEDES`，别删旧的；冲突本身就是情报。

## 八、写盘分片（硬规矩）

一队人同时写盘是最容易互相踩的地方：两个 worker 同时改同一个 `raw/notes.md`，后写的把先写的覆盖掉，而且**没有冲突提示**。

- 每个 worker 一个子目录：`raw/<worker-name>/`，只写自己的。
- 共享的只有两样：`.sapper/`（走工具，有串行化）和 `commander-state.md`（只有 COMMANDER 写）。
- 交付物按目标分：`artifacts/<target-id>/`，谁产出谁写，命名带时间戳。

## 九、成本直觉（供配给参考）

| 动作 | 相对成本 | 说明 |
|---|---|---|
| 派 1 个 flash scout（4 min） | 1× | 最便宜的"先看一眼" |
| 派 1 个 flash soldier（15 min） | 4× | 默认主力 |
| 派 1 个 smart general（25 min） | 20–40× | 只在决策表允许时用 |
| 自己读一次图 | ~0 | **永远先读图，再决定派不派** |
| `sapper_kb` 查一次 | ~0 | worker 卡住时先查库，比升级便宜两个数量级 |

**半数的"卡住"是一条 worker 还没命名的已知技术**。先查库，再升级，最后才加人。
