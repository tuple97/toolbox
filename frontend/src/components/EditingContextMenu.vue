<script setup lang="ts">
/** 应用默认右键菜单：复制 / 剪切 / 粘贴 */
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
