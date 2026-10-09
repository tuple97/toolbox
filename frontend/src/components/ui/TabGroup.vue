<script setup lang="ts">
/**
 * 下划线式页签（替代 `el-tabs` + `el-tab-pane`）。
 *
 * 与 `Tabs.vue`（分段控件）的分工：分段控件是「同一屏内切换一组互斥选项」（设置页），
 * 这里是**内容面板**切换 —— 页签在顶部、内容在下面，视觉更轻，适合面板里再分几块。
 *
 * 已挂载过的面板用 `v-show` 常驻（对齐 EP 的 `lazy` 语义：首次激活才挂载）：
 * 切回来时滚动位置、编辑器实例、没提交的输入都还在。项目约定禁用 `v-if` 切换面板，
 * 这里只在「从未打开过」时用 `v-if` 挡住，避免一开始就把所有面板都渲染出来。
 */
import { computed, ref, watch } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  items: Array<{
    /** 面板标识，同时组成插槽名 `panel-<value>` */
    value: string
    label?: string
    /** 首次激活才挂载（重面板用，如变量配置 / 字段映射） */
    lazy?: boolean
  }>
  class?: string
}>()

/*
 * 显式声明插槽类型（尤其是名字带变量的 `panel-<value>`）。
 * 不写这段时，模板里的「动态插槽名 + v-for 变量」会让 TS 把变量推成 any 循环引用
 * （vue-tsc 报 TS7022），因为插槽类型是从调用处反推的、而调用处又用到该变量。
 */
defineSlots<{
  [name: `panel-${string}`]: () => unknown
  [name: `tab-${string}`]: (props: { item: { value: string, label?: string } }) => unknown
}>()

const model = defineModel<string>({ default: '' })

/** 已经打开过的面板（lazy 的靠它判断「还要不要渲染」） */
const visited = ref<Set<string>>(new Set())

const active = computed(() => model.value || props.items[0]?.value || '')

watch(active, (value) => {
  visited.value = new Set([...visited.value, value])
}, { immediate: true })

/** 该面板现在要不要留在 DOM 里：非 lazy 的一直留，lazy 的打开过一次就留 */
function isMounted(item: { value: string, lazy?: boolean }): boolean {
  return !item.lazy || visited.value.has(item.value)
}
</script>

<template>
  <div :class="cn('flex min-h-0 flex-col', props.class)">
    <!-- 页签栏与内容区各带一个稳定的类名：调用方需要微调内边距时用它做深层选择器 -->
    <div
      role="tablist"
      class="app-tabgroup__tabs flex shrink-0 items-center gap-1 border-b border-border"
    >
      <button
        v-for="item in items"
        :key="item.value"
        type="button"
        role="tab"
        :aria-selected="item.value === active"
        :class="cn(
          '-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors',
          item.value === active
            ? 'border-brand text-text'
            : 'border-transparent text-muted hover:text-text',
        )"
        @click="model = item.value"
      >
        <!-- 默认显示 label；给了 `#tab-<value>` 插槽就整块交给调用方（如带状态点的页签） -->
        <slot :name="`tab-${item.value}`" :item="item">{{ item.label }}</slot>
      </button>
    </div>

    <div class="app-tabgroup__content min-h-0 flex-1">
      <template v-for="item in items" :key="item.value">
        <div v-if="isMounted(item)" v-show="item.value === active" class="h-full">
          <slot :name="`panel-${item.value}`" />
        </div>
      </template>
    </div>
  </div>
</template>
