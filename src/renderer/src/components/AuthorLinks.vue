<script setup lang="ts">
/**
 * AuthorLinks — 顶部作者信息 + 可扩展链接组件。
 *
 * ── 如何新增图标/链接 ─────────────────────────────────────────
 * 在下面「默认配置」的 links 数组里加一行即可。每个链接的图标支持
 * 四种方式（按 iconImg > iconSvg > iconClass > icon 优先级），
 * 只用其中一种：
 *
 *   1) icon: emoji 或短文本（最简单）
 *        { key: 'email', label: '邮箱', icon: '✉️', url: 'mailto:a@b.com' }
 *
 *   2) iconSvg: 内联 SVG 的 path 数据（d 属性，24x24 视口、fill 风格），
 *      可传字符串或字符串数组（多段 path）
 *        { key: 'github', label: 'GitHub',
 *          iconSvg: 'M12 .297c-6.63 0-12 ...', url: 'https://github.com/xx' }
 *
 *   3) iconImg: 图片路径/URL，适合 svg/png 文件或图标资源
 *        import github from '../../assets/github.svg?asset'   // 顶部导入
 *        { key: 'github', label: 'GitHub', iconImg: github, url: '...' }
 *
 *   4) iconClass: CSS 类名，适合 iconfont 等字体图标
 *        { key: 'github', label: 'GitHub', iconClass: 'iconfont icon-github',
 *          url: '...' }
 *
 * 也可以不写死，通过 props 传入覆盖（见 App.vue 用法）。
 * ──────────────────────────────────────────────────────────────
 */
export interface AuthorLink {
  /** 唯一 key（v-for 用） */
  key: string
  /** 悬浮提示文字 */
  label: string
  /** 链接：http(s):// 或 mailto: */
  url: string
  /** 是否新窗口打开（默认 true） */
  newTab?: boolean
  /** 图标方式 1：emoji 或短文本 */
  icon?: string
  /** 图标方式 2：内联 SVG path 的 d 属性（可多个），24x24 视口、fill 风格 */
  iconSvg?: string | string[]
  /** 图标方式 3：图片路径/URL（如 ?asset 导入的 svg/png） */
  iconImg?: string
  /** 图标方式 4：CSS 类名（如 iconfont 字体图标） */
  iconClass?: string
}

const props = withDefaults(
  defineProps<{
    /** 作者名 */
    author?: string
    /** 点击作者名跳转的地址 */
    authorUrl?: string
    /** 链接列表（可覆盖） */
    links?: AuthorLink[]
  }>(),
  {
    author: 'liuchaoxu',
    authorUrl: 'https://github.com/liuchaoxu/STM-Desktop',
    // ── 默认配置：在这里新增图标/链接 ─────────────────────────
    links: () => [
      {
        key: 'github',
        label: 'GitHub',
        iconSvg:
          'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
        url: 'https://github.com/liuchaoxu/STM-Desktop'
      }
      // ,
      // {
      //   key: 'email',
      //   label: '邮箱',
      //   iconSvg: [
      //     'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z'
      //   ],
      //   url: 'mailto:liuchaoxu@example.com'
      // }
    ]
    // ──────────────────────────────────────────────────────────
  }
)

/** 把 iconSvg 的字符串/数组统一成数组（模板渲染多个 <path>）。 */
function pathList(d: string | string[] | undefined): string[] {
  if (!d) return []
  return Array.isArray(d) ? d : [d]
}

/** 通过 window.open 打开（Electron 主进程会转交给系统默认浏览器）。 */
function open(url: string, newTab: boolean): void {
  window.open(url, newTab ? '_blank' : '_self', 'noopener,noreferrer')
}
</script>

<template>
  <div class="author-links">
    <a
      class="author-name"
      :href="props.authorUrl"
      :title="`作者：${props.author}`"
      @click.prevent="open(props.authorUrl, true)"
    >
      <span class="author-avatar">{{ props.author.charAt(0).toUpperCase() }}</span>
      <span class="author-text">{{ props.author }}</span>
    </a>
    <a
      v-for="link in props.links"
      :key="link.key"
      class="author-link"
      :href="link.url"
      :title="link.label"
      :aria-label="link.label"
      @click.prevent="open(link.url, link.newTab !== false)"
    >
      <img v-if="link.iconImg" class="author-link-img" :src="link.iconImg" :alt="link.label" />
      <svg
        v-else-if="link.iconSvg"
        class="author-link-svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path v-for="d in pathList(link.iconSvg)" :key="d" :d="d" />
      </svg>
      <i v-else-if="link.iconClass" class="author-link-class" :class="link.iconClass" />
      <span v-else>{{ link.icon }}</span>
    </a>
  </div>
</template>

<style scoped>
.author-links {
  display: flex;
  align-items: center;
  gap: 6px;
}

.author-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 4px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
}

.author-name:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.author-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
}

.author-text {
  white-space: nowrap;
}

.author-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--panel);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  text-decoration: none;
  transition: color 0.15s, border-color 0.15s, transform 0.15s;
}

.author-link:hover {
  color: var(--accent);
  border-color: var(--accent);
  transform: translateY(-1px);
}

.author-link-svg,
.author-link-img {
  width: 14px;
  height: 14px;
  display: block;
}

.author-link-img {
  object-fit: contain;
}

.author-link-class {
  font-style: normal;
  line-height: 1;
}
</style>
