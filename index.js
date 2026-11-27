/**
 * dsh-preset-sapper — 原生事实图（.sapper/）。
 *
 * sapper-v2 的「历史层」在 DSH 里的原生实现：不再依赖任何外部 Python CLI，
 * 事实图直接由插件读写，通过三个模型工具暴露给所有 agent。
 *
 *   - sapper_state  读图：status / frontier / graph / show / doc / recall / validate
 *   - sapper_write  写图：init / fact / intent / done / complete / hint / claim / release / confirm / flag / doc
 *   - sapper_kb     离线知识库：随包内置的 56 条技术条目
 *
 * 磁盘格式与 sapper-v2 完全一致（project.json + facts/ + intents/ + hints/，
 * 一节点一 JSON、计数器自增、id 冲突跳过），所以同一张图既可由本插件读写，
 * 也可由上游 `sapper` CLI 打开——数据不锁定在任何一方。
 *
 * 并发：同一条图的写入在进程内串行化，落盘用「临时文件 + rename」保证原子性。
 * 上游用 fcntl.flock 跨进程加锁；本插件不跨进程互斥（DSH 内通常单进程写）。
 *
 * 原生集成（1.1.0）：
 *   - 三个工具只在 sapper preset 的会话里可见（when + session.header.agentPreset）；
 *     别的模式不再背这三份 schema。
 *   - systemPrompt.context 每步注入一段紧凑看板（终态／计数／frontier／flag／
 *     上下文压力），「读板」从每轮一次工具调用变成宿主结构；无图返回空串、绝不抛。
 *   - worker 默认按会话身份解析（根=commander，子代理=其路径名），不再要求每个
 *     子代理重复手填名字。
 */
import { promises as fs, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'sapper-native'
export const inject = ['tools', 'workingDirectory']

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))
const GOAL_ID = 'goal'
const SAPPER_PRESET = 'sapper'
const FACT_KINDS = ['host', 'service', 'cred', 'vuln', 'loot', 'flag', 'note']
const FLAG_STATUS = ['recorded', 'submitted', 'rejected', 'duplicate']

// ---------------------------------------------------------------------------
// io primitives
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function atomicWriteJson(file, value) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/** 读取一个节点目录，跳过坏文件（损坏的图仍然可读、可修）。 */
async function listNodes(dir) {
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    try {
      out.push(await readJsonFile(path.join(dir, name)))
    } catch {
      // 坏节点跳过：validate 会把它报出来
    }
  }
  return out
}

// 同一条图的写入串行化。键是图的绝对路径。
const writeChains = new Map()

function serialized(key, fn) {
  const prev = writeChains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  writeChains.set(key, next.catch(() => {}))
  return next
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

class Store {
  constructor(root) {
    this.root = root
    this.factsDir = path.join(root, 'facts')
    this.intentsDir = path.join(root, 'intents')
    this.hintsDir = path.join(root, 'hints')
    this.projectFile = path.join(root, 'project.json')
  }

  exists() {
    return exists(this.projectFile)
  }

  async require() {
    if (!(await this.exists())) {
      throw new Error(`这里没有事实图（${this.root}）。先调用 sapper_write action=init，或用 store 指定战役目录。`)
    }
  }

  async project() {
    const project = await readJsonFile(this.projectFile)
    if (typeof project !== 'object' || project === null) throw new Error('project.json 不是对象')
    if (typeof project.goal !== 'string' || !project.goal.trim()) throw new Error('project.json 缺少 goal')
    project.counters = project.counters && typeof project.counters === 'object' ? project.counters : {}
    for (const kind of ['fact', 'intent', 'hint', 'run']) {
      project.counters[kind] = Number.isInteger(project.counters[kind]) ? project.counters[kind] : 0
    }
    return project
  }

  async saveProject(project) {
    await atomicWriteJson(this.projectFile, project)
  }

  async init(origin, goal) {
    const cleanGoal = String(goal ?? '').trim()
    if (!cleanGoal) throw new Error('init 需要一个非空的 goal（终态一句话）')
    return serialized(this.root, async () => {
      if (await this.exists()) throw new Error(`事实图已存在：${this.root}`)
      const leftovers = (await fs.readdir(this.root).catch(() => [])).filter((n) => n !== '.lock')
      if (leftovers.length) {
        throw new Error(`目录非空，无法初始化：${this.root}（已有 ${leftovers.slice(0, 5).join(', ')}）`)
      }
      for (const dir of [this.root, this.factsDir, this.intentsDir, this.hintsDir]) {
        await fs.mkdir(dir, { recursive: true })
      }
      await atomicWriteJson(this.projectFile, {
        id: 'proj',
        origin: String(origin ?? '').trim(),
        goal: cleanGoal,
        status: 'active',
        created_at: nowIso(),
        counters: { fact: 0, intent: 0, hint: 0, run: 0 },
      })
      await atomicWriteJson(path.join(this.factsDir, `${GOAL_ID}.json`), {
        id: GOAL_ID,
        title: null,
        description: cleanGoal,
        doc: null,
        kind: null,
        data: {},
        created_at: nowIso(),
        creator: 'system',
        source_intent: null,
      })
      return { project: this.root }
    })
  }

  /** 计数器自增；若目标 id 已被占用则跳过（手改/恢复过的图不会互相覆盖）。 */
  async nextId(kind, prefix) {
    const project = await this.project()
    const dir = kind === 'fact' ? this.factsDir : kind === 'intent' ? this.intentsDir : this.hintsDir
    let n = project.counters[kind] + 1
    while (await exists(path.join(dir, `${prefix}${String(n).padStart(3, '0')}.json`))) n += 1
    project.counters[kind] = n
    await this.saveProject(project)
    return `${prefix}${String(n).padStart(3, '0')}`
  }

  async facts() {
    return listNodes(this.factsDir)
  }

  async intents() {
    return listNodes(this.intentsDir)
  }

  async hints() {
    return listNodes(this.hintsDir)
  }

  async fact(id) {
    const node = await readJsonFile(path.join(this.factsDir, `${id}.json`)).catch(() => null)
    if (!node) throw new Error(`事实 ${id} 不存在`)
    return node
  }

  async intent(id) {
    const node = await readJsonFile(path.join(this.intentsDir, `${id}.json`)).catch(() => null)
    if (!node) throw new Error(`工作单元 ${id} 不存在`)
    return node
  }

  async saveIntent(intent) {
    await atomicWriteJson(path.join(this.intentsDir, `${intent.id}.json`), intent)
  }

  async addFact({ description, title, doc, kind, data, creator, sourceIntent }) {
    const text = String(description ?? '').trim()
    if (!text) throw new Error('fact 需要一句话描述（text）')
    const who = String(creator ?? '').trim() || 'agent'
    return serialized(this.root, async () => {
      let source = null
      if (sourceIntent) {
        source = await this.intent(sourceIntent)
        if (source.to !== null) throw new Error(`工作单元 ${sourceIntent} 已收口（to=${source.to}）`)
        if (source.requires_confirmation && !source.confirmed_at) {
          throw new Error(`工作单元 ${sourceIntent} 需要人类确认后才能收口`)
        }
      }
      const id = await this.nextId('fact', 'f')
      const fact = {
        id,
        title: (title && String(title).trim()) || null,
        description: text,
        doc: (doc && String(doc).trim()) || null,
        kind: kind && FACT_KINDS.includes(kind) ? kind : null,
        data: normalizeData(data),
        created_at: nowIso(),
        creator: who,
        source_intent: sourceIntent ?? null,
      }
      await atomicWriteJson(path.join(this.factsDir, `${id}.json`), fact)
      if (source) {
        source.to = id
        source.status = 'done'
        source.concluded_at = nowIso()
        source.worker = who || source.worker
        await this.saveIntent(source)
      }
      return fact
    })
  }

  async addIntent({ from, description, title, doc, creator, requiresConfirmation }) {
    const text = String(description ?? '').trim()
    if (!text) throw new Error('intent 需要一句话描述（text）')
    const ids = [...new Set((from ?? []).map((v) => String(v).trim()).filter(Boolean))]
    if (!ids.length) throw new Error('intent 至少需要一个 from 事实 id')
    const who = String(creator ?? '').trim() || 'agent'
    return serialized(this.root, async () => {
      const existing = new Set((await this.facts()).map((f) => f.id))
      for (const fid of ids) {
        if (fid === GOAL_ID) throw new Error('goal 不能作为依赖')
        if (!existing.has(fid)) throw new Error(`依赖事实 ${fid} 不存在`)
      }
      const id = await this.nextId('intent', 'i')
      const intent = {
        id,
        title: (title && String(title).trim()) || null,
        from: ids,
        to: null,
        description: text,
        doc: (doc && String(doc).trim()) || null,
        creator: who,
        status: 'open',
        worker: null,
        claimed_at: null,
        requires_confirmation: Boolean(requiresConfirmation),
        confirmed_at: null,
        created_at: nowIso(),
        concluded_at: null,
      }
      await atomicWriteJson(path.join(this.intentsDir, `${id}.json`), intent)
      return intent
    })
  }

  async conclude({ intentId, description, title, doc, kind, data, worker }) {
    const text = String(description ?? '').trim()
    if (!text) throw new Error('done 需要产出事实的一句话描述（text）')
    const who = String(worker ?? '').trim() || 'agent'
    return serialized(this.root, async () => {
      const intent = await this.intent(intentId)
      if (intent.to !== null) throw new Error(`工作单元 ${intentId} 已收口（to=${intent.to}）`)
      if (intent.requires_confirmation && !intent.confirmed_at) {
        throw new Error(`工作单元 ${intentId} 需要人类确认（sapper_write action=confirm）`)
      }
      if (intent.worker && intent.worker !== who) {
        throw new Error(`工作单元 ${intentId} 已被 ${intent.worker} 认领`)
      }
      const id = await this.nextId('fact', 'f')
      const fact = {
        id,
        title: (title && String(title).trim()) || null,
        description: text,
        doc: (doc && String(doc).trim()) || null,
        kind: kind && FACT_KINDS.includes(kind) ? kind : null,
        data: normalizeData(data),
        created_at: nowIso(),
        creator: who,
        source_intent: intentId,
      }
      await atomicWriteJson(path.join(this.factsDir, `${id}.json`), fact)
      intent.to = id
      intent.status = 'done'
      intent.concluded_at = nowIso()
      intent.worker = who
      await this.saveIntent(intent)
      return { fact, intent }
    })
  }

  async complete({ from, note, worker }) {
    const text = String(note ?? '').trim()
    if (!text) throw new Error('complete 需要一句收口说明（text）')
    const ids = [...new Set((from ?? []).map((v) => String(v).trim()).filter(Boolean))]
    if (!ids.length) throw new Error('complete 至少需要一个 from 事实 id')
    const who = String(worker ?? '').trim() || 'agent'
    return serialized(this.root, async () => {
      const project = await this.project()
      if (project.status === 'completed') throw new Error('项目已完成')
      if (project.status !== 'active') throw new Error(`项目状态 ${project.status} 不能收口`)
      const intents = await this.intents()
      if (intents.some((i) => i.to === GOAL_ID)) throw new Error('项目已存在收口边')
      const existing = new Set((await this.facts()).map((f) => f.id))
      for (const fid of ids) {
        if (fid === GOAL_ID) throw new Error('goal 不能作为依赖')
        if (!existing.has(fid)) throw new Error(`依赖事实 ${fid} 不存在`)
      }
      const id = await this.nextId('intent', 'i')
      const intent = {
        id,
        title: null,
        from: ids,
        to: GOAL_ID,
        description: text,
        doc: null,
        creator: who,
        status: 'complete',
        worker: who,
        requires_confirmation: false,
        confirmed_at: null,
        created_at: nowIso(),
        concluded_at: nowIso(),
      }
      await atomicWriteJson(path.join(this.intentsDir, `${id}.json`), intent)
      project.status = 'completed'
      project.completed_at = nowIso()
      await this.saveProject(project)
      return { intent }
    })
  }

  async hint({ content, creator }) {
    const text = String(content ?? '').trim()
    if (!text) throw new Error('hint 需要内容（text）')
    const who = String(creator ?? '').trim() || 'agent'
    return serialized(this.root, async () => {
      const id = await this.nextId('hint', 'h')
      const hint = { id, content: text, creator: who, created_at: nowIso() }
      await atomicWriteJson(path.join(this.hintsDir, `${id}.json`), hint)
      return hint
    })
  }

  async claim({ intentId, worker }) {
    const who = String(worker ?? '').trim() || 'agent'
    return serialized(this.root, async () => {
      const intent = await this.intent(intentId)
      if (intent.to !== null) throw new Error(`工作单元 ${intentId} 已收口`)
      if (intent.requires_confirmation && !intent.confirmed_at) {
        throw new Error(`工作单元 ${intentId} 需要人类确认后才能认领`)
      }
      if (intent.worker && intent.worker !== who) throw new Error(`工作单元 ${intentId} 已被 ${intent.worker} 认领`)
      intent.worker = who
      intent.status = 'claimed'
      if (!intent.claimed_at) intent.claimed_at = nowIso()
      await this.saveIntent(intent)
      return intent
    })
  }

  async release({ intentId, worker }) {
    const who = String(worker ?? '').trim() || 'agent'
    return serialized(this.root, async () => {
      const intent = await this.intent(intentId)
      if (intent.to !== null) throw new Error(`工作单元 ${intentId} 已收口`)
      if (intent.worker && intent.worker !== who) throw new Error(`工作单元 ${intentId} 已被 ${intent.worker} 认领`)
      intent.worker = null
      intent.claimed_at = null
      intent.status = 'open'
      await this.saveIntent(intent)
      return intent
    })
  }

  async confirm({ intentId }) {
    return serialized(this.root, async () => {
      const intent = await this.intent(intentId)
      if (!intent.requires_confirmation) throw new Error(`工作单元 ${intentId} 不需要确认`)
      intent.confirmed_at = nowIso()
      intent.status = intent.worker ? 'claimed' : 'open'
      await this.saveIntent(intent)
      return intent
    })
  }

  async setDoc({ id, doc }) {
    const text = doc && String(doc).trim() ? String(doc).trim() : null
    return serialized(this.root, async () => {
      const factPath = path.join(this.factsDir, `${id}.json`)
      const intentPath = path.join(this.intentsDir, `${id}.json`)
      for (const file of [factPath, intentPath]) {
        if (await exists(file)) {
          const node = await readJsonFile(file)
          node.doc = text
          await atomicWriteJson(file, node)
          return node
        }
      }
      throw new Error(`没有名为 ${id} 的事实或工作单元`)
    })
  }

  async setFlagStatus({ id, status, note }) {
    if (!FLAG_STATUS.includes(status)) throw new Error(`非法 flag 状态：${status}`)
    return serialized(this.root, async () => {
      const fact = await this.fact(id)
      if (fact.kind !== 'flag') throw new Error(`${id} 不是 flag 事实`)
      fact.data = { ...(fact.data ?? {}), status }
      if (note) fact.data.result = String(note)
      await atomicWriteJson(path.join(this.factsDir, `${id}.json`), fact)
      return fact
    })
  }
}

function normalizeData(data) {
  const out = {}
  for (const entry of data ?? []) {
    const raw = String(entry)
    const eq = raw.indexOf('=')
    if (eq <= 0) continue
    const key = raw.slice(0, eq).trim()
    if (!key) continue
    out[key] = raw.slice(eq + 1).trim()
  }
  return out
}

function isOpen(intent) {
  return intent?.to === null || intent?.to === undefined
}

function isReady(intent, factIds) {
  if (!isOpen(intent)) return false
  if (factIds && !(intent.from ?? []).every((fid) => factIds.has(fid))) return false
  if (intent.requires_confirmation && !intent.confirmed_at) return false
  return true
}

async function frontierOf(store) {
  const intents = await store.intents()
  const factIds = new Set((await store.facts()).map((f) => f.id))
  const ready = intents.filter((i) => isReady(i, factIds))
  ready.sort((a, b) => {
    const ca = a.status === 'claimed' ? 0 : 1
    const cb = b.status === 'claimed' ? 0 : 1
    if (ca !== cb) return ca - cb
    return String(a.created_at).localeCompare(String(b.created_at))
  })
  return ready
}

// ---------------------------------------------------------------------------
// preset gating / auto board
// ---------------------------------------------------------------------------

/**
 * 这个 agent 是不是从 sapper preset 组合出来的。
 * 认不出 preset 时放行：宁可多给工具，也不能让 sapper 会话失去工具。
 */
function isSapperAgent(ctx, agent) {
  const session = agent?.session
  if (!session) return true
  try {
    const preset = session.header?.agentPreset
      ?? ctx.get?.('agentPresets')?.presetForSession?.(session)
    return preset ? preset === SAPPER_PRESET : true
  } catch {
    return true
  }
}

/** 子代理的稳定署名：优先用 subagents 的路径名，其次会话 id 短码。 */
function workerOf(ctx, agent, explicit) {
  const given = String(explicit ?? '').trim()
  if (given) return given
  const session = agent?.session
  if (!session) return 'commander'
  try {
    const self = ctx.get?.('subagents')?.namesOf?.(agent)?.self
    if (typeof self === 'string' && self) {
      const name = self === 'lead' ? 'commander' : self.replace(/^lead\//, '')
      return name.length > 24 ? `w-${String(session.id).slice(0, 8)}` : name
    }
  } catch {
    // 服务不可用就走下面的兜底
  }
  const header = session.header ?? {}
  if (header.origin !== 'subagent' && !header.parentSession) return 'commander'
  return `w-${String(session.id).slice(0, 8)}`
}

const boardCache = new Map()

/** 目录 mtime 只能发现增删；in-place 改动由 sapper_write 主动失效。 */
function graphSignature(root) {
  try {
    const project = statSync(path.join(root, 'project.json'))
    const facts = statSync(path.join(root, 'facts'))
    const intents = statSync(path.join(root, 'intents'))
    return `${project.mtimeMs}:${project.size}:${facts.mtimeMs}:${intents.mtimeMs}`
  } catch {
    return null
  }
}

function readJsonSync(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function listNodesSync(dir, cap = 500) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const nodes = []
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort().slice(0, cap)) {
    const node = readJsonSync(path.join(dir, name))
    if (node && typeof node === 'object') nodes.push(node)
  }
  return nodes
}

function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat
}

function claimMinutes(intent) {
  const at = Date.parse(intent?.claimed_at ?? '')
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.round((Date.now() - at) / 60000))
}

function contextPercent(ctx, session) {
  try {
    const pressure = ctx.get?.('tokenMeter')?.contextPressure?.(session)
    const window = Number(pressure?.contextWindow)
    const used = Number(pressure?.pressureTokens)
    if (!(window > 0) || !(used >= 0)) return null
    return Math.min(100, Math.round((used / window) * 100))
  } catch {
    return null
  }
}

/**
 * 每步注入系统提示的紧凑看板。同步渲染（宿主 prompt 组装不能 await）：
 * 任何读取失败都退化为空串，绝不把异常抛进装配。
 * order 95 排在 memory(90) 之后：板变化只会让缓存尾段失效。
 */
function renderBoard(root, session, ctx) {
  const signature = graphSignature(root)
  if (!signature) return ''
  const cached = boardCache.get(root)
  if (cached?.signature === signature) return cached.text
  const project = readJsonSync(path.join(root, 'project.json'))
  if (!project || typeof project.goal !== 'string') return ''
  const facts = listNodesSync(path.join(root, 'facts'))
  const intents = listNodesSync(path.join(root, 'intents'))
  const factIds = new Set(facts.map((f) => f.id))
  const open = intents.filter(isOpen)
  const ready = open.filter((i) => isReady(i, factIds))
  ready.sort((a, b) => {
    const ca = a.status === 'claimed' ? 0 : 1
    const cb = b.status === 'claimed' ? 0 : 1
    return ca - cb || String(a.created_at).localeCompare(String(b.created_at))
  })
  const claimed = open.filter((i) => i.status === 'claimed')
  const pendingFlags = facts.filter((f) => f.kind === 'flag' && (f.data?.status ?? 'recorded') === 'recorded')
  const factCount = facts.filter((f) => f.id !== GOAL_ID).length
  const lines = []
  if (project.status === 'completed') {
    lines.push(`[sapper 板] 已收口 · ${factCount} 事实${project.completed_at ? ` · ${clip(project.completed_at, 20)}` : ''}`)
    lines.push(`终态: ${clip(project.goal, 90)}`)
  } else {
    const flagNote = pendingFlags.length ? ` · flag ${pendingFlags.length} 待提交` : ''
    lines.push(`[sapper 板] ${project.status} · ${factCount} 事实 · ${ready.length} 就绪 / ${claimed.length} 认领${flagNote}`)
    lines.push(`终态: ${clip(project.goal, 90)}`)
    const top = ready.slice(0, 3)
    if (top.length) {
      const rest = ready.length - top.length
      const items = top.map((i) => `${i.id} ${clip(i.title || i.description, 34)}`).join(' · ')
      lines.push(`· ${items}${rest > 0 ? ` +${rest}` : ''}`)
    } else {
      lines.push('· frontier 空 —— 按换面矩阵补情报面')
    }
    const stale = claimed
      .map((i) => ({ id: i.id, age: claimMinutes(i) }))
      .filter((x) => x.age !== null && x.age >= 15)
      .slice(0, 2)
    if (stale.length) lines.push(`· ${stale.map((x) => `${x.id} 认领 ${x.age}m 未收口 ⚠`).join(' · ')}`)
    const pct = contextPercent(ctx, session)
    if (pct !== null) lines.push(`· 上下文 ${pct}%${pct >= 85 ? ' → 立刻写 STATE' : ''}`)
  }
  const text = lines.join('\n').slice(0, 1200)
  boardCache.set(root, { signature, text })
  return text
}

function boardFor(ctx, agent) {
  try {
    if (!isSapperAgent(ctx, agent)) return ''
    const session = agent?.session
    if (!session) return ''
    const cwd = ctx.workingDirectory.get(session)
    if (!cwd) return ''
    return renderBoard(path.join(cwd, '.sapper'), session, ctx)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

function kindCounts(facts) {
  const counts = new Map()
  for (const fact of facts) {
    if (fact.id === GOAL_ID) continue
    const kind = fact.kind || 'untyped'
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ')
}

function renderIntent(intent) {
  const claimed = intent.status === 'claimed' ? `  [claimed:${intent.worker ?? '?'}]` : ''
  const gate = intent.requires_confirmation && !intent.confirmed_at ? '  [需确认]' : ''
  const title = intent.title ? `${intent.title} — ` : ''
  return `  ${intent.id}  from [${(intent.from ?? []).join(', ')}]  ${title}${intent.description}${claimed}${gate}`
}

async function renderStatus(store) {
  const project = await store.project()
  const facts = await store.facts()
  const intents = await store.intents()
  const hints = await store.hints()
  const open = intents.filter(isOpen)
  const ready = await frontierOf(store)
  const lines = [
    `项目: ${project.id}  状态: ${project.status}`,
    `来源: ${project.origin || '(未填)'}`,
    `终态: ${project.goal}`,
    `计数: ${facts.length} 事实, ${open.length} 未收口 / ${intents.length - open.length} 已收口, ${hints.length} 提示`,
    `类型: ${kindCounts(facts)}`,
    '',
  ]
  if (project.status === 'completed') {
    lines.push(`已收口：${project.completed_at ?? ''}`)
    lines.push('')
  }
  if (ready.length) {
    lines.push('frontier（可就绪）:')
    for (const intent of ready) lines.push(renderIntent(intent))
  } else {
    lines.push('frontier 为空 —— 没有可推进的工作单元。先补事实，或按换面矩阵重扫。')
  }
  return lines.join('\n')
}

async function renderFrontier(store) {
  const ready = await frontierOf(store)
  if (!ready.length) return 'frontier 为空。'
  return ready.map(renderIntent).join('\n')
}

async function renderGraph(store, format) {
  const project = await store.project()
  const facts = await store.facts()
  const intents = await store.intents()
  const hints = await store.hints()
  if (format === 'json') {
    return JSON.stringify({ project, facts, intents, hints }, null, 2)
  }
  const lines = [`项目: ${project.id} (${project.status}) 终态: ${project.goal}`, '', '事实:']
  for (const fact of facts) {
    const kind = fact.kind ? `[${fact.kind}] ` : ''
    const title = fact.title ? `${fact.title} — ` : ''
    const data = Object.entries(fact.data ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')
    lines.push(`  ${fact.id}  ${kind}${title}${fact.description}${data ? `  (${data})` : ''}`)
  }
  lines.push('', '工作单元:')
  for (const intent of intents) {
    const done = intent.to === null ? 'open ' : `-> ${intent.to}`
    const title = intent.title ? `${intent.title} — ` : ''
    lines.push(`  ${intent.id}  ${done}  from [${(intent.from ?? []).join(', ')}]  ${title}${intent.description}`)
  }
  if (hints.length) {
    lines.push('', '提示:')
    for (const hint of hints) lines.push(`  ${hint.id}  [${hint.creator}] ${hint.content}`)
  }
  return lines.join('\n')
}

async function renderShow(store, id) {
  if (id === GOAL_ID) {
    const fact = await store.fact(GOAL_ID)
    return JSON.stringify(fact, null, 2)
  }
  for (const [kind, dir] of [['fact', store.factsDir], ['intent', store.intentsDir]]) {
    const file = path.join(dir, `${id}.json`)
    if (await exists(file)) return JSON.stringify(await readJsonFile(file), null, 2)
  }
  throw new Error(`没有名为 ${id} 的节点`)
}

async function renderDoc(store, id) {
  const node = JSON.parse(await renderShow(store, id))
  if (!node.doc) return `${id} 没有详细文档层（只有 title/description）。`
  return node.doc
}

async function renderRecall(store, query, limit) {
  const tokens = tokenize(query)
  if (!tokens.length) throw new Error('recall 需要 query')
  const scored = []
  for (const fact of await store.facts()) {
    const title = tokenize(fact.title ?? '')
    const body = tokenize(`${fact.description ?? ''} ${fact.doc ?? ''} ${Object.values(fact.data ?? {}).join(' ')}`)
    let score = 0
    for (const token of tokens) {
      if (title.includes(token)) score += 2
      if (body.includes(token)) score += 1
    }
    if (score > 0) scored.push({ kind: 'fact', id: fact.id, title: fact.title, description: fact.description, score })
  }
  for (const intent of await store.intents()) {
    const title = tokenize(intent.title ?? '')
    const body = tokenize(`${intent.description ?? ''} ${intent.doc ?? ''}`)
    let score = 0
    for (const token of tokens) {
      if (title.includes(token)) score += 1
      if (body.includes(token)) score += 1
    }
    if (score > 0) scored.push({ kind: 'intent', id: intent.id, title: intent.title, description: intent.description, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, Math.max(1, limit ?? 8))
  if (!top.length) return '没有相似的历史节点。'
  return top
    .map((hit) => `${hit.id}\t${hit.kind}\t${hit.title ? `${hit.title} — ` : ''}${hit.description}`)
    .join('\n')
}

async function renderValidate(store) {
  const errors = []
  let project
  try {
    project = await store.project()
  } catch (error) {
    return `校验失败：${error.message}`
  }
  if (!['active', 'completed'].includes(project.status)) errors.push(`项目状态非法：${project.status}`)
  const facts = await store.facts()
  const intents = await store.intents()
  const factIds = new Map(facts.map((f) => [f.id, f]))
  if (!factIds.has(GOAL_ID)) errors.push('缺少 goal 终态事实')
  else if (factIds.get(GOAL_ID).description !== project.goal) errors.push('goal 事实描述与 project.goal 不一致')
  for (const intent of intents) {
    for (const fid of intent.from ?? []) {
      if (!factIds.has(fid)) errors.push(`${intent.id}: 依赖事实 ${fid} 不存在`)
      else if (fid === GOAL_ID) errors.push(`${intent.id}: goal 不能作为依赖`)
    }
    if (intent.to && intent.to !== GOAL_ID) {
      const target = factIds.get(intent.to)
      if (!target) errors.push(`${intent.id}: 产出事实 ${intent.to} 不存在`)
      else if (target.source_intent !== intent.id) errors.push(`${intent.id}: 产出事实 ${intent.to} 未指向本单元`)
    }
  }
  for (const fact of facts) {
    if (fact.source_intent && !intents.some((i) => i.id === fact.source_intent)) {
      errors.push(`${fact.id}: 来源工作单元 ${fact.source_intent} 不存在`)
    }
  }
  const goalEdges = intents.filter((i) => i.to === GOAL_ID)
  if (project.status === 'completed' && !goalEdges.length) errors.push('项目已完成但没有收口边')
  if (project.status === 'active' && goalEdges.length) errors.push('项目仍 active 但已有收口边')
  return errors.length ? errors.map((e) => `- ${e}`).join('\n') : '校验通过：图结构完整。'
}

// ---------------------------------------------------------------------------
// knowledge base
// ---------------------------------------------------------------------------

let kbCache = null

async function loadKb() {
  if (kbCache) return kbCache
  const dir = path.join(PKG_DIR, 'kb', 'entries')
  const entries = []
  for (const node of await listNodes(dir)) {
    if (!node || typeof node !== 'object' || !node.id) continue
    entries.push(node)
  }
  kbCache = entries
  return entries
}

function tokenize(text) {
  const out = []
  for (const token of String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (/[\u3400-\u9fff]/.test(token)) {
      for (const ch of token.split('')) {
        if (!CJK_STOPWORDS.has(ch)) out.push(ch)
      }
    } else if (token.length > 0) out.push(token)
  }
  return out
}

/** 中文高频虚词：参与匹配只会让检索变噪。 */
const CJK_STOPWORDS = new Set('的了和与在是有个不也就都而要会对为上把被从到说会能这那你我他它其之以及或'.split(''))

async function kbSearch(query, limit) {
  const tokens = tokenize(query)
  if (!tokens.length) throw new Error('知识库检索需要 query')
  const scored = []
  for (const entry of await loadKb()) {
    const title = tokenize(entry.title ?? '')
    const desc = tokenize(entry.description ?? '')
    const tags = tokenize((entry.tags ?? []).join(' '))
    const body = tokenize(entry.detail ?? '')
    let score = 0
    for (const token of tokens) {
      if (title.includes(token)) score += 2
      if (tags.includes(token)) score += 1
      if (desc.includes(token)) score += 1
      if (body.includes(token)) score += 0.5
    }
    // 只看命中率高的一批：单字噪声太多，低于阈值的不进结果。
    if (score >= Math.max(2, tokens.length * 0.4)) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, Math.max(1, limit ?? 5))
  if (!top.length) return '知识库没有匹配条目（换个说法：产品名、版本号、漏洞类或症状）。'
  return top
    .map(({ entry }) => `${entry.id}\t${(entry.tags ?? []).join(',')}\t${entry.title}\n    ${entry.description ?? ''}`)
    .join('\n')
}

async function kbShow(id) {
  const entry = (await loadKb()).find((e) => e.id === id)
  if (!entry) throw new Error(`知识库没有条目 ${id}`)
  const commands = (entry.commands ?? []).length ? `\n\n命令:\n${entry.commands.map((c) => `  ${c}`).join('\n')}` : ''
  const source = entry.source ? `\n\n来源: ${entry.source}` : ''
  return `# ${entry.id} ${entry.title}\n\n${entry.description ?? ''}\n\n${entry.detail ?? ''}${commands}${source}`
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

async function storeFor(ctx, args, exec) {
  if (args?.store) {
    const resolved = path.resolve(String(args.store))
    return new Store(path.basename(resolved) === '.sapper' ? resolved : path.join(resolved, '.sapper'))
  }
  if (!exec.agent) throw new Error('当前调用没有关联会话，请显式传 store（战役目录或 .sapper 路径）')
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  return new Store(path.join(cwd, '.sapper'))
}

const textOutput = (schemaNote) => ({
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'message'],
    properties: {
      ok: { type: 'boolean', description: '是否成功' },
      message: { type: 'string', description: schemaNote ?? '面向模型的结果文本' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
})

const STORE_PARAM = {
  type: 'string',
  description: '可选：战役目录或 .sapper 路径。省略时用当前会话工作目录下的 .sapper。',
}

export async function apply(ctx) {
  ctx.tools.register({
    name: 'sapper_state',
    description:
      '读取战役事实图（.sapper/）：status 看项目与就绪队列，frontier 列可推进的工作单元，'
      + 'graph 导出全图，show/doc 读单个节点，recall 按相似度召回历史结论，validate 校验图完整性。'
      + '只读，不改动任何文件。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'frontier', 'graph', 'show', 'doc', 'recall', 'validate'],
          description: 'status = 项目概况 + frontier；frontier = 仅就绪工作单元；graph = 全图；show = 单节点 JSON；doc = 单节点详细文档；recall = 相似召回；validate = 完整性体检。',
        },
        id: { type: 'string', description: 'show/doc 的目标节点 id（f001 / i003 / goal）。' },
        query: { type: 'string', description: 'recall 的检索文本（描述性短语，中英文均可）。' },
        limit: { type: 'integer', description: 'recall 返回条数，默认 8。' },
        format: { type: 'string', enum: ['text', 'json'], description: 'graph 的输出格式，默认 text。' },
        store: STORE_PARAM,
      },
      required: ['action'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const store = await storeFor(ctx, args, exec)
      switch (args.action) {
        case 'status':
          await store.require()
          return { ok: true, message: await renderStatus(store) }
        case 'frontier':
          await store.require()
          return { ok: true, message: await renderFrontier(store) }
        case 'graph':
          await store.require()
          return { ok: true, message: await renderGraph(store, args.format) }
        case 'show':
          await store.require()
          if (!args.id) throw new Error('show 需要 id')
          return { ok: true, message: await renderShow(store, String(args.id)) }
        case 'doc':
          await store.require()
          if (!args.id) throw new Error('doc 需要 id')
          return { ok: true, message: await renderDoc(store, String(args.id)) }
        case 'recall':
          await store.require()
          return { ok: true, message: await renderRecall(store, String(args.query ?? ''), args.limit) }
        case 'validate':
          await store.require()
          return { ok: true, message: await renderValidate(store) }
        default:
          throw new Error(`未知 action：${args.action}`)
      }
    },
  }, { when: (activation) => isSapperAgent(ctx, activation.agent) })

  ctx.tools.register({
    name: 'sapper_write',
    description:
      '写战役事实图（.sapper/）：init 建图，fact 记一条已确认观察，intent 开一个工作单元，'
      + 'done 收口并产出事实，complete 宣告终态达成，hint 留给人/后继的消息，'
      + 'claim/release 认领与释放，confirm 放行需确认的动作，flag 更新旗标账本，doc 写详细文档层。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'fact', 'intent', 'done', 'complete', 'hint', 'claim', 'release', 'confirm', 'flag', 'doc'],
          description: '要执行的写操作。',
        },
        text: {
          type: 'string',
          description: 'fact/intent/done 的一句话描述；complete 的收口说明；hint 的内容。一句话，细节放 doc。',
        },
        title: { type: 'string', description: '2–10 字短标题，给图视图和看板用。' },
        origin: { type: 'string', description: 'init 用：这场战役从哪来（授权来源、目标线索、委托方）。' },
        kind: { type: 'string', enum: FACT_KINDS, description: 'fact 的类型；拿不准就省略。' },
        data: {
          type: 'array',
          items: { type: 'string' },
          description: '结构化字段，形如 ["host=10.0.0.5","port=443"]。精确值放这里，便于机器聚合。',
        },
        from: {
          type: 'array',
          items: { type: 'string' },
          description: 'intent/complete 依赖的事实 id（f001 形式，至少一个）。',
        },
        intent: { type: 'string', description: 'done/claim/release/confirm 的目标工作单元 id（i003 形式）。' },
        id: { type: 'string', description: 'flag/doc 的目标节点 id。' },
        doc: { type: 'string', description: '详细文档层（markdown），仅按需读取；长内容请配合 fs 写入另存后引用路径。' },
        worker: { type: 'string', description: '执行者标识（子代理名）。' },
        requiresConfirmation: { type: 'boolean', description: 'intent 是否必须人类确认后才能认领/收口。' },
        status: { type: 'string', enum: FLAG_STATUS, description: 'flag 的新状态。' },
        store: STORE_PARAM,
      },
      required: ['action'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await storeFor(ctx, args, exec)
      const worker = workerOf(ctx, exec.agent, args.worker)
      // 写之前就让板失效：下一步的 systemPrompt 重算，失败也无害。
      boardCache.delete(store.root)
      switch (args.action) {
        case 'init': {
          await store.init(args.origin ?? '', args.text)
          return { ok: true, message: `已建图：${store.root}\n终态：${args.text}` }
        }
        case 'fact': {
          await store.require()
          const fact = await store.addFact({
            description: args.text,
            title: args.title,
            doc: args.doc,
            kind: args.kind,
            data: args.data,
            creator: worker,
          })
          return { ok: true, message: `事实 ${fact.id}已入图：${fact.description}` }
        }
        case 'intent': {
          await store.require()
          const intent = await store.addIntent({
            from: args.from,
            description: args.text,
            title: args.title,
            doc: args.doc,
            creator: worker,
            requiresConfirmation: args.requiresConfirmation,
          })
          return { ok: true, message: `工作单元 ${intent.id} 已开：${intent.description}` }
        }
        case 'done': {
          await store.require()
          if (!args.intent) throw new Error('done 需要 intent')
          const { fact, intent } = await store.conclude({
            intentId: String(args.intent),
            description: args.text,
            title: args.title,
            doc: args.doc,
            kind: args.kind,
            data: args.data,
            worker,
          })
          return { ok: true, message: `工作单元 ${intent.id} 收口 → 事实 ${fact.id}：${fact.description}` }
        }
        case 'complete': {
          await store.require()
          const { intent } = await store.complete({ from: args.from, note: args.text, worker })
          return { ok: true, message: `项目已收口（收口边 ${intent.id}）：${args.text}` }
        }
        case 'hint': {
          await store.require()
          const hint = await store.hint({ content: args.text, creator: worker })
          return { ok: true, message: `提示 ${hint.id} 已写入：${hint.content}` }
        }
        case 'claim': {
          await store.require()
          if (!args.intent) throw new Error('claim 需要 intent')
          const intent = await store.claim({ intentId: String(args.intent), worker })
          return { ok: true, message: `工作单元 ${intent.id} 已认领：${worker}` }
        }
        case 'release': {
          await store.require()
          if (!args.intent) throw new Error('release 需要 intent')
          const intent = await store.release({ intentId: String(args.intent), worker })
          return { ok: true, message: `工作单元 ${intent.id} 已释放回 open` }
        }
        case 'confirm': {
          await store.require()
          if (!args.intent) throw new Error('confirm 需要 intent')
          const intent = await store.confirm({ intentId: String(args.intent) })
          return { ok: true, message: `工作单元 ${intent.id} 已确认放行` }
        }
        case 'flag': {
          await store.require()
          if (!args.id) throw new Error('flag 需要 id')
          if (!args.status) throw new Error('flag 需要 status')
          const fact = await store.setFlagStatus({ id: String(args.id), status: String(args.status), note: args.text })
          return { ok: true, message: `旗标 ${fact.id} 状态 → ${args.status}` }
        }
        case 'doc': {
          await store.require()
          if (!args.id) throw new Error('doc 需要 id')
          const node = await store.setDoc({ id: String(args.id), doc: args.doc })
          return { ok: true, message: `节点 ${node.id} 的文档层已更新（${(node.doc ?? '').length} 字符）` }
        }
        default:
          throw new Error(`未知 action：${args.action}`)
      }
    },
  }, { when: (activation) => isSapperAgent(ctx, activation.agent) })

  ctx.tools.register({
    name: 'sapper_kb',
    description:
      '离线技术知识库（随模式内置，56 条：SQLi/XSS/SSRF/SSTI/JWT/文件包含/反序列化/中间件 CVE 等）。'
      + '给定症状、产品或版本先查它，再决定要不要现场试。show 读整条（含命令与注意点）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索文本：症状、产品名、版本号或漏洞类。' },
        limit: { type: 'integer', description: '返回条数，默认 5。' },
        show: { type: 'string', description: '直接读某条（kb001 形式）。' },
      },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.show) return { ok: true, message: await kbShow(String(args.show)) }
      return { ok: true, message: await kbSearch(String(args.query ?? ''), args.limit) }
    },
  }, { when: (activation) => isSapperAgent(ctx, activation.agent) })

  // 每步自动读板：只在 sapper 会话生效；systemPrompt 不存在时静默跳过。
  // 宿主每步先 assemble 再跑 agent/pre-step，所以这是唯一「本步生效」的注入缝。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.context({
        name: 'sapper-board',
        order: 95,
        text: (assembly) => boardFor(ctx, assembly?.agent),
      })
    })
  }
}
