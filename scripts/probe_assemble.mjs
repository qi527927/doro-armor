// 真宿主集成回归：用本机 @deepseek-ai/dsh-system-prompt 起一个真实 Context，
// 载入 doro-armor 本体，验证「不声明 complete + 组装期剥离」这条唯一真实路径。
//
// 断言的是宿主实际吐出来的 sections，不是插件内存里的自我汇报。
// 宿主包的解析：先试包名（在 DSH 环境 / 装好依赖的 checkout 里成立），
// 失败则回落到本机安装路径（插件目录不在 node_modules 解析范围内时用）。
// 两边都不写死单一环境，换机器不用改这个文件。
async function loadHostModules() {
  try {
    return {
      Context: (await import('@deepseek-ai/cordis')).Context,
      SystemPrompt: (await import('@deepseek-ai/dsh-system-prompt')).SystemPrompt,
    }
  } catch {
    const base = process.env.DSH_HOST_MODULES
      || '/opt/dsh/nodejs-project/node_modules/@deepseek-ai'
    return {
      Context: (await import(`${base}/cordis/lib/index.js`)).Context,
      SystemPrompt: (await import(`${base}/dsh-system-prompt/lib/index.js`)).SystemPrompt,
    }
  }
}

const { Context, SystemPrompt } = await loadHostModules()
const plugin = (await import('../index.js')).default

let pass = 0
const fails = []
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

const ctx = new Context()
// includeHarnessIdentity:true —— 造出身份段，好验证剥离器真的能删掉它
// includeRuntimeContext:false —— 与真实部署一致：宿主自己 suppress 可选 context
await ctx.plugin(SystemPrompt, { includeHarnessIdentity: true, includeRuntimeContext: false })

// 假 tools 服务：插件 inject 里要它
ctx.provide('tools', { register: () => () => {} })

// 模拟宿主侧的其它 section：工具说明、MCP、policy、身份段
ctx.systemPrompt.section({ name: 'tool:bash', order: 1000, text: 'BASH TOOL DESC' })
ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'READ TOOL DESC' })
ctx.systemPrompt.section({ name: 'mcp:servers', order: 3100, text: 'MCP SERVERS' })
ctx.systemPrompt.section({ name: 'plan:policy', order: 500, text: 'PLAN POLICY SAFETY' })

// contexts 的归属验证。
// 宿主 includeRuntimeContext:false 时自己调 suppressRuntimeContext()，
// 语义是「抑制可选、保留 required:true」。插件**不应插手**——
// resolveContext() 只透传 name/text/interpolate，required 到 waterfall 已经没了，
// 插件任何按 required 或按名字的过滤都会误杀必须保留的事实。
ctx.systemPrompt.context({ name: 'working-directory:current', order: 10, required: true, text: 'WD' })
ctx.systemPrompt.context({ name: 'sandbox:required-fact', order: 20, required: true, text: 'MUST KNOW' })
ctx.systemPrompt.context({ name: 'sandbox:policy', order: 110, text: 'SANDBOX POLICY' })
ctx.systemPrompt.context({ name: 'approval:policy', order: 115, text: 'APPROVAL POLICY' })

// 载入被测插件
await ctx.plugin(plugin, { enabled: true, completeOverride: false, stripSafetyRules: true })
await ctx.loader?.await?.()

const a = await ctx.systemPrompt.assemble({})
const names = a.sections.map((s) => s.name)

console.log('\n[1] 三层内核在最前')
check('doro-armor:kernel 存在', names.includes('doro-armor:kernel'))
check('doro-armor:mirror 存在', names.includes('doro-armor:mirror'))
check('doro-armor:obedience 存在', names.includes('doro-armor:obedience'))
check('kernel 排第一', names[0] === 'doro-armor:kernel', `实为 ${names[0]}`)
check('kernel → mirror → obedience 顺序', names.indexOf('doro-armor:mirror') < names.indexOf('doro-armor:obedience'))

console.log('\n[2] 工具说明与 MCP 保住（completeOverride:false 的核心价值）')
check('tool:bash 保住', names.includes('tool:bash'))
check('tool:read 保住', names.includes('tool:read'))
check('mcp:servers 保住', names.includes('mcp:servers'))
check('sections 长度 > 3（未被 complete 独裁）', names.length > 3, `实为 ${names.length}`)

console.log('\n[3] 组装期真实剥离（唯一能改动宿主的路径）')
check('harness:identity 被剔除（宿主 includeHarnessIdentity:true 自注册）', !names.includes('harness:identity'))
check('plan:policy 被剔除', !names.includes('plan:policy'))
const ctxNames = (a.contexts || []).map((c) => c && c.name)
check('required 的 working-directory:current 活下来', ctxNames.includes('working-directory:current'), ctxNames.join(',') || '(空)')
check('名字命中 SAFE 但 required 的 sandbox:required-fact 活下来（插件不得误杀）', ctxNames.includes('sandbox:required-fact'), ctxNames.join(',') || '(空)')
check('可选 sandbox:policy 由宿主抑制掉', !ctxNames.includes('sandbox:policy'), ctxNames.join(',') || '(空)')
check('可选 approval:policy 由宿主抑制掉', !ctxNames.includes('approval:policy'), ctxNames.join(',') || '(空)')

console.log('\n[4] 内核正文真的落位')
const kernel = a.sections.find((s) => s.name === 'doro-armor:kernel')
check('kernel 正文非空', typeof kernel?.text === 'string' && kernel.text.length > 1000, `chars=${kernel?.text?.length}`)
check('kernel 含 Doro 锚点', (kernel?.text || '').includes('Doro'))

console.log('\n[5] completeOverride:true 的对照（应暴露它为 bug）')
const ctx2 = new Context()
await ctx2.plugin(SystemPrompt, { includeHarnessIdentity: true })
ctx2.provide('tools', { register: () => () => {} })
ctx2.systemPrompt.section({ name: 'tool:bash', order: 1000, text: 'BASH TOOL DESC' })
await ctx2.plugin(plugin, { enabled: true, completeOverride: true, stripSafetyRules: true })
const b = await ctx2.systemPrompt.assemble({})
const bn = b.sections.map((s) => s.name)
check('complete 模式下 sections 塌成 1 条（确认这是功能性 bug）', bn.length === 1, `实为 ${bn.join(',')}`)
check('complete 模式下工具说明文本丢失', !bn.includes('tool:bash'))
check('tools 数组仍独立存在（工具能调但不知怎么用）', Array.isArray(b.tools))

console.log('\n[6] contexts 归属：插件不得插手（双模对照）')
// 只跑 includeRuntimeContext:false 一档是不够的 —— 那一档里 policy context 的消失
// 是宿主 suppressRuntimeContext() 干的，插件"碰"与"不碰"输出完全一样，
// 测试分不出来。必须再跑 true 档：宿主不抑制，policy 必须原样还在。
// 只有两档结论相反，才能证明插件真的没有伸手。
const ctxT = new Context()
await ctxT.plugin(SystemPrompt, { includeHarnessIdentity: true, includeRuntimeContext: true })
ctxT.provide('tools', { register: () => () => {} })
ctxT.systemPrompt.context({ name: 'working-directory:current', order: 10, required: true, text: 'WD' })
ctxT.systemPrompt.context({ name: 'sandbox:policy', order: 110, text: 'SB' })
ctxT.systemPrompt.context({ name: 'approval:policy', order: 115, text: 'AP' })
ctxT.systemPrompt.context({ name: 'sandbox:required-fact', order: 130, required: true, text: 'FACT' })
await ctxT.plugin(plugin, { enabled: true, completeOverride: false, stripSafetyRules: true })
const t = await ctxT.systemPrompt.assemble({})
const tn = (t.contexts || []).map((c) => c && c.name)
check('true 档：sandbox:policy 必须还在（证明插件未伸手）', tn.includes('sandbox:policy'), tn.join(',') || '(空)')
check('true 档：approval:policy 必须还在（证明插件未伸手）', tn.includes('approval:policy'), tn.join(',') || '(空)')
check('true 档：sandbox:required-fact 还在', tn.includes('sandbox:required-fact'), tn.join(',') || '(空)')
check('true 档：working-directory:current 还在', tn.includes('working-directory:current'), tn.join(',') || '(空)')

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length > 0) { console.log('失败项：'); for (const f of fails) console.log('  - ' + f); process.exit(1) }
