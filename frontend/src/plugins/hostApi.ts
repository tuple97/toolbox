/** 插件前端宿主 API：共享运行时（window.__TOOLBOX__）与插件专属上下文 activate(api) */

import type { Component } from 'vue'
import * as VueRuntime from 'vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import Checkbox from '@/components/ui/Checkbox.vue'
import ColorInput from '@/components/ui/ColorInput.vue'
import Combobox from '@/components/ui/Combobox.vue'
import DataTable from '@/components/ui/DataTable.vue'
import DateInput from '@/components/ui/DateInput.vue'
import Dialog from '@/components/ui/Dialog.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Field from '@/components/ui/Field.vue'
import Icon from '@/components/ui/Icon.vue'
import Input from '@/components/ui/Input.vue'
import MultiSelect from '@/components/ui/MultiSelect.vue'
import NumberInput from '@/components/ui/NumberInput.vue'
import Slider from '@/components/ui/Slider.vue'
import Switch from '@/components/ui/Switch.vue'
import Tabs from '@/components/ui/Tabs.vue'
import TabGroup from '@/components/ui/TabGroup.vue'
import Tag from '@/components/ui/Tag.vue'
import { invokePlugin, getPluginSetting, setPluginSetting } from '@/api/plugins'
import { pickFiles, pickSaveFile } from '@/api/dialog'
import type { FileFilterOption } from '@/api/dialog'
import { EventsEmit, EventsOn, openExternalUrl } from '@/api/runtime'
import { notify } from '@/utils/notify'
import { buildHostModules } from '@/plugin-sdk'
import { attachSettingsComponent, registerPluginTool } from './registry'
import type { InstalledPlugin } from '@/types'

/** 宿主 API 版本；插件可据此做兼容判断 */
export const TOOLBOX_API_VERSION = '1.0'

/** 共享 UI 组件库 */
const ui: Record<string, Component> = {
  Button,
  Card,
  Checkbox,
  ColorInput,
  Combobox,
  // DataTable 是泛型组件，签名与 Component 不兼容，这里显式放宽
  DataTable: DataTable as unknown as Component,
  DateInput,
  Dialog,
  EmptyState,
  Field,
  Icon,
  Input,
  MultiSelect,
  NumberInput,
  Slider,
  Switch,
  Tabs,
  TabGroup,
  Tag,
}

/** 插件注册工具的参数 */
export interface PluginToolRegistration {
  /** 工具类型，需与清单 contributes.tools[].type 一致且唯一 */
  type: string
  /** 菜单与标签展示名 */
  label: string
  /** 图标名（内置图标库） */
  icon?: string
  /** 是否多例 */
  multi?: boolean
  /** 单行说明 */
  description?: string
  /** 侧栏分组 id 或分组名；留空归入「插件」分组 */
  group?: string
  /** 组内排序，小的在前 */
  order?: number
  /** 是否出现在「新建标签」菜单；默认跟随 multi */
  picker?: boolean
  /** 工具视图组件 */
  component: Component
}

/** 插件可用的宿主能力 */
export interface PluginHostCapabilities {
  /** 调用插件自己的后端 handler */
  invoke: <T = unknown>(handler: string, args?: unknown) => Promise<T>
  /** 插件私有键值存储（需 storage 权限） */
  storage: {
    get: (key: string) => Promise<string>
    set: (key: string, value: string) => Promise<void>
    all: () => Promise<Record<string, string>>
  }
  /** 发送事件（需 events 权限），事件名会自动加上插件前缀 */
  emit: (name: string, payload?: unknown) => void
  /** 监听事件，返回取消函数 */
  on: (name: string, callback: (payload: unknown) => void) => () => void
  /** 应用内提示 */
  notify: typeof notify
  /** 用系统浏览器打开链接 */
  openExternal: (url: string) => void
  /** 生成插件自身静态资源的 URL */
  assetUrl: (relPath: string) => string
  /** 选择文件并返回绝对路径；取消时返回空数组 */
  pickFiles: (
    title: string,
    filters?: FileFilterOption[],
  ) => Promise<string[]>
  /** 弹出「另存为」对话框并返回绝对路径；取消时返回空串 */
  pickSaveFile: (
    title: string,
    defaultFileName?: string,
    filters?: FileFilterOption[],
  ) => Promise<string>
}

/** 传给插件 activate() 的上下文 */
export interface PluginFrontendApi {
  /** 插件自身信息 */
  plugin: {
    id: string
    version: string
    /** 插件资源 URL 前缀（含插件 id 与版本） */
    baseUrl: string
  }
  /** 共享 Vue 运行时 */
  vue: typeof VueRuntime
  /** 共享 UI 组件库 */
  ui: Record<string, Component>
  /** 宿主能力 */
  host: PluginHostCapabilities
  /** 注册一个工具视图 */
  registerTool: (definition: PluginToolRegistration) => void

  /** 注册一个自定义设置面板 */
  registerSettingsPanel: (definition: PluginSettingsPanelRegistration) => void

  /** 写日志（输出到浏览器控制台） */
  log: (...args: unknown[]) => void
}

/** 插件注册设置面板的参数 */
export interface PluginSettingsPanelRegistration {
  /** 面板 id；与清单 contributes.settingsPanels[].id 对应 */
  id: string
  /** 页签标题（清单已声明时可省略） */
  title?: string
  /** 面板内容组件 */
  component: Component
}

/** 安装全局共享运行时到 window.__TOOLBOX__ */
export function installSharedRuntime(assetBase: string): void {
  const globals = window as unknown as Record<string, unknown>

  globals.__TOOLBOX__ = {
    apiVersion: TOOLBOX_API_VERSION,
    assetBase,
    vue: VueRuntime,
    ui,
    notify,
    openExternal: openExternalUrl,
  }

  // 宿主内部模块表，供官方插件复用宿主内核
  globals.__TOOLBOX_HOST__ = buildHostModules()
}

/** 为单个插件构造专属上下文 */
export function createPluginApi(plugin: InstalledPlugin, assetBase: string): PluginFrontendApi {
  const baseUrl = `${assetBase}${plugin.id}/${plugin.version}/`

  return {
    plugin: {
      id: plugin.id,
      version: plugin.version,
      baseUrl,
    },

    vue: VueRuntime,
    ui,

    host: {
      invoke: <T = unknown>(handler: string, args?: unknown) => invokePlugin<T>(plugin.id, handler, args),

      storage: {
        get: (key: string) => getPluginSetting(plugin.id, key),
        set: (key: string, value: string) => setPluginSetting(plugin.id, key, value),
        all: async () => {
          // 后端无「列出全部配置」绑定，用约定的批量 handler 兜底
          try {
            return await invokePlugin<Record<string, string>>(plugin.id, '__listSettings', {})
          }
          catch {
            return {}
          }
        },
      },

      emit: (name: string, payload?: unknown) => {
        EventsEmit(`plugin:${plugin.id}:${name}`, payload)
      },

      on: (name: string, callback: (payload: unknown) => void) =>
        EventsOn(`plugin:${plugin.id}:${name}`, callback),

      notify,
      openExternal: openExternalUrl,
      assetUrl: (relPath: string) => `${baseUrl}${relPath.replace(/^\/+/, '')}`,

      pickFiles: (title: string, filters: FileFilterOption[] = []) =>
        pickFiles(title, filters),

      pickSaveFile: (
        title: string,
        defaultFileName = '',
        filters: FileFilterOption[] = [],
      ) => pickSaveFile(title, defaultFileName, filters),
    },

    registerTool: (definition: PluginToolRegistration) => {
      registerPluginTool({
        type: definition.type,
        label: definition.label,
        icon: definition.icon ?? '',
        multi: Boolean(definition.multi),
        description: definition.description ?? '',
        group: definition.group ?? '',
        order: definition.order ?? 0,
        // 未显式指定时：多例工具进「新建标签」菜单
        picker: definition.picker ?? Boolean(definition.multi),
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        component: definition.component,
      })
    },

    registerSettingsPanel: (definition: PluginSettingsPanelRegistration) => {
      attachSettingsComponent(plugin.id, definition.id, definition.title ?? '', definition.component)
    },

    log: (...args: unknown[]) => {
      console.log(`[plugin:${plugin.id}]`, ...args)
    },
  }
}
