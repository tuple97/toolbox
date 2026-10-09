<script setup lang="ts">
import { computed, onMounted, reactive, watch } from 'vue'
import Combobox from '@/components/ui/Combobox.vue'
import DateInput from '@/components/ui/DateInput.vue'
import Input from '@/components/ui/Input.vue'
import MultiSelect from '@/components/ui/MultiSelect.vue'
import Slider from '@/components/ui/Slider.vue'
import Switch from '@/components/ui/Switch.vue'
import { cn } from '@/lib/utils'
import { fetchVariableOptions } from '@/api/db'
import type { VariableConfig, VariableOption } from '@/types'

const props = withDefaults(defineProps<{
  /** 变量配置列表 */
  configs: VariableConfig[]
  /** 当前连接 ID */
  connId: number | null
  /**
   * 当前选中的库 / 模式。
   *
   * 动态选项 SQL 在这里执行（后端会把它钉在会话上，语义与查询、命令执行器一致）；
   * 空表示用连接配置里的默认库。
   */
  database?: string
  /** 多个变量是否横向排布 */
  inline?: boolean
}>(), {
  database: '',
  inline: false,
})

const emit = defineEmits<{
  (e: 'change', values: Record<string, unknown>): void
  /** 条件区按下回车 */
  (e: 'submit'): void
}>()

/** 各变量的当前取值 */
const values = reactive<Record<string, unknown>>({})
/** 动态选项缓存：变量名 → 选项列表 */
const dynamicOptions = reactive<Record<string, VariableOption[]>>({})
/** 动态选项加载状态 */
const loadingOptions = reactive<Record<string, boolean>>({})

/** 应用默认值 */
function applyDefaults() {
  for (const config of props.configs) {
    if (values[config.name] === undefined) {
      values[config.name] = config.defaultValue ?? defaultForType(config)
    }
  }
}

/** 该变量是否使用下拉选项 */
function usesOptions(config: VariableConfig): boolean {
  return config.component === 'select' || config.component === 'multi-select'
}

/** 读取变量当前值 */
function getValue(config: VariableConfig): unknown {
  const current = values[config.name]
  if (current !== undefined) {
    return current
  }
  return defaultForType(config)
}

/** 写入变量值 */
function setValue(config: VariableConfig, value: unknown) {
  values[config.name] = value
  notifyChange()
}

/** 读取字符串值 */
function getStringValue(config: VariableConfig): string {
  const current = getValue(config)
  return current === null || current === undefined ? '' : String(current)
}

/** 读取数组值 */
function getArrayValue(config: VariableConfig): string[] {
  const current = getValue(config)
  return Array.isArray(current) ? (current as string[]) : []
}

/** 读取数字值 */
function getNumberValue(config: VariableConfig): number {
  const current = getValue(config)
  const parsed = Number(current)
  return Number.isFinite(parsed) ? parsed : (config.min ?? 0)
}

/** 读取布尔值 */
function getBooleanValue(config: VariableConfig): boolean {
  return Boolean(getValue(config))
}

/** 按数据类型给出合理默认值 */
function defaultForType(config: VariableConfig): unknown {
  switch (config.dataType) {
    case 'int':
    case 'float':
      return config.min ?? 0
    case 'bool':
      return false
    case 'date':
      return ''
    default:
      return config.component === 'multi-select' ? [] : ''
  }
}

/** 动态选项实际使用的连接：变量自己配了数据源就用它，缺省跟随当前标签页 */
function optionConnId(config: VariableConfig): number {
  return config.dynamicOptions?.connId ?? props.connId ?? 0
}

/** 动态选项实际使用的库 / 模式：变量自身的优先，缺省或留空都跟随当前标签页 */
function optionDatabase(config: VariableConfig): string {
  return config.dynamicOptions?.database || props.database
}

/** 拉取动态选项 */
async function loadDynamicOptions(config: VariableConfig) {
  const dynamic = config.dynamicOptions
  const connId = optionConnId(config)
  if (!dynamic?.sql || !connId) {
    return
  }

  loadingOptions[config.name] = true
  try {
    const rows = await fetchVariableOptions(connId, optionDatabase(config), dynamic.sql)
    dynamicOptions[config.name] = rows.map((row) => {
      const value = row[dynamic.valueColumn]
      const label = row[dynamic.labelColumn]
      return {
        value: value === null || value === undefined ? '' : String(value),
        label: label === null || label === undefined ? String(value ?? '') : String(label),
      }
    })
  }
  catch {
    dynamicOptions[config.name] = []
  }
  finally {
    loadingOptions[config.name] = false
  }
}

/** 取某变量最终可用的选项列表 */
function optionsFor(config: VariableConfig): VariableOption[] {
  return dynamicOptions[config.name] ?? config.options ?? []
}

/** 是否占用整行 */
function isFullWidthItem(config: VariableConfig): boolean {
  return config.component === 'textarea' || config.component === 'slider'
}

/** 值变化后通知外部，并把值按数据类型转换 */
function notifyChange() {
  const converted: Record<string, unknown> = {}
  for (const config of props.configs) {
    converted[config.name] = convertValue(values[config.name], config.dataType)
  }
  emit('change', converted)
}

/** 按数据类型转换取值 */
function convertValue(value: unknown, dataType: VariableConfig['dataType']): unknown {
  if (value === null || value === undefined || value === '') {
    return value
  }
  switch (dataType) {
    case 'int': {
      const num = Number.parseInt(String(value), 10)
      return Number.isNaN(num) ? value : num
    }
    case 'float': {
      const num = Number.parseFloat(String(value))
      return Number.isNaN(num) ? value : num
    }
    case 'bool':
      return Boolean(value)
    default:
      return value
  }
}

/** 暴露当前取值，供父组件读取 */
function getValues(): Record<string, unknown> {
  const converted: Record<string, unknown> = {}
  for (const config of props.configs) {
    converted[config.name] = convertValue(values[config.name], config.dataType)
  }
  return converted
}

defineExpose({ getValues, notifyChange })

onMounted(() => {
  applyDefaults()
  for (const config of props.configs) {
    void loadDynamicOptions(config)
  }
  notifyChange()
})

/** 变量配置变化时同步默认值与动态选项 */
watch(
  () => props.configs.map(c => c.name).join('|'),
  () => {
    applyDefaults()
    for (const config of props.configs) {
      if (usesOptions(config) && !dynamicOptions[config.name]) {
        void loadDynamicOptions(config)
      }
    }
    notifyChange()
  },
)

/**
 * 取数来源签名：当前连接、当前库，以及每个变量自己的覆盖项。
 *
 * 任一变化都要重拉——缓存里的选项属于上一个库，不重拉的话切库后
 * 下拉里还是旧库的字典值（拉取结果会原地覆盖，无需先清空）。
 */
const optionSourceKey = computed(() => [
  props.connId ?? '',
  props.database,
  ...props.configs.map(config =>
    `${config.name}::${config.dynamicOptions?.connId ?? ''}::${config.dynamicOptions?.database ?? ''}`),
].join('|'))

watch(optionSourceKey, () => {
  for (const config of props.configs) {
    void loadDynamicOptions(config)
  }
})
</script>

<template>
  <div class="dynamic-form py-1">
    <p v-if="!configs.length" class="dynamic-form__empty">
      模板中未检测到变量。在 SQL 中使用 <code>&#123;&#123; 变量名 &#125;&#125;</code> 即可自动识别。
    </p>

    <!-- 横向模式：条件名与控件同一行 -->
    <form
      v-else
      :class="inline
        ? 'grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] items-center gap-x-4.5 gap-y-2.5'
        : 'flex flex-col gap-3'"
      @submit.prevent="emit('submit')"
    >
      <div
        v-for="config in configs"
        :key="config.name"
        :class="cn(
          inline ? 'flex items-center gap-2' : 'flex flex-col gap-1',
          inline && isFullWidthItem(config) && 'col-span-full',
        )"
      >
        <label
          :class="cn(
            'text-sm text-muted',
            inline ? 'w-24 shrink-0 truncate text-right' : 'w-auto',
          )"
        >
          {{ config.label || config.name }}
        </label>

        <div class="min-w-0 flex-1">
          <!-- 文本输入 -->
          <Input
            v-if="config.component === 'input'"
            :model-value="getStringValue(config)"
            :placeholder="config.placeholder || `请输入 ${config.label || config.name}`"
            clearable
            @update:model-value="setValue(config, $event)"
          />

          <!-- 多行文本 -->
          <Input
            v-else-if="config.component === 'textarea'"
            :model-value="getStringValue(config)"
            type="textarea"
            :rows="3"
            :placeholder="config.placeholder"
            @update:model-value="setValue(config, $event)"
          />

          <!-- 单选下拉 -->
          <Combobox
            v-else-if="config.component === 'select'"
            :model-value="getStringValue(config)"
            :options="optionsFor(config)"
            :placeholder="loadingOptions[config.name]
              ? '正在读取选项…'
              : (config.placeholder || '请选择')"
            clearable
            @update:model-value="setValue(config, $event)"
          />

          <!-- 多选下拉 -->
          <MultiSelect
            v-else-if="config.component === 'multi-select'"
            :model-value="getArrayValue(config)"
            :options="optionsFor(config)"
            :placeholder="loadingOptions[config.name] ? '正在读取选项…' : (config.placeholder || '请选择')"
            @update:model-value="setValue(config, $event)"
          />

          <!-- 日期选择 -->
          <DateInput
            v-else-if="config.component === 'date-picker'"
            :model-value="getStringValue(config)"
            @update:model-value="setValue(config, $event)"
          />

          <!-- 滑块 -->
          <div v-else-if="config.component === 'slider'" class="flex items-center gap-3">
            <Slider
              :model-value="getNumberValue(config)"
              :min="config.min ?? 0"
              :max="config.max ?? 100"
              :step="config.step ?? 1"
              class="flex-1"
              @update:model-value="setValue(config, $event)"
            />
            <span class="w-12 shrink-0 text-right text-sm text-muted">
              {{ getNumberValue(config) }}
            </span>
          </div>

          <!-- 开关 -->
          <Switch
            v-else-if="config.component === 'switch'"
            :model-value="getBooleanValue(config)"
            @update:model-value="setValue(config, $event)"
          />

          <!-- 兜底：按普通输入处理 -->
          <Input
            v-else
            :model-value="getStringValue(config)"
            @update:model-value="setValue(config, $event)"
          />
        </div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.dynamic-form__empty {
  margin: 0;
  padding: 18px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  background: var(--surface-color);
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  line-height: 1.7;
  text-align: center;
}

.dynamic-form__empty code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--active-bg);
  color: var(--brand-color);
  font-family: var(--font-mono);
}
</style>
