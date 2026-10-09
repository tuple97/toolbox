<script setup lang="ts">
/**
 * 插件设置弹窗。
 *
 * 插件的设置项原本内嵌在工具箱设置页里，与工具箱自身的设置混在同一个页签列表；
 * 现在改成由插件卡片右键菜单的「配置」打开，弹窗只渲染这一个插件的设置面板，
 * 工具箱设置页只保留工具箱自己的设置。
 *
 * 面板来自插件运行期注册表：声明式配置项由宿主按 type 渲染成表单，
 * 插件自带的自定义组件则优先渲染；两种形式的值都存后端 plugin_settings 表。
 */

import { computed, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Combobox from '@/components/ui/Combobox.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Field from '@/components/ui/Field.vue'
import Input from '@/components/ui/Input.vue'
import Switch from '@/components/ui/Switch.vue'
import { getPluginSetting, setPluginSetting } from '@/api/plugins'
import { pluginSettingsPanels } from '@/plugins/registry'
import { notify } from '@/utils/notify'
import type { InstalledPlugin } from '@/types'

const props = withDefaults(defineProps<{
  /** 是否显示 */
  modelValue: boolean
  /** 目标插件；为空时不渲染内容 */
  plugin?: InstalledPlugin | null
}>(), {
  plugin: null,
})

const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

/** 弹窗标题 */
const title = computed(() => (props.plugin ? `${props.plugin.name} · 设置` : '插件设置'))

/** 该插件的设置面板（按声明顺序） */
const panels = computed(() => {
  const id = props.plugin?.id
  if (!id) {
    return []
  }
  return pluginSettingsPanels()
    .filter(panel => panel.pluginId === id)
    .sort((left, right) => left.order - right.order)
})

/** 设置值缓存：配置键 → 值 */
const values = ref<Record<string, string>>({})

/** 取配置项当前值；未加载到时回退到声明里的默认值 */
function valueOf(key: string, fallback = ''): string {
  return values.value[key] ?? fallback
}

/** 保存单个配置项：先本地生效，再落库 */
async function save(key: string, value: string): Promise<void> {
  values.value = { ...values.value, [key]: value }
  const pluginId = props.plugin?.id
  if (!pluginId) {
    return
  }
  try {
    await setPluginSetting(pluginId, key, value)
  }
  catch (e) {
    notify.error(e instanceof Error ? e.message : String(e))
  }
}

/** 打开弹窗或切换插件时重新拉取该插件的全部配置项 */
async function load(): Promise<void> {
  const pluginId = props.plugin?.id
  if (!pluginId) {
    values.value = {}
    return
  }
  const next: Record<string, string> = {}
  for (const panel of panels.value) {
    for (const setting of panel.settings) {
      try {
        next[setting.key] = await getPluginSetting(pluginId, setting.key)
      }
      catch {
        next[setting.key] = setting.default ?? ''
      }
    }
  }
  values.value = next
}

watch([visible, () => props.plugin?.id], () => {
  if (visible.value) {
    void load()
  }
})
</script>

<template>
  <Dialog v-model="visible" :title="title" :width="560">
    <div class="plugin-settings">
      <template v-if="panels.length">
        <section v-for="panel in panels" :key="panel.id" class="plugin-settings__panel">
          <!-- 只有一个面板时标题与弹窗标题重复，就不再显示 -->
          <h4 v-if="panels.length > 1" class="plugin-settings__title">
            {{ panel.title }}
          </h4>

          <!-- 插件自带的自定义组件优先 -->
          <component :is="panel.component" v-if="panel.component" />

          <template v-else>
            <Field
              v-for="setting in panel.settings"
              :key="setting.key"
              :label="setting.title"
              :hint="setting.description"
            >
              <Switch
                v-if="setting.type === 'boolean'"
                :model-value="valueOf(setting.key, setting.default) === 'true'"
                @update:model-value="(value: boolean) => save(setting.key, value ? 'true' : 'false')"
              />
              <Combobox
                v-else-if="setting.type === 'select'"
                :model-value="valueOf(setting.key, setting.default)"
                :options="setting.options ?? []"
                @update:model-value="(value: string) => save(setting.key, value)"
              />
              <Input
                v-else
                :model-value="valueOf(setting.key, setting.default)"
                @update:model-value="(value: string) => save(setting.key, value)"
              />
            </Field>
          </template>
        </section>
      </template>

      <p v-else class="plugin-settings__empty">
        该插件没有提供可配置项。
      </p>
    </div>

    <template #footer>
      <Button variant="secondary" size="sm" @click="visible = false">
        关闭
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.plugin-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.plugin-settings__panel {
  display: flex;
  flex-direction: column;
}

.plugin-settings__title {
  margin: 0 0 4px;
  color: var(--text-color);
  font-size: var(--app-font-size-sm);
  font-weight: 600;
}

.plugin-settings__empty {
  margin: 0;
  padding: 18px;
  color: var(--text-muted);
  font-size: var(--app-font-size-sm);
  text-align: center;
}
</style>
