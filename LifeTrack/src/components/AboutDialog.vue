<script setup lang="ts">
/**
 * 关于对话框：居中弹窗，复用 AboutContent 正文
 * （「检查更新」已迁至设置页的「关于与更新」分组）
 */
import AboutContent from "./AboutContent.vue";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
    <Transition name="ab">
      <div v-if="open" class="ab-back" @click.self="emit('close')">
        <div class="ab-card" role="dialog" aria-modal="true" @keydown.esc="emit('close')">
          <button class="ab-close" title="关闭" @click="emit('close')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
          </button>

          <AboutContent />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ab-back {
  position: fixed; inset: 0; z-index: 220; display: grid; place-items: center;
  padding: 16px; background: rgba(26, 29, 33, .32); backdrop-filter: blur(3px);
}
.ab-card {
  position: relative; width: min(520px, 100%); box-sizing: border-box;
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  box-shadow: 0 18px 48px rgba(26, 29, 33, .18); padding: 20px 22px;
  max-height: 80vh; overflow-y: auto;
}
.ab-close {
  position: absolute; top: 14px; right: 14px; border: none; background: none;
  color: var(--text-3); cursor: pointer; width: 24px; height: 24px; border-radius: 7px;
  display: grid; place-items: center; transition: background-color .15s ease, color .15s ease;
}
.ab-close:hover { background: var(--hover-2); color: var(--text-1); }

/* 进入/退出动画 */
.ab-enter-active, .ab-leave-active { transition: opacity .16s ease; }
.ab-enter-from, .ab-leave-to { opacity: 0; }
.ab-enter-from .ab-card { transform: translateY(10px) scale(.985); }
</style>
