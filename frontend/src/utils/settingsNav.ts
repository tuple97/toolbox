/** 设置页的「目标面板」 */
import { ref } from 'vue'

/** 待打开的面板 id；空串表示没有待处理的目标 */
export const pendingSettingPanel = ref('')

/** 请求设置页打开某个面板（需同时把内容区切到 settings 单例视图） */
export function openSettingPanel(id: string): void {
  pendingSettingPanel.value = id
}
