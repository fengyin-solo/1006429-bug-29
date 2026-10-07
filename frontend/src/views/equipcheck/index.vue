<template>
  <section class="page" data-module="equipcheck">
    <header class="page-head">
      <div>
        <h2>设备点检管理</h2>
        <p class="page-desc">维护设备点检记录，围绕点检编号、点检设备、点检部位、点检方法做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记设备点检记录</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportRows">
          {{ exporting ? '正在导出…' : '导出设备点检清单' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '点检人员' && isInspectorBlank(row)">
              <span class="error-text">待补</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设备点检数据，可先登记设备点检记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条设备点检记录（同一台设备重复登记仅计一条）</span>
      <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  patchEntry,
  runAction as applyAction,
  syncRepairsToOverhaul,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('equipcheck')
const columns = ["点检编号", "点检设备", "点检部位", "点检方法", "点检结果", "点检人员", "点检日期", "点检状态"]
const baseActions = ["提交点检", "判定正常", "提出维修"]
const statuses = ["待点检", "点检中", "状态正常", "需维修"]
const statLabels = [
  { label: "待点检设备", status: "待点检" },
  { label: "状态正常设备", status: "状态正常" },
  { label: "需维修设备", status: "需维修" },
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const exporting = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() =>
  statLabels.map((item) => ({
    label: item.label,
    value: rows.value.filter((row) => String(row.status) === item.status).length,
  })),
)

function isInspectorBlank(row: EntryRow): boolean {
  return String(row['点检人员'] ?? '').trim() === ''
}

// 点检人员没填的记录还处于待补状态，先给补录入口，不允许直接往下走。
function actionsFor(row: EntryRow): string[] {
  return isInspectorBlank(row) ? ['补录点检人员'] : baseActions
}

function resetFilters() {
  filters.value = {}
  reload()
}

// 导出严格按当前查询条件取数：取不到数（含点检人员待补）时只提示、不落文件，修好条件可再点一次。
async function exportRows() {
  if (exporting.value) {
    return
  }
  errorMessage.value = ''
  successMessage.value = ''
  exporting.value = true
  try {
    // 让按钮的禁用态先渲染出来，避免连点重复触发。
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    const result = downloadEntries(meta.key, filters.value, columns)
    if (result.ok) {
      successMessage.value = `已按当前查询结果导出 ${total.value} 条设备点检记录`
    } else {
      errorMessage.value = result.message
    }
  } finally {
    exporting.value = false
  }
}

function openCreate() {
  errorMessage.value = '设备点检记录登记入口尚未接入审批流'
}

function fillInspector(row: EntryRow) {
  errorMessage.value = ''
  const name = window.prompt(`请补录点检记录 ${String(row['点检编号'] ?? row.id)} 的点检人员`)
  if (name === null) {
    return
  }
  const result = patchEntry(meta.key, Number(row.id), { 点检人员: name })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = '点检人员已补录，可以重新导出'
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  if (action === '补录点检人员') {
    fillInspector(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  if (action === '提出维修') {
    successMessage.value = '已判定需维修，设备检修待安排清单同步更新'
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 先把已判为需维修的设备对到检修待安排清单，再读页面，保证两边口径一致。
    syncRepairsToOverhaul()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设备点检列表读取失败'
  }
}

onMounted(reload)
</script>
