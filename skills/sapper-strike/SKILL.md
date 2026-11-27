---
name: sapper-strike
description: 打击链与弹药：本机已装的工具（nmap/httpx/nuclei/sqlmap/ffuf/subfinder/jq/docker/tmux 实测路径）、从指纹到 CVE 到 nuclei 的三步阶梯、离线知识库与 cve-mcp 的用法、证据门槛（命令+响应字节+排除理由）。worker 报出产品版本、或要决定用什么工具时读本技能。
whenToUse: 拿到服务/版本指纹要判断能不能打；要为某个漏洞类选工具与命令；要确认本机有什么可用弹药；要写一条能被人复核的证据。
---

# 打击链 — 从指纹到证据

## 一、弹药清单（本机实测，2026-11-26）

| 工具 | 路径 | 干什么 |
|---|---|---|
| `nmap` | `/opt/homebrew/bin/nmap` | 端口与服务版本（`-sV -sC`，慢扫加 `-T3`） |
| `nuclei` | `~/go/bin/nuclei` | 模板化验证（**只用来确认，不用来"扫出漏洞"**） |
| `httpx` | `~/go/bin/httpx` | 存活/状态码/标题/技术栈/证书（`-sc -title -td -favicon`） |
| `subfinder` | `/opt/homebrew/bin/subfinder` | 子域枚举（被动源） |
| `ffuf` | `~/go/bin/ffuf` | 目录/参数/虚拟主机爆破（**限速**） |
| `sqlmap` | `/opt/homebrew/bin/sqlmap` | 注入确认与取数（`--batch --level 2 --risk 1` 起手） |
| `curl` | `/opt/homebrew/anaconda3/bin/curl` | 手工确认的唯一真相工具 |
| `jq` | `/opt/homebrew/bin/jq` | 解析 JSON 输出（把 10 KB 压成 1 行入图） |
| `python3` | `/opt/homebrew/bin/python3` | 一次性脚本、编码/解码、PoC |
| `docker` | `/opt/homebrew/bin/docker` | 起本地靶场/隔离环境 |
| `tmux` | `/opt/homebrew/bin/tmux` | 长跑会话（**本模式用 DSH 的 terminal 工具代替**） |

出网：profile 里 `cve-mcp` 的 env 显示本机走 `http://[::1]:7811`（`127.0.0.1:7811` 不通）。需要代理的工具自己加 `-proxy` 或 `http_proxy=`。

**先搜后造**：写脚本前先查（`sapper_kb`、`web_search`、已有 `scripts/`）。能复用就复用。

## 二、顺序：指纹 → 阶梯 → 最小验证

### 第 1 步：把版本钉死
```bash
curl -sI https://<host> | head -20                    # Server / X-Powered-By
httpx -u https://<host> -sc -title -td -favicon -json | jq .
# 或者从错误页/静态资源 hash 反推（版本号常常只在 favicon 或 /static 的注释里）
```
**版本没钉死之前，不要查 CVE**——查了也是猜。

### 第 2 步：走阶梯（离线库优先，比联网快）
```
sapper_kb query="<产品> <版本>"        # 命中 kb050-055 就是现成打法
sapper_kb show="kb050"                # 版本→CVE→nuclei 映射表
cve-mcp：nvd_get / kev_check / epss_score / nuclei_check / exploit_search
```
判据三条：
- **在野利用**（KEV）= 优先；
- **EPSS 高** = 可能有人写过 exp；
- **`nuclei_check` 有模板** = 能 30 秒验证，先试它。

### 第 3 步：最小验证
```bash
nuclei -u https://<host> -tags <tag> -severity critical,high -silent
```
**nuclei 命中 ≠ 漏洞确认**。模板只负责把请求发出去；你要用 curl 复现**一次**，把响应字节记下来。

```bash
curl -s -o /tmp/out.bin -w '%{http_code} %{size_download}\n' \
  'https://<host>/<path>?<payload>'
xxd /tmp/out.bin | head -5          # 二进制回显比"页面 200"有力得多
```

## 三、按漏洞类选打法（速查）

| 证据形状 | 先做什么 | 别做什么 |
|---|---|---|
| 参数回显在页面上 | 手工 payload 走一遍（`<svg onload>`、`'`、`{{7*7}}`、`../../`） | 别一上来就上扫描器 |
| 报错里带 SQL 关键字 | `sqlmap -u ... --batch --dbs`，先 `--technique=B` | 别开 `--risk 3` 打盲注 |
| 服务器会去请求 URL | 起本地 listener，回调确认（`nc -l`/`python3 -m http.server`） | 别直接打内网地址（会打穿别人的边界） |
| 反序列化/表达式 | 先确认语言与框架版本，再找现成 gadget | 别手写 gadget 链，成本高 |
| 文件上传 | 先测**能不能解析**（不是能不能传） | 别传 webshell 到生产 |
| 认证/JWT | 解 token 看算法与声明（`jq` + base64） | 别爆破生产账号 |

## 四、证据门槛（写完才算完）

一条能被人复核的证据必须有三样：

1. **命令**：原样可复制的请求（curl 优先；工具命令带上关键参数）。
2. **响应字节**：状态码 + 长度 + 关键片段（`uid=33` / `root:x:0:0` / `"success":true`）。
3. **排除理由**：为什么这不是误报——换过路径吗？是 200 但内容是统一错误页吗？是 WAF 的假 200 吗？

**阴性结论也要三问**：协议形状对吗（是不是 https 走了 http）、换过出口吗（代理/直连/不同源 IP）、换过姿势吗（大小写、编码、`//`、`;`、分号截断、UA/Referer）。

三问缺一 → `UNTESTED`，不许写 `DEAD`。

## 五、什么值得入图

| 现象 | 入图 kind | data 带什么 |
|---|---|---|
| 端口/服务/版本 | `service` | `host` `port` `product` `version` `banner` |
| 主机归属 | `host` | `ip` `asn` `os` `tags` |
| 可用凭据 | `cred` | `user` `pass` `service` `endpoint` |
| 可复现漏洞 | `vuln` | `product` `version` `cve` `path` `payload` `evidence` |
| 拿到的东西 | `loot` | `type` `path` `size` `sha256` |
| 旗标 | `flag` | `value` `challenge` `status` |
| 值得别人知道的 | `note` | `[UNTRUSTED]` / `[INJECTION-SUSPECT]` 打标 |

**原始输出不进 description**：落 `raw/<worker>/<时间>-<工具>-<目标>.txt`，事实里只留路径 + 结论 + 关键值。

## 六、纪律

- **限速**：目录爆破 ≤ 50 req/s，认证爆破 ≤ 1 req/s；同目标 429/403 立刻停并上报。
- **不打崩**：不重启服务、不做 fork bomb、不 `--risk 3` 打生产、不上 `--os-shell` 除非范围明确允许。
- **不扩大**：只碰授权目标；内网横向只在任务写明允许时做。
- **同一条命令最多 3 次**（换参数/换出口/换姿势），仍不行就换面，并把死路写进图。
- **一次只验证一个假设**：一单里塞三个猜测，最后你不知道是哪个成了。
