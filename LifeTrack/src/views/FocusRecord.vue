<script setup lang="ts">
// ============================================================
// 番茄钟结束记录窗（独立 Tauri 无边框弹窗）
// 计时结束后弹出，引导用户写下"这段时间做了什么"。
// 数据来源：localStorage("focus-pending") → { startTs, endTs, minutes }
// ============================================================
import { ref, onMounted, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { recordFocus } from "../utils/focus";

const note = ref("一段番茄");
const minutes = ref(0);
const textarea = ref<HTMLTextAreaElement | null>(null);
const pending = ref<{ startTs: number; endTs: number; minutes: number } | null>(null);
const feedback = ref("");  // 操作反馈文本

onMounted(async () => {
  const raw = localStorage.getItem("focus-pending");
  if (!raw) { getCurrentWindow().close(); return; }
  pending.value = JSON.parse(raw);
  minutes.value = pending.value!.minutes;
  localStorage.removeItem("focus-pending");
  await nextTick();
  textarea.value?.focus();
});

async function save() {
  const p = pending.value;
  if (!p) return;
  const label = note.value.trim() || "一段番茄";
  try {
    await recordFocus({ startTs: p.startTs, endTs: p.endTs, label });
    try { await invoke("notify_done", { title: "番茄钟完成", body: `${p.minutes} 分钟 · ${label}` }); } catch { /* */ }
    feedback.value = "✓ 已保存";
  } catch (e: unknown) {
    feedback.value = `保存失败: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  await emit("focus:record-done", "saved");
  setTimeout(() => getCurrentWindow().close(), 400);
}

async function abandon() {
  feedback.value = "已放弃";
  await emit("focus:record-done", "abandoned");
  setTimeout(() => getCurrentWindow().close(), 300);
}

function onDrag(e: MouseEvent) {
  if ((e.target as Element).closest("button, textarea, input")) return;
  getCurrentWindow().startDragging().catch(() => { /* */ });
}
</script>

<template>
  <div class="fr" @mousedown="onDrag">
    <div class="fr-title">这 {{ minutes }} 分钟，做了什么？</div>
    <textarea
      ref="textarea" v-model="note" class="fr-input"
      placeholder="随手记一下..." rows="5" maxlength="200"
      @mousedown.stop
    ></textarea>
    <div class="fr-actions">
      <span v-if="feedback" class="fr-hint">{{ feedback }}</span>
      <button class="fr-btn skip" @mousedown.stop @click="abandon" :disabled="!!feedback">放弃</button>
      <button class="fr-btn save" @mousedown.stop @click="save" :disabled="!!feedback">保存</button>
    </div>
  </div>
</template>

<style>
html, body { background: transparent !important; }
</style>

<style scoped>
.fr {
  position: fixed; inset: 0; border-radius: 16px;
  background: var(--card); border: 1px solid var(--line-2);
  padding: 24px 26px 18px; display: flex; flex-direction: column; cursor: move;
  font-family: inherit;
}
.fr-title {
  font-size: 15px; font-weight: 600; color: var(--text-1); margin-bottom: 14px;
}
.fr-input {
  width: 100%; border: 1px solid var(--line-2); border-radius: 10px;
  background: var(--field); color: var(--text-1); font-size: 13px;
  padding: 8px 10px; resize: none; outline: none; font-family: inherit;
  line-height: 1.5;
}
.fr-input:focus { border-color: var(--accent); }
.fr-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.fr-hint { font-size: 12px; color: var(--accent-dark); margin-right: auto; }
.fr-btn {
  border: none; border-radius: 10px; padding: 6px 16px; font-size: 12.5px;
  font-weight: 500; cursor: pointer; font-family: inherit;
}
.fr-btn.skip { background: transparent; color: var(--text-3); }
.fr-btn.skip:hover { color: var(--text-1); }
.fr-btn.save { background: var(--accent); color: #fff; font-weight: 600; }
.fr-btn.save:hover { background: var(--accent-dark); }
.fr-btn:disabled { opacity: .45; cursor: default; pointer-events: none; }
</style>
