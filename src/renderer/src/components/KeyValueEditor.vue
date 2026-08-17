<script setup lang="ts">
import { ref, watch } from 'vue'

export interface CommonKey {
  key: string
  label: string
}

const props = defineProps<{
  modelValue: Record<string, string>
  commonKeys?: CommonKey[]
  placeholderKey?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, string>): void
}>()

interface Row {
  key: string
  value: string
}

const rows = ref<Row[]>([])
const revealed = ref<Set<string>>(new Set())
const newKey = ref('')
const newValue = ref('')

watch(
  () => props.modelValue,
  () => syncFromModel(),
  { immediate: true }
)

function syncFromModel(): void {
  rows.value = Object.entries(props.modelValue).map(([key, value]) => ({ key, value }))
}

function syncToModel(): void {
  const obj: Record<string, string> = {}
  for (const row of rows.value) {
    const key = row.key.trim()
    if (key) obj[key] = row.value
  }
  emit('update:modelValue', obj)
}

function onRowKeyChange(row: Row): void {
  const normalized = row.key.trim().toLowerCase()
  row.key = normalized
  syncToModel()
}

function onValueInput(row: Row, event: Event): void {
  row.value = (event.target as HTMLInputElement).value
  syncToModel()
}

function removeRow(index: number): void {
  rows.value.splice(index, 1)
  syncToModel()
}

function addRow(): void {
  const key = newKey.value.trim().toLowerCase()
  if (!key) return
  if (!props.modelValue[key]) {
    rows.value.push({ key, value: newValue.value })
    syncToModel()
  }
  newKey.value = ''
  newValue.value = ''
}

function addCommon(key: string): void {
  if (!props.modelValue[key]) {
    rows.value.push({ key, value: '' })
    syncToModel()
  }
}

function isSecret(key: string): boolean {
  return /password|passwd|secret|token|passphrase/i.test(key)
}
</script>

<template>
  <div class="kve">
    <div v-if="rows.length === 0" class="kve-empty">（空）</div>
    <div v-for="(row, index) in rows" :key="index" class="kve-row">
      <input
        class="kve-key"
        type="text"
        spellcheck="false"
        placeholder="键名"
        :value="row.key"
        @input="row.key = ($event.target as HTMLInputElement).value"
        @change="onRowKeyChange(row)"
      />
      <input
        class="kve-value"
        :type="isSecret(row.key) && !revealed.has(row.key) ? 'password' : 'text'"
        spellcheck="false"
        placeholder="值"
        :value="row.value"
        @input="onValueInput(row, $event)"
      />
      <button
        v-if="isSecret(row.key)"
        class="btn btn-icon"
        :title="revealed.has(row.key) ? '隐藏' : '显示'"
        @click="revealed.has(row.key) ? revealed.delete(row.key) : revealed.add(row.key)"
      >
        {{ revealed.has(row.key) ? '🙈' : '👁' }}
      </button>
      <button class="btn btn-icon btn-danger" title="删除此项" @click="removeRow(index)">✕</button>
    </div>
    <div class="kve-add">
      <input
        v-model="newKey"
        class="kve-key"
        type="text"
        spellcheck="false"
        :placeholder="placeholderKey ?? '新键名'"
        @keydown.enter.prevent="addRow"
      />
      <input
        v-model="newValue"
        class="kve-value"
        type="text"
        spellcheck="false"
        placeholder="值"
        @keydown.enter.prevent="addRow"
      />
      <button class="btn btn-ghost" @click="addRow">添加</button>
    </div>
    <div v-if="commonKeys && commonKeys.length > 0" class="kve-quick">
      <span class="kve-quick-label">常用字段：</span>
      <button
        v-for="ck in commonKeys"
        :key="ck.key"
        class="chip"
        :disabled="modelValue[ck.key] !== undefined"
        :title="modelValue[ck.key] !== undefined ? '已存在' : `添加 ${ck.key}`"
        @click="addCommon(ck.key)"
      >
        {{ ck.label }}
      </button>
    </div>
  </div>
</template>
