<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Combobox from '@/components/ui/Combobox.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Field from '@/components/ui/Field.vue'
import Input from '@/components/ui/Input.vue'
import NumberInput from '@/components/ui/NumberInput.vue'
import Tag from '@/components/ui/Tag.vue'
import { useDictStore } from '@/stores/dictStore'
import type { FieldMapping } from '@/types'

const props = defineProps<{
  /** 字段映射配置列表 */
  modelValue: FieldMapping[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: FieldMapping[]): void
}>()

const dictStore = useDictStore()

/** 主从布局的选中列 */
const selectedName = ref('')
watch(() => props.modelValue, (items) => {
  if (!items.some(item => item.column === selectedName.value)) {
    selectedName.value = items[0]?.column ?? ''
  }
}, { immediate: true, deep: false })
function selectMapping(column: string) {
  selectedName.value = column
}

/** 对齐下拉选项 */
const ALIGN_OPTIONS = [
  { label: '左对齐', value: 'left' },
  { label: '居中', value: 'center' },
  { label: '右对齐', value: 'right' },
]

/** 词典选项，值为字符串形式的词典 id */
const dictOptions = computed(() =>
  dictStore.dictionaries.map(dict => ({ label: dict.name, value: String(dict.id) })),
)

/** 更新某一列的映射 */
function update(index: number, patch: Partial<FieldMapping>) {
  const next = props.modelValue.map((item, i) =>
    i === index ? { ...item, ...patch } : item,
  )
  emit('update:modelValue', next)
}

/** 词典 id → 下拉值（空串 = 不翻译） */
function dictValueOf(mapping: FieldMapping): string {
  return mapping.dictionaryId === undefined || mapping.dictionaryId === null
    ? ''
    : String(mapping.dictionaryId)
}

function setDictionary(index: number, value: string) {
  update(index, { dictionaryId: value === '' ? undefined : Number(value) })
}

function setAlign(index: number, value: string) {
  update(index, { align: value as FieldMapping['align'] })
}

/** 列宽：0 表示自适应 */
function setWidth(index: number, value: number) {
  update(index, { width: value > 0 ? value : undefined })
}

onMounted(() => {
  // 词典未加载时补齐
  if (!dictStore.loaded) {
    void dictStore.loadAll()
  }
})
</script>

<template>
  <div class="tpl-panel-list">
    <EmptyState v-if="!modelValue.length" description="执行查询后会自动列出结果列" />

    <div v-else class="tpl-master">
      <aside class="tpl-master__list" aria-label="字段列表">
        <button v-for="mapping in modelValue" :key="mapping.column" type="button" class="tpl-master__item"
          :class="{ 'is-active': mapping.column === selectedName }" @click="selectMapping(mapping.column)">
          <code>{{ mapping.column }}</code>
          <Tag v-if="mapping.dictionaryId" size="sm" tone="info" effect="plain">词典</Tag>
          <span>{{ mapping.label || '未设置别名' }}</span>
        </button>
      </aside>
      <div class="tpl-master__detail">
        <div v-for="(mapping, index) in modelValue" :key="mapping.column" v-show="mapping.column === selectedName"
          class="tpl-master__detail-item">
          <div v-if="mapping.column === selectedName" v-memo="[mapping, dictOptions]">
            <div class="tpl-panel__form">
              <!-- 列信息与展示 -->
              <section class="tpl-panel__group">
                <div class="tpl-panel__grid">
                  <Field label="展示别名" label-width="76px">
                    <Input :model-value="mapping.label" placeholder="表格列标题，留空用列名"
                      @update:model-value="update(index, { label: $event })" />
                  </Field>

                  <Field label="列宽" label-width="76px">
                    <NumberInput :model-value="mapping.width ?? 0" :min="0" placeholder="自适应"
                      @update:model-value="setWidth(index, $event)" />
                  </Field>

                  <Field label="对齐" label-width="76px">
                    <Combobox :model-value="mapping.align ?? 'left'" :options="ALIGN_OPTIONS"
                      @update:model-value="setAlign(index, $event)" />
                  </Field>
                </div>
              </section>

              <!-- 词典翻译 -->
              <section class="tpl-panel__group">
                <div class="tpl-panel__group-title">词典翻译</div>
                <div class="tpl-panel__grid">
                  <Field label="绑定词典" label-width="76px">
                    <Combobox :model-value="dictValueOf(mapping)" :options="dictOptions" placeholder="不翻译" clearable
                      search-placeholder="搜索词典…" @update:model-value="setDictionary(index, $event)" />
                  </Field>

                  <Field v-if="mapping.dictionaryId" label="展示模板" label-width="76px">
                    <Input :model-value="mapping.template ?? ''"
                      placeholder="&#123;&#123;value&#125;&#125; - &#123;&#123;meaning&#125;&#125;"
                      @update:model-value="update(index, { template: $event })" />
                  </Field>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 具体排版规范见 styles/template-panels.css，这里只保留面板级微调 */
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

.tpl-master__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px 8px;
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

.tpl-master__item code {
  color: var(--brand-color);
  font-family: var(--font-mono);
  font-size: var(--app-font-size-sm);
}

.tpl-master__item span {
  grid-column: 1 / -1;
  overflow: hidden;
  color: var(--text-muted);
  font-size: var(--app-font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
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
