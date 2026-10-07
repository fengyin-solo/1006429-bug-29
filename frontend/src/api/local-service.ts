import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ExportReport,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 设备点检 → 设备检修 的联动关系：点检判出需维修、或记录对不上被拦下待补，
// 都要在检修模块的待安排清单里落一条，设备名逐字对齐，同一台设备只留一条。
const EQUIPCHECK_KEY = 'equipcheck'
const OVERHAUL_KEY = 'overhaul'
const NEEDS_REPAIR_STATUS = '需维修'
const CHECK_DEVICE_FIELD = '点检设备'
const OVERHAUL_DEVICE_FIELD = '检修设备'
const OVERHAUL_PENDING_STATUS = '待开工'
const OVERHAUL_CATEGORY_REPAIR = '点检判定需维修'
const OVERHAUL_CATEGORY_INCOMPLETE = '点检数据待补'

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

// 同一台设备重复登记只留一条：留最新登记（id 最大）的那条，没填设备名的不参与去重。
function dedupRows(rows: EntryRow[], meta: ModuleMeta): EntryRow[] {
  const field = meta.dedupField
  if (!field) {
    return rows
  }
  const latestByKey = new Map<string, EntryRow>()
  for (const row of rows) {
    const keyValue = String(row[field] ?? '').trim()
    if (keyValue === '') {
      latestByKey.set(`__row_${row.id}`, row)
      continue
    }
    const prev = latestByKey.get(keyValue)
    if (!prev || Number(row.id) > Number(prev.id)) {
      latestByKey.set(keyValue, row)
    }
  }
  const keptIds = new Set([...latestByKey.values()].map((row) => Number(row.id)))
  return rows.filter((row) => keptIds.has(Number(row.id)))
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const meta = moduleMeta(key)
  const matched = dedupRows(filterRows(listRows(key), filters), meta)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 把需要跟进的点检记录落到设备检修的待安排清单：已有待安排记录的设备只更新类别，
// 没有才新建，重复执行不会堆出重复记录。返回本次覆盖到的设备数。
function syncOverhaulSchedule(checkRows: EntryRow[], category: string): number {
  const devices = [
    ...new Set(
      checkRows
        .map((row) => String(row[CHECK_DEVICE_FIELD] ?? '').trim())
        .filter((device) => device !== ''),
    ),
  ]
  if (devices.length === 0) {
    return 0
  }
  const next = [...listRows(OVERHAUL_KEY)]
  let nextId = next.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  let synced = 0
  for (const device of devices) {
    const existing = next.findIndex(
      (row) =>
        String(row[OVERHAUL_DEVICE_FIELD] ?? '') === device &&
        row.status === OVERHAUL_PENDING_STATUS,
    )
    if (existing >= 0) {
      if (next[existing]['检修类别'] !== category) {
        next[existing] = { ...next[existing], 检修类别: category }
      }
      synced += 1
      continue
    }
    const id = nextId
    nextId += 1
    next.push({
      id,
      status: OVERHAUL_PENDING_STATUS,
      pending: true,
      abnormal: false,
      检修编号: `OVER-${String(id).padStart(4, '0')}`,
      [OVERHAUL_DEVICE_FIELD]: device,
      检修类别: category,
      检修班组: '待安排',
      计划工期: '待定',
      完工日期: '待定',
      更换备件: '待定',
      检修状态: OVERHAUL_PENDING_STATUS,
    })
    synced += 1
  }
  saveRows(OVERHAUL_KEY, next)
  return synced
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
  // 点检判出需维修，设备检修的待安排清单跟着更新。
  if (key === EQUIPCHECK_KEY && target === NEEDS_REPAIR_STATUS) {
    syncOverhaulSchedule([updated], OVERHAUL_CATEGORY_REPAIR)
    return {
      ok: true,
      message: `${meta.entity}已${action}，当前状态「${target}」，已同步到设备检修待安排清单`,
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// CSV 单元格转义：含逗号、引号、换行的值整体加引号，保证文件里的字跟页面上逐字一样。
function csvCell(value: string | number | boolean): string {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 导出取数与页面完全同一条链路：同一组筛选条件、同一份去重结果。
// 先校必填字段（点检人员等），空数据的拦下待补、不进导出件；
// 被拦下的和判了需维修的，一并落到设备检修的待安排清单。
// 一条都导不出来时抛错，页面提示取不到数，可以调整条件后重新导出。
export function buildExport(key: string, filters: Record<string, string> = {}): ExportReport {
  const meta = moduleMeta(key)
  const { items } = listEntries(key, filters)
  if (items.length === 0) {
    throw new Error(`${meta.name}取不到数：当前查询条件下没有记录，请调整条件后重新导出`)
  }
  const required = meta.exportRequiredFields ?? []
  const ready: EntryRow[] = []
  const heldBackRows: EntryRow[] = []
  for (const row of items) {
    const missing = required.filter((field) => String(row[field] ?? '').trim() === '')
    if (missing.length > 0) {
      heldBackRows.push(row)
    } else {
      ready.push(row)
    }
  }
  let syncedToOverhaul = 0
  if (key === EQUIPCHECK_KEY) {
    syncedToOverhaul += syncOverhaulSchedule(heldBackRows, OVERHAUL_CATEGORY_INCOMPLETE)
    syncedToOverhaul += syncOverhaulSchedule(
      ready.filter((row) => row.status === NEEDS_REPAIR_STATUS),
      OVERHAUL_CATEGORY_REPAIR,
    )
  }
  if (ready.length === 0) {
    throw new Error(
      `${meta.name}取不到数：${heldBackRows.length} 条记录有点检人员等空数据待补，已拦下并转入设备检修待安排清单`,
    )
  }
  const header = [...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of ready) {
    lines.push(
      [...meta.fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','),
    )
  }
  return {
    filename: `${meta.name}-清单.csv`,
    content: `\uFEFF${lines.join('\r\n')}`,
    exported: ready.length,
    heldBack: heldBackRows.length,
    syncedToOverhaul,
  }}

// 每次点击都重新取数、重新生成文件；取不到数时抛错，不会把上一次的旧文件当新的发下去。
export function downloadEntries(key: string, filters: Record<string, string> = {}): ExportReport {
  const report = buildExport(key, filters)
  const blob = new Blob([report.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = report.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return report
}

export function loadOverview(): OverviewResult {
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
