import { ref } from 'vue'

export interface ToastItem {
  id: number
  type: 'success' | 'error' | 'info'
  text: string
}

const toasts = ref<ToastItem[]>([])
let nextId = 1

export function useToast(): {
  toasts: typeof toasts
  push: (type: ToastItem['type'], text: string) => void
  success: (text: string) => void
  error: (text: string) => void
  info: (text: string) => void
  remove: (id: number) => void
} {
  function push(type: ToastItem['type'], text: string): void {
    const id = nextId++
    toasts.value.push({ id, type, text })
    window.setTimeout(() => remove(id), 4500)
  }
  function remove(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }
  return {
    toasts,
    push,
    success: (text) => push('success', text),
    error: (text) => push('error', text),
    info: (text) => push('info', text),
    remove
  }
}
