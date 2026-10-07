/**
 * 校验 market-entry.yml 是否满足目录的机械要求。
 *
 * 目录 CI 会做：YAML 合法性、description.en 必填、含 ": " 必须加引号、
 * url 与仓库地址一致。这里用最朴素的方式自查（不引第三方 YAML 库，
 * 因为仓库刻意零依赖）。
 *
 * 运行： node scripts/check-market-entry.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.resolve(HERE, '../market-entry.yml')
const text = fs.readFileSync(FILE, 'utf8')

let failures = 0
function ok(msg) { console.log('  [ok] ' + msg) }
function bad(msg) { console.error('  [FAIL] ' + msg); failures++ }

console.log('=== 校验 market-entry.yml ===')

// 1) 必须只有顶层键，且注释不干扰
const lines = text.split(/\r?\n/)
const topKeys = []
let inDesc = false
const descLines = []
for (const raw of lines) {
  if (/^\s*#/.test(raw) || raw.trim() === '') continue
  if (/^(\w[\w-]*):/.test(raw)) {
    const m = /^(\w[\w-]*):(.*)$/.exec(raw)
    topKeys.push(m[1])
    inDesc = m[1] === 'description'
    if (!inDesc && m[2].trim() === '') bad(`${m[1]} 的值为空`)
    continue
  }
  if (inDesc) descLines.push(raw)
}

const allowed = ['url', 'name', 'category', 'description', 'tarball']
for (const k of topKeys) {
  if (!allowed.includes(k)) bad(`出现了目录不认识的顶层键: ${k}`)
}
for (const need of ['url', 'name', 'category', 'description']) {
  if (!topKeys.includes(need)) bad(`缺少必需的顶层键: ${need}`)
}
if (failures === 0) ok('顶层键齐全且都是目录接受的键: ' + topKeys.join(', '))

// 2) 占位符必须已经替换掉
if (text.includes('<you>')) bad('还残留 <you> 占位符，必须换成真实 GitHub 用户名')
else ok('没有残留占位符')

// 3) url 必须是 https 的 GitHub 仓库地址
const urlM = /^url:\s*(\S+)\s*$/m.exec(text)
if (!urlM) bad('读不到 url')
else {
  const url = urlM[1]
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(url)) bad('url 不是规范的 GitHub 仓库地址: ' + url)
  else ok('url 规范: ' + url)
}

// 4) category 必须在目录给出的取值集合里
const VALID = ['agi','ui','usage','theme','model','identity','session','memory','tools','wsl','browser',
  'vision','voice','docs','skill','workflow','git','notify','dev','security','remote','market','fun']
const catM = /^category:\s*(\S+)\s*$/m.exec(text)
if (!catM) bad('读不到 category')
else if (!VALID.includes(catM[1])) bad(`category 不在允许集合里: ${catM[1]}`)
else ok('category 合法: ' + catM[1])

// 5) description.en 必填，且含 ": " 时必须加引号
const enLine = descLines.find((l) => /^\s*en:/.test(l))
const zhLine = descLines.find((l) => /^\s*zh:/.test(l))
if (!enLine) bad('缺少 description.en（目录要求必填）')
else {
  ok('description.en 存在')
  const quoted = /^\s*en:\s*(['"])/.test(enLine)
  const value = enLine.replace(/^\s*en:\s*/, '')
  if (!quoted && /:\s/.test(value)) {
    bad('description.en 含 ": " 却没有加引号，YAML 会解析失败')
  } else {
    ok('description.en 的引号使用正确')
  }
  // 目录会对照代码核验描述，这里挡住明显的过度承诺
  const overclaims = ['best', 'fastest', 'the only', 'most powerful', '史上', '最强', '唯一']
  for (const w of overclaims) {
    if (value.toLowerCase().includes(w)) bad(`描述含营销词「${w}」，目录明确会因此打回`)
  }
}
if (zhLine) ok('description.zh 存在（可选，但更完整）')

// 6) 文件名约定：<owner>__<repo>.yml
const url = urlM ? urlM[1] : ''
if (url) {
  const repo = url.replace('https://github.com/', '')
  const owner = repo.split('/')[0]
  const expected = `${owner}__${repo.split('/')[1]}.yml`
  ok('提交时的目标文件名应为: data/plugins/' + expected)
}

console.log('')
if (failures === 0) console.log('全部通过。')
else { console.error(`${failures} 项未通过。`); process.exit(1) }
