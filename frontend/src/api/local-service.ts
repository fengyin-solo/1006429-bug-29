import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 判定为需维修的点检记录，要落到设备检修的待安排清单里。
const EQUIPCHECK_KEY = 'equipcheck'
const OVERHAUL_KEY = 'overhaul'
const REPAIR_STATUS = '需维修'
const OVERHAUL_PENDING_STATUS = '待开工'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 空数据的记录：去重标识字段为空，页面和导出都不许出现。
function isEmptyIdentity(row: EntryRow, dedupeField?: string): boolean {
  if (!dedupeField) {
    return false
  }
  return String(row[dedupeField] ?? '').trim() === ''
}

// 同一台设备重复登记只留一条：必填字段（如点检人员）已填的优先，都齐了留最早登记的。
function dedupeRows(rows: EntryRow[], meta: ModuleMeta): EntryRow[] {
  const dedupeField = meta.dedupeField
  if (!dedupeField) {
    return rows
  }
  const required = meta.requiredOnExport ?? []
  const winners = new Map<string, EntryRow>()
  for (const row of rows) {
    const identity = String(row[dedupeField] ?? '').trim()
    const current = winners.get(identity)
    if (!current) {
      winners.set(identity, row)
      continue
    }
    const rowComplete = required.every((field) => String(row[field] ?? '').trim() !== '')
    const currentComplete = required.every((field) => String(current[field] ?? '').trim() !== '')
    if (rowComplete && !currentComplete) {
      winners.set(identity, row)
    }
  }
  return rows.filter((row) => winners.get(String(row[dedupeField] ?? '').trim()) === row)
}

// 页面查询与导出共用这一份取数口径：先过滤空数据，再按筛选条件查询，最后去重。
function queryRows(key: string, filters: Record<string, string> = {}): EntryRow[] {
  const meta = moduleMeta(key)
  const scoped = listRows(key).filter((row) => !isEmptyIdentity(row, meta.dedupeField))
  const matched = filterRows(scoped, filters)
  return dedupeRows(matched, meta)
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = queryRows(key, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 点检判为需维修后，设备检修的待安排清单要跟着更新。
  if (key === EQUIPCHECK_KEY && target === REPAIR_STATUS) {
    syncRepairsToOverhaul()
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 点检记录被拦下待补（点检人员没填）时，用这个入口补录。
export function patchEntry(key: string, id: number, patch: Record<string, string>): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const blankField = Object.entries(patch).find(([, value]) => value.trim() === '')
  if (blankField) {
    return { ok: false, message: `${blankField[0]}不能为空，请补全后再导出` }
  }
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已补录` }
}

// 需维修的设备落到设备检修待安排清单：同一台设备已有检修记录（任意状态）就不重复安排。
export function syncRepairsToOverhaul(): ActionResult {
  const repairs = queryRows(EQUIPCHECK_KEY).filter((row) => String(row.status) === REPAIR_STATUS)
  const overhaulRows = listRows(OVERHAUL_KEY)
  const arranged = new Set(
    overhaulRows.map((row) => String(row['检修设备'] ?? '').trim()).filter((name) => name !== ''),
  )
  const additions: EntryRow[] = []
  const maxId = overhaulRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  for (const repair of repairs) {
    const device = String(repair['点检设备'] ?? '').trim()
    if (device === '' || arranged.has(device)) {
      continue
    }
    const nextId = maxId + additions.length + 1
    additions.push({
      id: nextId,
      status: OVERHAUL_PENDING_STATUS,
      pending: true,
      abnormal: false,
      检修编号: `OVER-${String(nextId).padStart(4, '0')}`,
      检修设备: device,
      检修类别: '点检报修',
      检修班组: '待安排',
      计划工期: '待安排',
      完工日期: '',
      更换备件: '',
      检修状态: OVERHAUL_PENDING_STATUS,
    })
    arranged.add(device)
  }
  if (additions.length > 0) {
    saveRows(OVERHAUL_KEY, [...overhaulRows, ...additions])
  }
  return { ok: true, message: `设备检修待安排清单已同步，新增 ${additions.length} 条` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  // 逗号、引号、换行会把列顶歪，统一加引号转义，保证一列就是一列。
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

// 导出与页面查询同源：按当前筛选条件取数，逐行校必填列，缺一列就拦下整次导出。
// 不抛旧文件：拿不到数直接 throw，由调用方决定提示与重试。
export function exportEntries(
  key: string,
  filters: Record<string, string> = {},
  columns?: string[],
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const exportColumns = columns ?? meta.fields
  const rows = queryRows(key, filters)
  if (rows.length === 0) {
    throw new Error('取不到数：当前查询条件下没有可导出的记录，请调整条件后重新导出')
  }
  const required = meta.requiredOnExport ?? []
  for (const row of rows) {
    const missing = required.filter((field) => String(row[field] ?? '').trim() === '')
    if (missing.length > 0) {
      const code = String(row['点检编号'] ?? row.id)
      throw new Error(
        `取不到数：点检记录 ${code} 的${missing.join('、')}未填写，请先补录后再重新导出`,
      )
    }
  }
  const header = ['编号', ...exportColumns, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(
      [row.id, ...exportColumns.map((field) => row[field] ?? ''), row.status]
        .map(csvCell)
        .join(','),
    )
  }
  const stamp = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const timestamp = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}${pad(
    stamp.getHours(),
  )}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
  return {
    filename: `${meta.name}-清单-${timestamp}.csv`,
    content: `\uFEFF${lines.join('\n')}`,
  }
}

// 返回动作结果：取不到数时不生成、不下载任何文件，页面提示后可以原样再点一次导出。
export function downloadEntries(
  key: string,
  filters: Record<string, string> = {},
  columns?: string[],
): ActionResult {
  let file: { filename: string; content: string }
  try {
    file = exportEntries(key, filters, columns)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '取不到数，导出失败，请重新导出',
    }
  }
  try {
    const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '文件生成失败，请重新导出',
    }
  }
  return { ok: true, message: '导出成功' }
}

export function loadOverview(): OverviewResult {
  const { allRows } = require('@/data/local-store') as typeof import('@/data/local-store')
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
