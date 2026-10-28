// 断言 contract-probe 在真实应用里记录的时间线（阶段 B：alert / focus）。
const fs = require('node:fs')

const file = process.argv[2]
const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
const timeline = Array.isArray(raw.timeline) ? raw.timeline : []
console.log('storage 内容：', JSON.stringify(raw, null, 2).slice(0, 1200))
console.log('')
const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail })
const first = (predicate) => timeline.find(predicate)
const last = (predicate) => [...timeline].reverse().find(predicate)
const at = (event) => timeline.filter((entry) => entry.event === event)
const stepTime = (name) => first((entry) => entry.event === 'step' && entry.name === name)?.t

console.log(`时间线共 ${timeline.length} 条：`)
for (const entry of timeline) console.log(`  +${String(entry.t).padStart(5)}ms  ${JSON.stringify(entry)}`)
console.log('')

const alertStep = stepTime('alert')
const focusStep = stepTime('focus')
const collapseStep = stepTime('collapse')

check('插件加载并完成握手', !!raw.report || timeline.length > 0, `报告键=${Object.keys(raw).join(',')}`)

const alertGranted = first((e) => e.event === 'intent' && e.kind === 'alert' && e.result === 'granted')
check('alert → granted 回执', !!alertGranted, JSON.stringify(alertGranted))
check('alert 在下发后 1s 内回执', alertGranted && alertGranted.t - alertStep < 1000, `alert@${alertStep} granted@${alertGranted?.t}`)

const alertVisible = first((e) => e.event === 'visibility' && e.visible === true && e.reason === 'mini' && (!alertGranted || e.t >= alertGranted.t))
check('提醒让小岛从收起横条弹出来（visibility mini）', !!alertVisible, JSON.stringify(alertVisible))

const alertExpired = first((e) => e.event === 'intent' && e.kind === 'alert' && e.result === 'expired')
check('ttl 到期 → expired 回执', !!alertExpired, JSON.stringify(alertExpired))
check('expired 发生在 granted 之后 2~3.5s', alertExpired && alertGranted && (alertExpired.t - alertGranted.t) >= 1900 && (alertExpired.t - alertGranted.t) <= 3500, `${alertGranted?.t} → ${alertExpired?.t}`)

const backToRest = first((e) => e.event === 'visibility' && e.visible === false && e.t >= (alertExpired?.t ?? 0))
check('提醒结束后回到收起态（visibility false）', !!backToRest, JSON.stringify(backToRest))

const focusGranted = first((e) => e.event === 'intent' && e.kind === 'focus' && e.result === 'granted' && e.t >= (focusStep ?? 0))
check('focus → granted 回执', !!focusGranted, JSON.stringify(focusGranted))
const mediumMode = first((e) => e.event === 'mode' && e.mode === 'medium' && e.t >= (focusStep ?? 0))
check('focus 真的把小岛展开到中岛（host:mode=medium）', !!mediumMode, JSON.stringify(mediumMode))
const expandedVisible = first((e) => e.event === 'visibility' && e.visible === true && e.reason === 'expanded' && e.t >= (focusStep ?? 0))
check('展开态可见性 reason=expanded', !!expandedVisible, JSON.stringify(expandedVisible))

const backToMini = first((e) => e.event === 'mode' && e.mode === 'small' && e.t >= (collapseStep ?? 0))
check('ui.collapse() 回到 mini 段（host:mode=small）', !!backToMini, JSON.stringify(backToMini))

let failed = 0
console.log('=== 阶段 B 端到端验收 ===')
for (const item of results) {
  if (!item.ok) failed += 1
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
