import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const dir = await mkdtemp(path.join(os.tmpdir(), 'sapper-native-'))
const tools = new Map()
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
  workingDirectory: { ensure: async () => dir },
}
await apply(ctx)
const agent = { id: 'session-test-0001' }
const exec = { agent, signal: new AbortController().signal }
const run = async (name, args) => {
  const def = tools.get(name)
  const value = await def.execute(args, exec)
  return value.message
}
const show = (label, text) => console.log(`\n### ${label}\n${text}`)

show('init', await run('sapper_write', { action: 'init', text: '拿下 web-01 的初始访问并取得 www-data 回显', origin: '授权测试 / 目标线索' }))
show('fact1', await run('sapper_write', { action: 'fact', text: '443 上是 nginx 1.24.0，Server 头与 favicon hash 一致', title: '指纹', kind: 'service', data: ['host=10.0.0.5', 'port=443', 'product=nginx', 'version=1.24.0'], worker: 'scout-a' }))
show('intent', await run('sapper_write', { action: 'intent', from: ['f001'], text: '确认 /download 的路径穿越能否读到 /etc/passwd', title: 'LFI 验证', worker: 'cmd' }))
show('claim', await run('sapper_write', { action: 'claim', intent: 'i001', worker: 'soldier-b' }))
show('status-before', await run('sapper_state', { action: 'status' }))
show('done', await run('sapper_write', { action: 'done', intent: 'i001', text: '路径穿越可读 /etc/passwd，回显含 root:x:0:0', kind: 'vuln', data: ['path=/download?file=../../../../etc/passwd'], worker: 'soldier-b' }))
show('frontier-empty', await run('sapper_state', { action: 'frontier' }))
show('new-intent', await run('sapper_write', { action: 'intent', from: ['f002'], text: '用 LFI 读 nginx 配置找可用凭据', title: '取凭据' }))
show('frontier', await run('sapper_state', { action: 'frontier' }))
show('recall', await run('sapper_state', { action: 'recall', query: 'nginx 配置 凭据' }))
show('validate', await run('sapper_state', { action: 'validate' }))
show('hint', await run('sapper_write', { action: 'hint', text: '同族目标都试 nginx 1.24 的 LFI' }))
show('kb', await run('sapper_kb', { query: '路径穿越 文件包含' }))
show('complete', await run('sapper_write', { action: 'complete', from: ['f002'], text: '已确认初始访问路径与凭据面' }))
show('validate-after', await run('sapper_state', { action: 'validate' }))
show('graph', await run('sapper_state', { action: 'graph' }))
show('flag-test', await run('sapper_write', { action: 'fact', text: 'flag{smoke}', title: '旗标', kind: 'flag' }))
show('flag-status', await run('sapper_write', { action: 'flag', id: 'f003', status: 'submitted' }))
await rm(dir, { recursive: true, force: true })
console.log('\nOK — 全部动作跑通')
