<script setup lang="ts">
/**
 * 开屏视觉本体：logo 图标 + LifeTrack 字标 + 上升轨迹编舞（纯展示，无窗口/时序职责）
 * 动效：图标缩放过冲爆入 + 品牌绿光晕 → 上升轨迹逐段"画"出 → 线条抵达处三个节点依次柔和点亮
 * （各爆一圈柔光）→ 字标遮罩上擦揭示。刻意不用滑动光点，避免像光标横穿的机械感。
 * 关键帧集中在 global.css（lt-sp-* 前缀）；SVG 内联是刻意为之——
 * 若改成 <img src="/logo.svg">，节点与轨迹就是死像素，动效全部失效。
 * 本组件跑在 App.vue 的一屏开屏覆盖层里。
 */
</script>

<template>
  <div class="lt-sp-stage">
    <svg class="lt-sp-logo" viewBox="0 0 64 64" fill="none" aria-label="LifeTrack">
      <defs>
        <linearGradient id="sp-bg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop stop-color="#17A17D" />
          <stop offset="1" stop-color="#0A6B52" />
        </linearGradient>
        <linearGradient id="sp-path" x1="18" y1="46" x2="46" y2="16" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.6" />
          <stop offset="1" stop-color="white" stop-opacity="1" />
        </linearGradient>
        <filter id="sp-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <!-- 圆角方形底：开屏里去掉 logo.svg 那片顶部内高光——它是线条画出前唯一的白色，放大后会先被看成一道白痕 -->
      <rect width="64" height="64" rx="16" fill="url(#sp-bg)" />

      <!-- 上升轨迹：逐段画出（stroke-dash 动画，见 global.css）；round 圆头帽：无平边→竖直段不会闪横条，且头仅线宽粗、不会被当成独立圆 -->
      <path
        class="lt-sp-line"
        d="M18 46 Q18 28 32 28 T46 16"
        stroke="url(#sp-path)"
        stroke-width="3.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
        pathLength="100"
      />

      <!-- 起点 / 中间 / 终点节点：随线条到达原地依次点亮（只淡入，无光晕、不缩放） -->
      <circle class="lt-sp-node n0" cx="18" cy="46" r="3.4" fill="white" filter="url(#sp-glow)" />
      <circle class="lt-sp-node n1" cx="32" cy="28" r="2.4" fill="white" fill-opacity="0.6" />
      <circle class="lt-sp-node n2" cx="46" cy="16" r="3.8" fill="white" filter="url(#sp-glow)" />
    </svg>

    <div class="lt-sp-brand">LifeTrack</div>
  </div>
</template>

<style scoped>
.lt-sp-stage {
  position: relative; width: 192px; height: 192px;
  animation: lt-sp-pop-in .55s cubic-bezier(.3, .7, .3, 1) both;
}
/* 以 64 用户单位设计、3 倍放大：动效里的像素全部是 ×3 关系，一处定标 */
.lt-sp-logo { width: 192px; height: 192px; display: block; }
/* 字标绝对定位悬浮在图标下方：不占流式位置，避免压缩 logo 导致动效坐标错位 */
.lt-sp-brand {
  position: absolute; left: 0; right: 0; top: calc(100% + 14px);
  text-align: center; font-size: 15px; font-weight: 700;
  letter-spacing: -.3px; color: var(--text-1);
}
</style>
