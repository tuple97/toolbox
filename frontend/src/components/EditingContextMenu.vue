<script setup lang="ts">
/**
 * 应用默认右键菜单：复制 / 剪切 / 粘贴。
 *
 * 只做渲染与派发，启用规则与剪贴板操作都在 utils/editingContextMenu.ts 里；
 * 菜单外观复用通用的 ContextMenu，和标签页 / 插件卡片的右键菜单保持一致。
 */
import { computed } from 'vue'
import ContextMenu from '@/components/ContextMenu.vue'
import { closeEditingMenu, editingMenu, runEditingAction } from '@/utils/editingContextMenu'
import type { EditingAction } from '@/utils/editingContextMenu'
import type { ContextMenuAction } from '@/types'

const items = computed<ContextMenuAction[]>(() => [
  { key: 'copy', label: '复制', shortcut: 'Ctrl+C', disabled: !editingMenu.canCopy },
  { key: 'cut', label: '剪切', shortcut: 'Ctrl+X', disabled: !editingMenu.canCut },
  { key: 'paste', label: '粘贴', shortcut: 'Ctrl+V', disabled: !editingMenu.canPaste },
])

function handleSelect(item: ContextMenuAction) {
  void runEditingAction(item.key as EditingAction)
}
</script>

<template>
  <ContextMenu
    :visible="editingMenu.visible"
    :x="editingMenu.x"
    :y="editingMenu.y"
    :items="items"
    @update:visible="closeEditingMenu"
    @select="handleSelect"
  />
</template>
