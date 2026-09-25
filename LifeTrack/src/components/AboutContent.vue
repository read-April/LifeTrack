<script setup lang="ts">
/**
 * 关于正文（品牌头 + 版本信息 + 免责声明）
 * 被两处复用：路由页 views/About.vue（外层负责居中卡片）与状态栏唤出的 AboutDialog
 * 逻辑与文案集中于此，改免责声明 / 版本口径只需改这一份
 * 软件版本优先取安装包真实值，纯浏览器预览拿不到时回落构建注入值
 * 数据版本是手写的 schema 版本常量：换存储或改表结构时手动 +1，用来提示老数据是否兼容
 */
import { computed, onMounted, ref } from "vue";

const BUILD_VERSION = __APP_VERSION__;
const BUILD_DATE = (() => {
  const d = new Date(__BUILD_TIME__);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
})();

/** 数据结构版本，非软件版本：目前 localStorage 记为 v1.0.0，接 SQLite 改表后再升 */
const DATA_VERSION = "v1.0.0";

// Tauri 运行时信息：打包后取安装包真实版本；纯浏览器预览拿不到，留 — 由 displayVersion 回落
const appVer = ref("—");
onMounted(async () => {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    appVer.value = await getVersion();
  } catch {
    /* 拿不到就留 —，不影响页面 */
  }
});
const displayVersion = computed(() => (appVer.value === "—" ? BUILD_VERSION : appVer.value));
</script>

<template>
  <!-- ============ 品牌头 ============ -->
  <div class="hero">
    <img src="/logo.svg" alt="LifeTrack logo" class="hero-logo" />
    <div class="hero-tx">
      <div class="hero-name">LifeTrack</div>
      <p class="hero-slogan">自知者明，观复知常</p>
      <p class="hero-meta">个人自用 · 本地存储 · 离线可用</p>
    </div>
  </div>

  <hr class="rule" />

  <!-- ============ 版本信息 ============ -->
  <div class="sec-title">关于</div>
  <div class="kv"><span>数据版本</span><b>{{ DATA_VERSION }}</b></div>
  <div class="kv"><span>软件版本</span><b class="ver">v{{ displayVersion }}</b></div>
  <div class="kv"><span>构建时间</span><b>{{ BUILD_DATE }}</b></div>

  <p class="note">本工具为个人开发，不保证完全无缺陷。数据都在你自己机器上，<b>重要记录请定期导出备份</b>。</p>
</template>

<style scoped>
/* 品牌头 */
.hero { display: flex; align-items: flex-start; gap: 16px; }
.hero-logo { width: 54px; height: 54px; flex: 0 0 54px; display: block; }
.hero-tx { min-width: 0; }
.hero-name { font-size: 18px; font-weight: 700; color: var(--text-1); letter-spacing: -.4px; display: flex; align-items: center; gap: 10px; }
.hero-slogan { font-size: 12.5px; color: var(--text-2); margin-top: 4px; }
.hero-meta { font-size: 11.5px; color: var(--text-3); margin-top: 6px; }

/* 分隔线 + 小标题 */
.rule { border: none; border-top: 1px solid var(--line); margin: 18px 0; }
.sec-title { font-size: 13px; font-weight: 700; color: var(--text-1); margin-bottom: 2px; }

/* 键值行：每行顶部虚线，首行虚线正好当"关于"下的分隔 */
.kv { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 9px 0; border-top: 1px dashed var(--line-2); font-size: 12.5px; }
.kv span { color: var(--text-3); flex: 0 0 auto; }
.kv b { color: var(--text-1); font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
.kv b.ver { color: var(--accent); }

/* 底部免责声明 */
.note { font-size: 11.5px; color: var(--text-3); line-height: 1.75; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
/* 关键小句用琥珀强调（沿用随记页"回顾"同暖色 #C2691C，比正红柔和、浅底可读） */
.note b { color: #C2691C; font-weight: 600; }

@media (max-width: 767px) {
  .hero { flex-direction: column; }
  .kv { flex-direction: column; align-items: flex-start; gap: 2px; }
  .kv b { text-align: left; }
}
</style>
