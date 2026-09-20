<script setup lang="ts">
/**
 * Group information editor, shown as a modal over the overview.
 *
 * Edits a local draft so closing without confirming changes nothing; the parent
 * commits it (and validates the name) on `commit`.
 */
import { ref } from 'vue'
import OptionsEditor from './OptionsEditor.vue'
import { GROUP_FIELDS } from './option-fields'

const props = defineProps<{
  name: string
  /** The existing section when the group is declared, null when creating one. */
  original: GroupConfig | null
}>()

const emit = defineEmits<{
  (e: 'commit', draft: GroupConfig): void
  (e: 'close'): void
  (e: 'remove'): void
}>()

const draftName = ref(props.name)
const draftValues = ref<Record<string, string>>({ ...(props.original?.values ?? {}) })
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal modal-wide">
      <header class="modal-head">
        <h2>{{ original ? `编辑组「${name}」` : `创建组配置「${name}」` }}</h2>
        <button class="btn btn-icon" title="关闭" @click="emit('close')">✕</button>
      </header>

      <p class="modal-hint muted">
        组内的隧道共享这里的服务器与认证信息，单条隧道可以覆盖其中任意一项。
      </p>

      <div class="field">
        <label class="field-label" for="group-editor-name">组名</label>
        <input
          id="group-editor-name"
          v-model="draftName"
          class="input mono"
          spellcheck="false"
          placeholder="例如 feishu"
        />
      </div>

      <OptionsEditor v-model="draftValues" :fields="GROUP_FIELDS" />

      <div class="modal-actions">
        <button v-if="original" class="btn btn-danger-ghost" @click="emit('remove')">删除组</button>
        <span class="modal-spacer" />
        <button class="btn" @click="emit('close')">取消</button>
        <button
          class="btn btn-primary"
          @click="emit('commit', { name: draftName, values: draftValues })"
        >
          完成
        </button>
      </div>
    </div>
  </div>
</template>
