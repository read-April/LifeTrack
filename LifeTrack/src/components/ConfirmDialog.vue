<script setup lang="ts">
/**
 * 应用内确认框（挂在 App 上，全局共用一个）
 * 由 utils/confirm.ts 的 askConfirm() 打开：Enter = 主按钮，Esc / 点遮罩 = 取消
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { confirmBox, settleConfirm } from "../utils/confirm";

const okEl = ref<HTMLButtonElement | null>(null);

// 焦点落在主按钮上，回车天然是"确认"，不必再手写 Enter 分支（避免和按钮原生激活重复触发）
watch(() => confirmBox.open, async open => {
  if (open) {
    await nextTick();
    okEl.value?.focus();
  }
});

function onKey(e: KeyboardEvent) {
  if (confirmBox.open && e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    settleConfirm("cancel");
  }
}
onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <Teleport to="body">
    <Transition name="cd">
      <div v-if="confirmBox.open" class="cd-back" @click.self="settleConfirm('cancel')">
        <div class="cd-card" role="dialog" aria-modal="true">
          <div class="cd-top">
            <span class="cd-ico" :class="{ danger: confirmBox.opts.danger }">{{ confirmBox.opts.danger ? "!" : "?" }}</span>
            <div class="cd-tx">
              <div class="cd-title">{{ confirmBox.opts.title }}</div>
              <p v-if="confirmBox.opts.message" class="cd-msg">{{ confirmBox.opts.message }}</p>
            </div>
          </div>
          <div class="cd-foot">
            <button class="cd-ghost" @click="settleConfirm('cancel')">{{ confirmBox.opts.cancel }}</button>
            <span class="cd-spacer"></span>
            <button v-if="confirmBox.opts.also" class="cd-line" @click="settleConfirm('also')">{{ confirmBox.opts.also }}</button>
            <button v-if="confirmBox.opts.ok" ref="okEl" class="cd-main" :class="{ danger: confirmBox.opts.danger }" @click="settleConfirm('ok')">
              {{ confirmBox.opts.ok }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cd-back {
  position: fixed; inset: 0; z-index: 200; padding: 16px;
  display: grid; place-items: center;
  background: rgba(26, 29, 33, .32); backdrop-filter: blur(3px);
}
.cd-card {
  width: min(400px, 100%); box-sizing: border-box;
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  box-shadow: 0 18px 48px rgba(26, 29, 33, .18);
  padding: 18px 18px 14px;
  transition: transform .18s cubic-bezier(.22, .8, .3, 1);
}
.cd-top { display: flex; align-items: flex-start; gap: 12px; }
.cd-ico {
  flex: 0 0 28px; width: 28px; height: 28px; border-radius: 9px;
  background: var(--accent-soft); color: var(--accent-dark);
  display: grid; place-items: center; font-size: 15px; font-weight: 700; line-height: 1;
}
.cd-ico.danger { background: var(--red-soft); color: #D9435A; }
.cd-tx { min-width: 0; }
.cd-title { font-size: 13.5px; font-weight: 700; color: var(--text-1); letter-spacing: -.2px; line-height: 1.5; }
.cd-msg { margin: 5px 0 0; font-size: 12px; line-height: 1.75; color: var(--text-2); white-space: pre-line; word-break: break-all; }
.cd-foot { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
.cd-spacer { flex: 1; }
.cd-foot button {
  border: 1px solid transparent; border-radius: 10px; padding: 7px 14px; cursor: pointer;
  font-size: 12px; font-weight: 600; font-family: inherit;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.cd-ghost { background: none; color: var(--text-3); padding-left: 8px; padding-right: 8px; }
.cd-ghost:hover { color: var(--text-2); }
.cd-line { background: var(--card); border-color: var(--line-2); color: var(--text-2); }
.cd-line:hover { border-color: var(--accent); color: var(--accent-dark); }
.cd-main { background: var(--accent); color: #fff; box-shadow: 0 2px 8px rgba(23, 161, 125, .28); }
.cd-main:hover { background: var(--accent-dark); }
.cd-main:focus-visible { outline: 2px solid var(--accent-dark); outline-offset: 2px; }
.cd-main.danger { background: #F0506B; box-shadow: 0 2px 8px rgba(240, 80, 107, .26); }
.cd-main.danger:hover { background: #D9435A; }
.cd-main.danger:focus-visible { outline-color: #D9435A; }

.cd-enter-active, .cd-leave-active { transition: opacity .16s ease; }
.cd-enter-from, .cd-leave-to { opacity: 0; }
.cd-enter-from .cd-card { transform: translateY(10px) scale(.985); }

/* 手机端：卡片满宽、按钮均分，保证点击区域 */
@media (max-width: 767px) {
  .cd-back { padding: 20px 14px; align-items: flex-end; }
  .cd-foot { flex-wrap: wrap; }
  .cd-spacer { display: none; }
  .cd-ghost { width: 100%; order: 3; text-align: center; padding: 9px 14px; }
  .cd-line, .cd-main { flex: 1; order: 1; text-align: center; padding: 10px 14px; }
}
</style>
