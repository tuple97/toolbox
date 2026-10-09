<script setup lang="ts">
import { computed } from 'vue'
import Tag from '@/components/ui/Tag.vue'
import { connectionEnvBadge } from '@/utils/connectionDisplay'
import type { DBConnection } from '@/types'

/** 连接下拉里的选项内容：色点 + 名称 + 环境标签 + 只读标签 + 类型 */

const props = defineProps<{
  /** 要展示的连接 */
  connection: DBConnection
}>()

/** 环境标签：本地 / 测试 / 生产，未标记时为 null */
const envBadge = computed(() => connectionEnvBadge(props.connection))
</script>

<template>
  <span class="conn-option">
    <span
      v-if="connection.color"
      class="conn-option__dot"
      :style="{ background: connection.color }"
    />
    <span class="conn-option__name">{{ connection.name }}</span>

    <Tag v-if="envBadge" size="sm" :tone="envBadge.type" effect="plain">
      {{ envBadge.text }}
    </Tag>
    <Tag v-if="connection.readOnly" size="sm" tone="info" effect="plain">只读</Tag>

    <span class="conn-option__type">{{ connection.dbType }}</span>
  </span>
</template>

<style scoped>
.conn-option {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.conn-option__dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.conn-option__name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 类型靠右 */
.conn-option__type {
  margin-left: auto;
  padding-left: 8px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--app-font-size-xs);
}
</style>
