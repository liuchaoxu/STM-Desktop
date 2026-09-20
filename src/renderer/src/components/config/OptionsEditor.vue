<script setup lang="ts">
/**
 * The option editor shared by all three config sections.
 *
 * Friendly fields for the common keys on top, a free-form key/value editor for
 * everything else underneath — so advanced options stay reachable without
 * cluttering the form. Replaces the three hand-written forms that used to live
 * in ConfigView with one implementation.
 */
import { computed, ref, useId } from 'vue'
import KeyValueEditor from '../KeyValueEditor.vue'

export interface OptionField {
  key: string
  label: string
  hint?: string
  kind?: 'text' | 'number' | 'password' | 'select' | 'checkbox'
  options?: { value: string; label: string }[]
  placeholder?: string
  /** id of a `<datalist>` to offer as suggestions (e.g. `client-options`). */
  list?: string
  wide?: boolean
}

const props = defineProps<{
  modelValue: Record<string, string>
  fields: OptionField[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: Record<string, string>): void
}>()

/** Unique per instance: several editors can be mounted at once. */
const uid = useId()
const revealed = ref<Set<string>>(new Set())

const formKeys = computed(() => new Set(props.fields.map((field) => field.key)))

/** Options the form does not cover, handed to the key/value editor. */
const advanced = computed(() => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(props.modelValue)) {
    if (!formKeys.value.has(key)) out[key] = value
  }
  return out
})

function fieldId(key: string): string {
  return `${uid}-${key}`
}

function valueOf(key: string): string {
  return props.modelValue[key] ?? ''
}

function setValue(key: string, value: string): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function setAdvanced(next: Record<string, string>): void {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(props.modelValue)) {
    if (formKeys.value.has(key)) merged[key] = value
  }
  emit('update:modelValue', { ...merged, ...next })
}

function toggleReveal(key: string): void {
  if (revealed.value.has(key)) revealed.value.delete(key)
  else revealed.value.add(key)
}
</script>

<template>
  <div class="options-editor">
    <div class="form-grid">
      <div
        v-for="field in fields"
        :key="field.key"
        class="field"
        :class="{ 'field-wide': field.wide }"
      >
        <label class="field-label" :for="fieldId(field.key)">
          {{ field.label }}<span v-if="field.hint" class="hint">（{{ field.hint }}）</span>
        </label>

        <span v-if="field.kind === 'checkbox'" class="check">
          <input
            :id="fieldId(field.key)"
            type="checkbox"
            :checked="valueOf(field.key) !== 'false'"
            @change="
              setValue(field.key, ($event.target as HTMLInputElement).checked ? 'true' : 'false')
            "
          />
          <span class="muted">
            {{ valueOf(field.key) === 'false' ? '已禁用（批量启动时跳过）' : '已启用' }}
          </span>
        </span>

        <select
          v-else-if="field.kind === 'select'"
          :id="fieldId(field.key)"
          class="input"
          :value="valueOf(field.key)"
          @change="setValue(field.key, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">（跟随上层）</option>
          <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <span v-else-if="field.kind === 'password'" class="secret-wrap">
          <input
            :id="fieldId(field.key)"
            class="input mono"
            :type="revealed.has(field.key) ? 'text' : 'password'"
            autocomplete="new-password"
            spellcheck="false"
            :placeholder="field.placeholder"
            :value="valueOf(field.key)"
            @input="setValue(field.key, ($event.target as HTMLInputElement).value)"
          />
          <button
            class="btn btn-icon"
            type="button"
            :title="revealed.has(field.key) ? '隐藏' : '显示'"
            @click="toggleReveal(field.key)"
          >
            {{ revealed.has(field.key) ? '🙈' : '👁' }}
          </button>
        </span>

        <input
          v-else
          :id="fieldId(field.key)"
          class="input mono"
          :list="field.list"
          :inputmode="field.kind === 'number' ? 'numeric' : undefined"
          spellcheck="false"
          :placeholder="field.placeholder"
          :value="valueOf(field.key)"
          @input="setValue(field.key, ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <details class="advanced">
      <summary>高级 / 其他选项</summary>
      <KeyValueEditor
        :model-value="advanced"
        placeholder-key="其他键名"
        @update:model-value="setAdvanced"
      />
    </details>
  </div>
</template>
