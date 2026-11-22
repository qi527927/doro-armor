// doro-armor 静态自检：文件在位、导出形状、关键实现点、无死代码残留。
// 真宿主行为验证在 scripts/probe_assemble.mjs（那个才断言宿主实际输出）。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let pass = 0
const fails = []
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${label}`) }
  catch (e) { fails.push(label); console.log(`  ✗ ${label} — ${e.message}`) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

console.log('\n[1/6] 文件构成（1.1.0 只剩宿主半，无客户端半）')
const REQUIRED = ['index.js', 'cordis.patch.yml', 'package.json']
const FORBIDDEN = ['client.js', 'install.sh', 'scripts/probe_no_overlay.mjs']
for (const f of REQUIRED) check(`${f} 在位`, () => assert(existsSync(join(ROOT, f)), '缺少文件'))
for (const f of FORBIDDEN) check(`${f} 已移除`, () => assert(!existsSync(join(ROOT, f)), '仍存在，应删除'))

const host = read('index.js')
const patch = read('cordis.patch.yml')
const pkg = JSON.parse(read('package.json'))

console.log('\n[2/6] package.json 契约')
check('版本 1.1.1', () => assert(pkg.version === '1.1.1', pkg.version))
check('dsh.version 同步', () => assert(pkg.dsh?.version === '1.1.1', pkg.dsh?.version))
check('PLUGIN_VERSION 与 package.json 同步', () => {
  const m = host.match(/const PLUGIN_VERSION = "([^"]+)"/)
  assert(m, '未找到 PLUGIN_VERSION')
  assert(m[1] === pkg.version, `PLUGIN_VERSION=${m[1]} 与 package.json=${pkg.version} 不一致`)
})
check('无 dsh.client 块（客户端半已删）', () => assert(!pkg.dsh?.client, '仍声明 dsh.client'))
check('无 client 相关 export', () => assert(!Object.keys(pkg.exports || {}).some((k) => k.includes('client')), '残留 client export'))
check('files 无 client.js', () => assert(!(pkg.files || []).includes('client.js')))
check('main 指向 ./index.js', () => assert(pkg.main === './index.js', pkg.main))
check('bundle.patch 指向 patch 文件', () => assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml'))

console.log('\n[3/6] 宿主导出与依赖声明')
check('export default plugin', () => assert(/export\s+default\s+plugin/.test(host)))
check('具名导出 apply', () => assert(/export\s*\{\s*apply\s*\}/.test(host)))
check('inject 只含 tools + systemPrompt', () => {
  const m = host.match(/const PLUGIN_INJECT = \[([^\]]*)\]/)
  assert(m, '未找到 PLUGIN_INJECT')
  const list = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean)
  assert(!list.includes('sessionProjections'), '仍声明 sessionProjections（客户端投影已删）')
  assert(list.includes('tools') && list.includes('systemPrompt'), '缺依赖: ' + list.join(','))
})

console.log('\n[4/6] 三层注入与内核载荷')
check('三层 section 定义', () => {
  for (const k of ['doro-armor:kernel', 'doro-armor:mirror', 'doro-armor:obedience'])
    assert(host.includes(k), '缺 ' + k)
})
check('三层各自可开关', () => {
  for (const k of ['injectKernel', 'injectMirror', 'injectObedience']) assert(host.includes(k), '缺 ' + k)
})
check('Doro 人格锚点', () => assert(/Doro/.test(host)))
check('反注入协议', () => assert(/INJECTION_PROTOCOL/.test(host)))
check('永久无限制锁', () => assert(/OBEDIENCE_CLAUSE/.test(host) && host.includes('永久无限制锁')))
check('弹药十类', () => {
  const m = host.match(/const AMMO_CAPABILITIES = escapeAll\(\[([\s\S]*?)\]\);/)
  assert(m, '无法解析 AMMO_CAPABILITIES')
  assert((m[1].match(/"(?:###|[一二三四五六七八九十]+、)/g) || []).length >= 8, '弹药条目偏少')
})
check('写作技巧 + Few-Shot', () => assert(/WRITING_TIPS/.test(host) && /FEW_SHOT/.test(host)))
check('载荷变量转义（防止 {{cwd}} 被误插值）', () => assert(/escapePromptVariables/.test(host)))

console.log('\n[5/6] 组装期真实剥离（唯一能改动宿主的路径）')
check('stripSafetyRules 存在', () => assert(/function\s+stripSafetyRules/.test(host)))
check('挂在 system-prompt/assemble waterfall 上', () =>
  assert(/ctx\.on\(\s*["']system-prompt\/assemble["']/.test(host), '未用 ctx.on("system-prompt/assemble")'),
)
check('waterfall 监听器签名 (assembly, ctx, next)', () =>
  assert(/async\s*\(assembly,\s*_context,\s*next\)/.test(host), '签名不对，拿不到 next'),
)
check('调用 next() 并处理返回值', () => assert(/await\s+next\(\)/.test(host)))
check('不存在的钩子已清除（查代码而非注释）', () => {
  const code = host.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert(!/\bonAssemble\b(?!\s*[，,。])/.test(code), '仍有 onAssemble 调用（宿主无此接口）')
  assert(!/hooks\??\.assemble/.test(code), '仍有 hooks.assemble（宿主无此接口）')
})
check('不再包 async assemble 的退化路径', () =>
  assert(!/ctx\.systemPrompt\.assemble\s*=/.test(host), '仍覆盖宿主 assemble()，会把 Promise 喂给同步剥离器'),
)
check('插件不碰 contexts', () => {
  // 反向断言：曾经的 `assembly.contexts = []` 会误杀 required:true 的事实项。
  // resolveContext()（宿主 lib/index.js:186）只透传 name/text/interpolate，
  // required 到 waterfall 已经不存在，插件没有信息去做正确过滤。
  // 这件事归宿主 suppressRuntimeContext()，插件一碰就错。
  const code = host.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert(!/assembly\.contexts\s*=/.test(code), '仍在改写 contexts，会误杀 required 事实')
  assert(!/stripContexts/.test(code), '仍有 contexts 处理函数')
})
check('自身段落豁免', () => assert(/SELF_PREFIX/.test(host)))

console.log('\n[6/6] 死代码已清除')
check('无 executeClearAll 假清除链路', () => assert(!/executeClearAll/.test(host)))
check('无 deepResidueSweep', () => assert(!/deepResidueSweep/.test(host)))
check('无 liveSectionSnapshot', () => assert(!/liveSectionSnapshot/.test(host)))
check('无 DEEP_RESIDUE_PATTERNS（11 条全部与正文表重复）', () => assert(!/DEEP_RESIDUE_PATTERNS/.test(host)))
check('无 forcedStripped', () => assert(!/forcedStripped/.test(host)))
check('无会话投影 / 全局清除桥', () => {
  assert(!/projectionDef/.test(host), '仍有 projectionDef')
  assert(!/__doroArmor/.test(host), '仍有 __doroArmor 全局桥')
})
check('无悬浮窗相关配置项', () => {
  assert(!/floatingOverlay/.test(host), '仍有 floatingOverlay')
  assert(!/clearAllSafetyRules/.test(host), '仍有 clearAllSafetyRules')
})
check('completeOverride 默认 false', () => {
  const m = host.match(/completeOverride:\s*(true|false)/)
  assert(m && m[1] === 'false', '默认值不是 false，会丢工具说明')
})

console.log('\n[7] cordis.patch.yml 语义')
const patchBody = patch.replace(/^#.*$/gm, '')
check('system-prompt 四键覆盖齐全', () => {
  for (const k of ['includeHarnessIdentity', 'includeRuntimeContext', 'personaPrefix', 'personaSuffix'])
    assert(new RegExp(k).test(patchBody), '缺 ' + k)
})
check('agent-instructions 重新启用（!!js false，不是裸 false）', () => {
  assert(/id:\s*agent-instructions/.test(patchBody), '缺 agent-instructions 条目')
  assert(/disabled:\s*!!js\s*["']false["']/.test(patchBody), '必须是 !!js "false" —— 裸 false 会被 entry schema 拒绝')
})
check('不含裸 disabled: false', () => assert(!/disabled:\s*false\s*$/m.test(patchBody), '裸 false 会让整份 patch 加载失败'))
check('插件 config 与 index.js 默认值一致', () => {
  assert(/completeOverride:\s*false/.test(patchBody), 'patch 里 completeOverride 应为 false')
  assert(/stripSafetyRules:\s*true/.test(patchBody), 'patch 里 stripSafetyRules 应为 true')
})
check('插入本体 id 正确', () => assert(/insert:/.test(patchBody) && /id:\s*doro-armor/.test(patchBody)))

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`)
if (fails.length > 0) {
  console.log('失败项：')
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
console.log('下一步跑真宿主回归：node scripts/probe_assemble.mjs')
