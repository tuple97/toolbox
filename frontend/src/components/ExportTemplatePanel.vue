<script setup lang="ts">
/** 导出模板配置面板：左列表 + 右详细配置（名称 / 内容 / 启用） */
import { computed, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import CodeEditor from '@/components/CodeEditor.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Field from '@/components/ui/Field.vue'
import Icon from '@/components/ui/Icon.vue'
import Input from '@/components/ui/Input.vue'
import SqlSnippetPicker from '@/components/SqlSnippetPicker.vue'
import Switch from '@/components/ui/Switch.vue'
import Tag from '@/components/ui/Tag.vue'
import type { SqlSnippet } from '@/utils/sql/sqlSnippets'
import type { CompletionRuntime } from '@/utils/sql/sqlCompletion'
import type { ExportTemplate } from '@/types'

const props = withDefaults(defineProps<{
  /** 导出模板列表 */
  modelValue: ExportTemplate[]
  /** 当前模板绑定的连接类型，决定编辑器方言 */
  dbType?: string
  /** 编辑器补全上下文（连接 / 库 / 方言），由父级注入 */
  completionContext?: () => Partial<CompletionRuntime> | undefined
}>(), {
  dbType: '',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: ExportTemplate[]): void
}>()

/** 新建模板的初始内容 */
const DEFAULT_CONTENT = 'INSERT INTO table_name (column_name) VALUES ({{ quote column_name }});'

/** 默认选中第一条；当前项被删掉时回退到首项 */
const selectedId = ref('')
watch(() => props.modelValue, (items) => {
  if (!items.some(item => item.id === selectedId.value)) {
    selectedId.value = items[0]?.id ?? ''
  }
}, { immediate: true, deep: false })

/** 当前选中的导出模板（右侧详细配置的数据源） */
const selected = computed(
  () => props.modelValue.find(item => item.id === selectedId.value) ?? null,
)

/** 当前模板内容（双向绑定到编辑器） */
const content = computed({
  get: () => selected.value?.content ?? '',
  set: (value: string) => {
    if (selected.value) {
      update(selected.value.id, { content: value })
    }
  },
})

/** 更新某一个导出模板 */
function update(id: string, patch: Partial<ExportTemplate>) {
  emit('update:modelValue', props.modelValue.map(item =>
    item.id === id ? { ...item, ...patch } : item))
}

/** 是否启用（缺字段视为启用） */
function isEnabled(item: ExportTemplate): boolean {
  return item.enabled !== false
}

/** 切换启用状态 */
function setEnabled(id: string, value: boolean) {
  update(id, { enabled: value })
}

/** 生成模板内唯一的标识 */
function nextId(): string {
  return `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 新建导出模板并选中 */
function addTemplate() {
  const item: ExportTemplate = {
    id: nextId(),
    name: `导出模板${props.modelValue.length + 1}`,
    content: DEFAULT_CONTENT,
    enabled: true,
  }
  emit('update:modelValue', [...props.modelValue, item])
  selectedId.value = item.id
}

/** 删除导出模板 */
function removeTemplate(id: string) {
  emit('update:modelValue', props.modelValue.filter(item => item.id !== id))
}

// ------------------------------------------------------------ 片段插入

/** 内容编辑器实例 */
const contentEditorRef = ref<InstanceType<typeof CodeEditor> | null>(null)
/** 片段选择弹窗 */
const snippetVisible = ref(false)

/** 把片段插入到光标处 */
function insertSnippet(snippet: SqlSnippet) {
  if (!contentEditorRef.value?.insertTemplateText(snippet.code)) {
    return
  }
  snippetVisible.value = false
}
</script>

<template>
  <div class="tpl-panel-list">
    <div class="tpl-master">
      <!-- 左：导出模板列表 -->
      <aside class="tpl-master__list" aria-label="导出模板列表">
        <div class="tpl-master__head">
          <span>导出模板</span>
          <Button size="sm" @click="addTemplate">
            <Icon name="plus" />
            <span>新建</span>
          </Button>
        </div>

        <button v-for="item in modelValue" :key="item.id" type="button" class="tpl-master__item"
          :class="{ 'is-active': item.id === selectedId, 'is-disabled': !isEnabled(item) }"
          @click="selectedId = item.id">
          <span class="tpl-master__name">
            <span class="tpl-master__name-text">{{ item.name || '未命名' }}</span>
            <Tag v-if="!isEnabled(item)" size="sm" tone="warning" effect="plain">已停用</Tag>
          </span>
          <Icon name="trash" class="tpl-master__del" title="删除" @click.stop="removeTemplate(item.id)" />
          <code class="tpl-master__preview">{{ item.content || '（内容为空）' }}</code>
        </button>

        <p v-if="!modelValue.length" class="tpl-master__empty">
          暂无导出模板，点击「新建」添加
        </p>
      </aside>

      <!-- 右：详细配置 -->
      <div class="tpl-master__detail">
        <div v-if="selected" class="tpl-panel__form">
          <section class="tpl-panel__group">
            <div class="tpl-panel__grid">
              <Field label="模板名称" label-width="76px">
                <Input :model-value="selected.name" placeholder="名称"
                  @update:model-value="update(selected.id, { name: $event })" />
              </Field>

              <Field label="启用" label-width="76px">
                <div class="tpl-panel__switch-row">
                  <Switch :model-value="isEnabled(selected)" @update:model-value="setEnabled(selected.id, $event)" />
                </div>
              </Field>
            </div>
          </section>

          <section class="tpl-panel__group">
            <div class="tpl-panel__group-head">
              <div class="tpl-panel__group-title">模板内容</div>
              <Button variant="secondary" size="sm" @click="snippetVisible = true">
                <Icon name="plus" />
                <span>插入模板</span>
              </Button>
            </div>

            <div class="tpl-panel__editor">
              <CodeEditor ref="contentEditorRef" :key="selected.id" v-model="content" language="sql"
                completion-mode="sql-template" height="220px" :db-type="dbType"
                :completion-context="completionContext" />
            </div>
          </section>
        </div>

        <EmptyState v-else description="新建一个导出模板" />
      </div>
    </div>

    <SqlSnippetPicker v-model="snippetVisible" @insert="insertSnippet" />
  </div>
</template>

<style scoped>
/* 排版规范见 styles/template-panels.css */
.tpl-panel-list {
  padding: 2px 0;
}

.tpl-master {
  display: grid;
  grid-template-columns: minmax(180px, 26%) minmax(0, 1fr);
  min-height: 300px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  background: color-mix(in srgb, var(--bg-color) 88%, var(--brand-color));
}

.tpl-master__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 4px 0;
  border-right: 1px solid var(--border-color);
  background: var(--bg-color-soft);
  overflow: auto;
}

.tpl-master__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color);
  font-size: var(--app-font-size-sm);
  font-weight: 600;
}

.tpl-master__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 8px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 0;
  color: var(--text-color);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.tpl-master__item:hover {
  background: var(--hover-bg);
}

.tpl-master__item.is-active {
  background: var(--active-bg);
  box-shadow: inset 3px 0 0 var(--brand-color);
}

.tpl-master__name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--app-font-size-sm);
}

.tpl-master__name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 停用的模板：整体压暗，但保持可点（还要进去重新启用） */
.tpl-master__item.is-disabled .tpl-master__name-text,
.tpl-master__item.is-disabled .tpl-master__preview {
  opacity: 0.55;
}

.tpl-master__preview {
  grid-column: 1 / -1;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--app-font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tpl-master__del {
  flex: 0 0 auto;
  color: var(--text-muted);
  opacity: 0;
}

.tpl-master__item:hover .tpl-master__del {
  opacity: 1;
}

.tpl-master__del:hover {
  color: var(--danger-color);
}

.tpl-master__empty {
  padding: 16px 12px;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  text-align: center;
}

.tpl-master__detail {
  min-width: 0;
  padding: 16px 18px;
  overflow: auto;
}

@media (max-width: 720px) {
  .tpl-master {
    grid-template-columns: 1fr;
  }

  .tpl-master__list {
    max-height: 150px;
    border-right: 0;
    border-bottom: 1px solid var(--border-color);
  }
}
</style>
