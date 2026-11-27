/**
 * 1.1.0 原生集成回归：preset 门控 / 每步自动读板 / worker 归因。
 * 不依赖任何外部服务，假的 ctx 服务即可跑通。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const dir = await mkdtemp(path.join(os.tmpdir(), 'sapper-native-'))
const tools = new Map()
const options = new Map()
let boardContext = null
const pressure = { pressureTokens: 61000, contextWindow: 100000 }

const ctx = {
  tools: {
    register: (definition, opts) => {
      tools.set(definition.name, definition)
      options.set(definition.name, opts)
    },
  },
  workingDirectory: { ensure: async () => dir, get: () => dir },
  inject: (_deps, callback) => {
    callback({
      systemPrompt: {
        context: (definition) => {
          boardContext = definition
        },
      },
    })
  },
  get: (name) => ({
    agentPresets: { presetForSession: (session) => session.header?.agentPreset ?? null },
    subagents: { namesOf: () => ({ self: 'scout-a' }) },
    tokenMeter: { contextPressure: () => pressure },
  })[name],
}

await apply(ctx)

assert.ok(boardContext, '系统提示板已注册')
assert.equal(boardContext.name, 'sapper-board')
assert.equal(boardContext.order, 95)

const sapper = { session: { id: 'sess-root-0001', header: { agentPreset: 'sapper', cwd: dir } } }
const standard = { session: { id: 'sess-std-0001', header: { agentPreset: 'standard', cwd: dir } } }
const child = { session: { id: 'sess-child-0001', header: { origin: 'subagent', parentSession: 'sess-root-0001', agentPreset: 'sapper', cwd: dir } } }

for (const name of ['sapper_state', 'sapper_write', 'sapper_kb']) {
  assert.equal(options.get(name).when({ agent: sapper }), true, `${name} 在 sapper 会话可见`)
  assert.equal(options.get(name).when({ agent: standard }), false, `${name} 在 standard 会话隐藏`)
}

assert.equal(boardContext.text({ agent: standard }), '', '非 sapper 会话不注入板')
assert.equal(boardContext.text({ agent: sapper }), '', '无图时不注入板')

const run = async (name, args, agent = sapper) =>
  (await tools.get(name).execute(args, { agent, signal: new AbortController().signal })).message

await run('sapper_write', { action: 'init', text: '确认 10.0.0.5 的初始访问并拿到可复现证据', origin: '授权测试' })
await run('sapper_write', { action: 'fact', text: '443 是 nginx 1.24.0', title: '指纹', kind: 'service', data: ['host=10.0.0.5'] })
await run('sapper_write', { action: 'intent', from: ['f001'], text: '验证 /download 路径穿越', title: 'LFI 验证' })

// 子代理不传 worker：应由 subagents.namesOf 自动署名，且 claim/done 不互相打架。
const claimed = await run('sapper_write', { action: 'claim', intent: 'i001' }, child)
assert.match(claimed, /scout-a/, 'claim 自动署名为子代理路径名')

const intentFile = path.join(dir, '.sapper', 'intents', 'i001.json')
const intent = JSON.parse(await readFile(intentFile, 'utf8'))
assert.equal(intent.worker, 'scout-a')
assert.ok(intent.claimed_at, 'claim 写入 claimed_at')
intent.claimed_at = new Date(Date.now() - 20 * 60_000).toISOString()
await writeFile(intentFile, JSON.stringify(intent, null, 2))

const board = boardContext.text({ agent: sapper })
assert.match(board, /^\[sapper 板\] active/m)
assert.match(board, /终态: 确认 10\.0\.0\.5/)
assert.match(board, /i001 认领 20m 未收口/)
assert.match(board, /上下文 61%/)

const done = await run('sapper_write', { action: 'done', intent: 'i001', text: '路径穿越可读 /etc/passwd', kind: 'vuln' }, child)
assert.match(done, /收口 → 事实 f002/, '同一子代理不传 worker 也能收口')

await rm(dir, { recursive: true, force: true })
console.log('native OK — 门控 / 自动读板 / worker 归因 / claimed_at 全部通过')
