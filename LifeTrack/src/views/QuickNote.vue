<script setup lang="ts">
/**
 * 快速随记浮窗（托盘「快速随记」/ Ctrl+Alt+N 唤起，label: quick-note）
 * 无边框透明窗由 Rust 侧创建，本页只画卡片本体；关窗=hide，草稿跨次唤起保留。
 * 保存链路与随记页同款：parseEntry 抽 #标签 → addLog → addEvent("log.created")
 */
import { ref, onMounted } from "vue";
import { LOG_KINDS, addLog, parseEntry } from "../utils/logs";
import { addEvent } from "../utils/timeline";

const draft = ref("");
const kind = ref("生活");
const saved = ref(false);
const draftEl = ref<HTMLTextAreaElement | null>(null);

async function hideSelf() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  } catch { /* 非 Tauri 环境（纯浏览器调试）没有窗口可隐藏 */ }
}

/** 整窗随意拖动：除交互控件（按钮/输入框/链接）外，任意按下都发起窗口拖拽；
 *  textarea 要留给文字选中，不触发拖动 */
async function dragOn(e: MouseEvent) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button, input, textarea, select, a")) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  } catch { /* 非 Tauri 环境无窗口可拖 */ }
}

function pick(k: string) {
  kind.value = k;
}

async function save() {
  const raw = draft.value.trim();
  if (!raw) { await hideSelf(); return; }
  const { text, tags } = parseEntry(raw);
  if (!text) { await hideSelf(); return; }
  await addLog({ text, kind: kind.value, tags });
  const brief = text.length > 30 ? text.slice(0, 30) + "\u2026" : text;
  await addEvent("log.created", `记录随记：${brief}`);
  draft.value = "";
  saved.value = true;
  // 让「已记下」露出一瞬再收窗，确认感优先于速度
  window.setTimeout(() => { saved.value = false; void hideSelf(); }, 600);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void save(); }
  else if (e.key === "Escape") { e.preventDefault(); void hideSelf(); }
}

onMounted(() => draftEl.value?.focus());
</script>

<template>
  <div class="qn" @mousedown="dragOn">
    <div class="qn-card">
      <!-- 顶部条：标题 + 关闭（整窗都可拖，见 dragOn） -->
      <div class="qn-head">
        <span class="qn-title">快速随记</span>
        <button class="qn-x" title="隐藏（Esc）" @click="hideSelf">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>
      </div>
      <textarea
        ref="draftEl" v-model="draft" class="qn-input" rows="2"
        placeholder="有感即录 · #标签 自动提取" @keydown="onKey"
      ></textarea>
      <div class="qn-foot">
        <div class="qn-kinds">
          <button
            v-for="k in LOG_KINDS" :key="k.key" class="qn-chip" :class="{ on: kind === k.key }"
            :style="kind === k.key ? { background: k.color, borderColor: k.color } : undefined"
            @click="pick(k.key)"
          >{{ k.key }}</button>
        </div>
        <button class="qn-save" :disabled="!draft.trim()" @click="save">{{ saved ? "已记下" : "保存" }}</button>
      </div>
    </div>
  </div>
</template>

<style>
/* 浮窗整窗要透出桌面：盖掉 global.css 给 body 铺的主题底色（不 scoped，只在本页加载） */
html, body { background: transparent !important; }
</style>

<style scoped>
.qn { position: fixed; inset: 0; padding: 6px; }
.qn-card {
  height: 100%; display: flex; flex-direction: column;
  background: var(--card); border: 1px solid var(--line-2); border-radius: 14px;
  overflow: hidden;
}
.qn-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px 4px 12px; flex: none; cursor: move; user-select: none;
}
.qn-title { font-size: 11.5px; font-weight: 600; color: var(--text-3); letter-spacing: .5px; }
.qn-x {
  border: none; background: transparent; color: var(--text-3); cursor: pointer;
  width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; padding: 0;
}
.qn-x:hover { background: var(--hover); color: var(--text-1); }
.qn-input {
  flex: 1; margin: 0 12px; border: none; outline: none; resize: none;
  background: transparent; color: var(--text-1); font-size: 14px; line-height: 1.55;
  font-family: inherit; overflow-y: auto; scrollbar-width: none;
}
.qn-input::-webkit-scrollbar { display: none; }
.qn-input::placeholder { color: var(--text-3); }
.qn-foot { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px 9px; flex: none; gap: 8px; }
.qn-kinds { display: flex; gap: 5px; flex-wrap: wrap; }
.qn-chip {
  border: 1px solid var(--line-2); border-radius: 6px; background: transparent;
  color: var(--text-3); font-size: 11px; padding: 2px 7px; cursor: pointer;
  font-family: inherit; transition: background .15s, color .15s, border-color .15s;
}
.qn-chip:hover { border-color: var(--text-3); color: var(--text-1); }
.qn-chip.on { color: #fff; font-weight: 600; border-color: transparent; }
.qn-save {
  border: none; border-radius: 7px; background: var(--accent); color: #fff;
  font-size: 11.5px; font-weight: 600; padding: 3px 12px; cursor: pointer;
  font-family: inherit; white-space: nowrap; flex: none;
}
.qn-save:hover { background: var(--accent-dark); }
.qn-save:disabled { opacity: .45; cursor: default; }
.qn-save:disabled:hover { background: var(--accent); }
</style>
