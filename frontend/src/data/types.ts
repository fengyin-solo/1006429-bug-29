/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 同一业务对象重复登记时按这个字段去重，只留最新登记的一条（如点检设备）。 */
  dedupField?: string
  /** 导出前必须已填写的字段，有空缺的记录拦下待补、不进导出件。 */
  exportRequiredFields?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type ExportReport = {
  filename: string
  content: string
  /** 实际写进导出件的条数，与页面当前查询结果对齐。 */
  exported: number
  /** 校验未过被拦下待补、未进导出件的条数。 */
  heldBack: number
  /** 本次联动写入设备检修待安排清单的设备数。 */
  syncedToOverhaul: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
