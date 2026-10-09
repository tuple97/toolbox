<script setup lang="ts">
/** 模板片段选择弹窗：左分类 + 片段列表，右预览 */
import { computed, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Icon from '@/components/ui/Icon.vue'
import { copyText } from '@/utils/clipboard'
import { notify } from '@/utils/notify'
import { SNIPPET_CATEGORIES, SQL_SNIPPETS } from '@/utils/sql/sqlSnippets'
import type { SqlSnippet } from '@/utils/sql/sqlSnippets'
import type { ContextMenuAction } from '@/types'

const props = withDefaults(defineProps<{
  /** 是否显示（v-model） */
  modelValue: boolean
  /** 弹窗标题 */
  title?: string
}>(), {
  title: '插入模板片段',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  /** 确认插入某段片段 */
  (e: 'insert', snippet: SqlSnippet): void
}>()

/** 分类 → 图标名（见 utils/icons.ts）；未登记的退回文档图标 */
const CATEGORY_ICONS: Record<string, string> = {
  条件: 'branch',
  循环: 'repeat',
  变量: 'braces',
  自定义函数: 'function',
  内置函数: 'box',
  其他: 'more',
}

/** 当前选中的分类 */
const category = ref<string>(SNIPPET_CATEGORIES[0])
/** 分类按钮选项（图标按钮） */
const categories = computed(() =>
  SNIPPET_CATEGORIES.map(item => ({
    value: item,
    label: item,
    icon: CATEGORY_ICONS[item] ?? 'document',
  })))
/** 当前分类下的片段 */
const visibleSnippets = computed(() =>
  SQL_SNIPPETS.filter(item => item.category === category.value))
/** 当前选中的片段 */
const selected = ref<SqlSnippet>(SQL_SNIPPETS[0])

// ------------------------------------------------------------ 代码块复制

/** 「插入内容 / 示例」两块代码的右键菜单（全局已关掉系统菜单，见 main.ts） */
const codeMenuVisible = ref(false)
const codeMenuX = ref(0)
const codeMenuY = ref(0)
/** 本次要复制的文本（右键命中的那一块，或块内选中的那一段） */
const codeMenuText = ref('')

/** 菜单项：单条「复制」 */
const CODE_MENU_ITEMS: ContextMenuAction[] = [{ key: 'copy', label: '复制' }]

/** 打开代码块的右键菜单（块内有选中时只复制选中的那段） */
function openCodeMenu(event: MouseEvent, fullText: string) {
  const host = event.currentTarget as HTMLElement | null
  const selection = window.getSelection()
  const picked = selection?.toString() ?? ''
  const anchor = selection?.anchorNode ?? null
  const inBlock = Boolean(host && picked && anchor && host.contains(anchor))

  codeMenuText.value = inBlock ? picked : fullText
  codeMenuX.value = event.clientX
  codeMenuY.value = event.clientY
  codeMenuVisible.value = true
}

/** 复制菜单项：失败时提示 */
async function handleCodeMenuSelect(item: ContextMenuAction) {
  if (item.key !== 'copy' || !codeMenuText.value) {
    return
  }
  try {
    await copyText(codeMenuText.value)
    notify.success('已复制')
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 打开弹窗时默认选中该分类的第一项 */
watch(() => props.modelValue, (open) => {
  if (!open) {
    return
  }
  const first = visibleSnippets.value[0]
  if (first) {
    selected.value = first
  }
})
</script>

<template>
  <Dialog
    :model-value="modelValue"
    :title="title"
    :width="860"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="snippet">
      <!-- 左：分类 + 片段列表 -->
      <aside class="snippet__list">
        <div class="snippet__cats" role="tablist" aria-label="片段分类">
          <button
            v-for="item in categories"
            :key="item.value"
            type="button"
            role="tab"
            class="snippet__cat"
            :class="{ 'is-active': category === item.value }"
            :aria-selected="category === item.value"
            :title="item.label"
            @click="category = item.value"
          >
            <Icon :name="item.icon" />
          </button>
        </div>

        <ul class="snippet__items">
          <li
            v-for="item in visibleSnippets"
            :key="item.id"
            class="snippet__item"
            :class="{ 'is-active': selected.id === item.id }"
            @click="selected = item"
            @dblclick="emit('insert', item)"
          >
            {{ item.name }}
          </li>
        </ul>
      </aside>

      <!-- 右：预览 -->
      <section v-if="selected" class="snippet__preview">
        <h4 class="snippet__title">{{ selected.name }}</h4>
        <p class="snippet__desc">{{ selected.description }}</p>

        <div class="snippet__block">
          <div class="snippet__block-label">插入内容</div>
          <!-- selectable：允许选中文本 -->
          <pre
            class="snippet__code selectable"
            @contextmenu.prevent="openCodeMenu($event, selected.code)"
          >{{ selected.code }}</pre>
        </div>

        <div class="snippet__block">
          <div class="snippet__block-label">示例</div>
          <pre
            class="snippet__code snippet__code--example selectable"
            @contextmenu.prevent="openCodeMenu($event, selected.example)"
          >{{ selected.example }}</pre>
        </div>
      </section>
    </div>

    <template #footer>
      <Button variant="secondary" size="sm" @click="emit('update:modelValue', false)">关闭</Button>
      <Button size="sm" @click="emit('insert', selected)">
        插入
      </Button>
    </template>
  </Dialog>

  <ContextMenu
    v-model:visible="codeMenuVisible"
    :x="codeMenuX"
    :y="codeMenuY"
    :items="CODE_MENU_ITEMS"
    @select="handleCodeMenuSelect"
  />
</template>

<style scoped>
/* 片段选择弹窗：左列表 / 右预览 */
.snippet {
  display: flex;
  gap: 14px;
  min-height: 380px;
}

.snippet__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 0 0 300px;
}

.snippet__cats {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

/* 分类图标按钮：选中用品牌色 */
.snippet__cat {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(30px * var(--app-control-scale));
  height: calc(30px * var(--app-control-scale));
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-size: calc(16px * var(--app-control-scale));
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.snippet__cat:hover {
  background: var(--hover-bg);
  color: var(--text-color);
}

.snippet__cat.is-active {
  border-color: color-mix(in srgb, var(--brand-color) 45%, transparent);
  background: var(--active-bg);
  color: var(--brand-color);
}

.snippet__items {
  flex: 1;
  margin: 0;
  padding: 4px;
  list-style: none;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.snippet__item {
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: var(--app-font-size);
}

.snippet__item:hover {
  background: var(--hover-bg);
}

.snippet__item.is-active {
  background: var(--active-bg);
}

.snippet__preview {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.snippet__title {
  margin: 0;
  font-size: var(--app-font-size-lg);
}

.snippet__desc {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.6;
}

.snippet__block-label {
  margin-bottom: 4px;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
}

.snippet__code {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--surface-color);
  color: var(--text-color);
  font-family: var(--font-mono);
  font-size: var(--app-font-size-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  /* 可选中：鼠标形状提示能划词 */
  cursor: text;
}

.snippet__code--example {
  color: var(--text-muted);
}
</style>
