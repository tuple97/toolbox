/**
 * 设置页的「目标面板」。
 *
 * 设置是常驻的单例视图（切走只是 v-show 隐藏），别的页面要跳到它的某个
 * 面板时没法直接调用它内部的方法，因此留一个模块级的响应式目标位：
 * 跳转方只负责写入，设置页监听到后切面板并清空。
 */
import { ref } from 'vue'

/** 待打开的面板 id；空串表示没有待处理的目标 */
export const pendingSettingPanel = ref('')

/** 请求设置页打开某个面板（需同时把内容区切到 settings 单例视图） */
export function openSettingPanel(id: string): void {
  pendingSettingPanel.value = id
}
