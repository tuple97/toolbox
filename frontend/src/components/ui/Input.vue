<script setup lang="ts">
/**
 * 文本输入（替代 `el-input`）。
 *
 * 与既有 ui 组件同一约定：高度乘 `--app-control-scale`、字号用 Tailwind 阶梯、
 * 颜色只引用语义令牌 —— 四套主题与「缩放比例」自动跟随，组件里不出现硬编码色值。
 *
 * 两种形态：
 *  - 单行 `<input>`：可带前缀图标（搜索框）与清除按钮；
 *  - 多行 `<textarea>`（`rows` 控制初始高度，允许纵向拖拽 —— 写 SQL / JSON 时比固定高度好用）。
 *
 * 前缀图标与清除按钮走**绝对定位**而不是额外包裹层：`class` 落在最外层容器上，
 * 调用方给宽度（如 `w-[200px]`）时内外一起生效，不会出现「外框 200、输入框撑破」。
 */
import { computed, ref } from 'vue'
import { cn } from '@/lib/utils'
import Icon from '@/components/ui/Icon.vue'

const props = withDefaults(defineProps<{
  placeholder?: string
  /** `textarea` 走多行；`password` 走密码框（可配 showPassword 切换明文） */
  type?: 'text' | 'password' | 'textarea'
  /** 多行初始行数 */
  rows?: number
  size?: 'sm' | 'default'
  disabled?: boolean
  readonly?: boolean
  /** 显示清除按钮（有值时出现，对应 EP 的 clearable） */
  clearable?: boolean
  /** 密码框右侧的「显示 / 隐藏」切换（对应 EP 的 show-password） */
  showPassword?: boolean
  /** 前缀图标名（见 utils/icons.ts），搜索框用 */
  prefixIcon?: string
  class?: string
}>(), {
  type: 'text',
  rows: 3,
  size: 'default',
})

const model = defineModel<string>({ default: '' })

/** 密码是否已切换为明文 */
const revealed = ref(false)

/** 真正给 `<input>` 的 type：密码框在「显示」状态下就是普通文本 */
const inputType = computed(() => (props.type === 'password' && revealed.value ? 'text' : props.type))

/** 两种形态共用的外观：边框 / 底色 / 焦点态 / 禁用态 */
const BASE = 'w-full rounded-md border border-border bg-surface text-text transition-colors '
  + 'outline-none placeholder:text-muted hover:border-brand/40 focus:border-brand/60 '
  + 'disabled:cursor-not-allowed disabled:opacity-50'

/** 单行高度按 size 走（与 Button / Combobox 同一套阶梯） */
const HEIGHT = computed(() => props.size === 'sm'
  ? 'h-[calc(26px*var(--app-control-scale))] text-xs'
  : 'h-[calc(32px*var(--app-control-scale))] text-sm')

function clear() {
  model.value = ''
}
</script>

<template>
  <div v-if="type !== 'textarea'" :class="cn('relative w-full', props.class)">
    <Icon
      v-if="prefixIcon"
      :name="prefixIcon"
      class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
    />
    <input
      v-model="model"
      :type="inputType"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :class="cn(
        BASE,
        HEIGHT,
        prefixIcon && 'pl-7',
        (clearable && model) || (showPassword && type === 'password') ? 'pr-7' : '',
        !prefixIcon && (size === 'sm' ? 'px-2' : 'px-2.5'),
      )"
    >
    <button
      v-if="showPassword && type === 'password'"
      type="button"
      class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted
        transition-colors hover:bg-hover hover:text-text"
      :title="revealed ? '隐藏' : '显示'"
      @click="revealed = !revealed"
    >
      <Icon :name="revealed ? 'eye-off' : 'eye'" class="text-xs" />
    </button>
    <button
      v-else-if="clearable && model"
      type="button"
      class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted
        transition-colors hover:bg-hover hover:text-text"
      title="清除"
      @click="clear"
    >
      <Icon name="close" class="text-xs" />
    </button>
  </div>

  <textarea
    v-else
    v-model="model"
    :rows="rows"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :class="cn(BASE, 'resize-y px-2.5 py-1.5 text-sm leading-relaxed', props.class)"
  />
</template>
