<script setup lang="ts">
/** 确认框宿主（utils/confirm.ts 的渲染端） */
import { computed, nextTick, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Icon from '@/components/ui/Icon.vue'
import { pendingConfirm, settleConfirm } from '@/utils/confirm'

const open = computed({
  get: () => pendingConfirm.value !== null,
  set: (value: boolean) => {
    if (!value) {
      settleConfirm(false)
    }
  },
})

/** 危险操作的语气 */
const danger = computed(() => pendingConfirm.value?.tone === 'danger')

const confirmRef = ref<InstanceType<typeof Button> | null>(null)

/* 打开后把焦点放到确认按钮 */
watch(open, async (value) => {
  if (!value) {
    return
  }
  await nextTick()
  confirmRef.value?.$el?.focus?.()
})
</script>

<template>
  <Dialog v-model="open" :title="pendingConfirm?.title ?? ''" :width="420">
    <div class="flex items-start gap-3">
      <Icon
        name="alert-triangle"
        :class="['mt-0.5 text-xl', danger ? 'text-danger' : 'text-warning']"
      />
      <p class="text-sm leading-relaxed text-text">
        {{ pendingConfirm?.message }}
      </p>
    </div>

    <template #footer>
      <Button variant="secondary" size="sm" @click="settleConfirm(false)">
        {{ pendingConfirm?.cancelText }}
      </Button>
      <Button
        ref="confirmRef"
        :variant="danger ? 'danger' : 'default'"
        size="sm"
        @click="settleConfirm(true)"
      >
        {{ pendingConfirm?.confirmText }}
      </Button>
    </template>
  </Dialog>
</template>
