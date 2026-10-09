<script setup lang="ts">
/** 无边框窗口的缩放宽边热区 */

/** 热区厚度，略小于 Wails 的 borderThickness（6px） */
const EDGE_SIZE = 5
</script>

<template>
  <!-- 装饰性热区 -->
  <div class="resize-edges" aria-hidden="true">
    <div class="resize-edges__item resize-edges__item--top" :style="{ height: `${EDGE_SIZE}px` }" />
    <div class="resize-edges__item resize-edges__item--bottom" :style="{ height: `${EDGE_SIZE}px` }" />
    <div class="resize-edges__item resize-edges__item--left" :style="{ width: `${EDGE_SIZE}px` }" />
    <div class="resize-edges__item resize-edges__item--right" :style="{ width: `${EDGE_SIZE}px` }" />
  </div>
</template>

<style scoped>
.resize-edges {
  position: fixed;
  inset: 0;
  /* 高于标题栏的 z-index: 30 */
  z-index: 100;
  /* 容器不拦截鼠标，仅子元素热区生效 */
  pointer-events: none;
}

.resize-edges__item {
  position: absolute;
  pointer-events: auto;
  /* 不声明 cursor，继承 Wails 设置的缩放指针；不参与拖动 */
  --wails-draggable: no-drag;
}

.resize-edges__item--top {
  top: 0;
  left: 0;
  right: 0;
}

.resize-edges__item--bottom {
  bottom: 0;
  left: 0;
  right: 0;
}

.resize-edges__item--left {
  top: 0;
  bottom: 0;
  left: 0;
}

.resize-edges__item--right {
  top: 0;
  bottom: 0;
  right: 0;
}
</style>
