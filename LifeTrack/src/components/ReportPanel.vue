<script setup lang="ts">
/**
 * 报告面板：周报 / 月报 / 年度总结共用
 * 上半区是从日志实时聚合的只读统计（不存快照，记了新日志立刻反映），
 * 下半区是手写正文：跟录入日志一套规则，回车换行、点“保存”（或 Ctrl + S）才写进 reports 表
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { askConfirm } from "../utils/confirm";
import { addEvent, milestoneTargetEvents, type TimelineEvent } from "../utils/timeline";
import { type LogItem, LOG_KINDS, isoDate, isoToday, parseIso, streakOf } from "../utils/logs";
import {
  type ReportMode, type TodoLite, isCurrentPeriod, loadReport, loadTodos,
  periodKey, rangeOf, saveReport, titleOf, writeLabel,
} from "../utils/reports";

const props = defineProps<{ mode: ReportMode; date: Date; logs: LogItem[] }>();
// 上一期 / 下一期 / 回到本期：周期游标由父页（Logs.vue）统一保管
const emit = defineEmits<{ prev: []; next: []; back: [] }>();

const WEEK_CN = ["一", "二", "三", "四", "五", "六", "日"];
const range = computed(() => rangeOf(props.mode, props.date));
const title = computed(() => titleOf(props.mode, props.date));
const key = computed(() => periodKey(props.mode, props.date));

// ---------- 聚合 ----------
const inRange = computed(() =>
  props.logs.filter(l => l.date >= range.value.from && l.date <= range.value.to)
    .sort((a, b) => (a.date === b.date ? (a.time < b.time ? 1 : -1) : a.date < b.date ? 1 : -1)),
);
const total = computed(() => inRange.value.length);
const dayCount = computed(() => {
  const m = new Map<string, number>();
  for (const l of inRange.value) m.set(l.date, (m.get(l.date) ?? 0) + 1);
  return m;
});
const activeDays = computed(() => dayCount.value.size);
const avg = computed(() => (activeDays.value ? (total.value / activeDays.value).toFixed(1) : "0"));
/** 本期已过去的天数（当前周期不把自己算进分母） */
const elapsed = computed(() => {
  const t = isoToday();
  if (range.value.to < t) return range.value.days;
  if (range.value.from > t) return 0;
  return Math.round((new Date(t + "T00:00:00").getTime() - new Date(range.value.from + "T00:00:00").getTime()) / 86400000) + 1;
});
const kindStats = computed(() => {
  const counts = new Map<string, number>();
  for (const l of inRange.value) counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1);
  const max = Math.max(1, ...counts.values());
  return LOG_KINDS.filter(k => counts.has(k.key))
    .map(k => ({ ...k, n: counts.get(k.key)!, pct: Math.round(((counts.get(k.key) ?? 0) / max) * 100) }))
    .sort((a, b) => b.n - a.n);
});
const tagStats = computed(() => {
  const counts = new Map<string, number>();
  for (const l of inRange.value) for (const t of l.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const max = Math.max(1, ...counts.values());
  return [...counts.entries()].map(([tag, n]) => ({ tag, n, pct: Math.round((n / max) * 100) }))
    .sort((a, b) => b.n - a.n).slice(0, props.mode === "year" ? 10 : 6);
});
// 本期里程碑：里程碑是时间线上的“标记动作”投影，不再限于随记——凡是落在本期内的被标记事件都算
// milestoneTargetEvents 走 SQLite 是异步的，先拉进 ref，computed 只做过滤
const msTargets = ref<TimelineEvent[]>([]);
async function reloadMilestones() { msTargets.value = await milestoneTargetEvents(); }
const milestones = computed(() => {
  const { from, to } = range.value;
  return msTargets.value
    .filter(e => e.date >= from && e.date <= to)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .map(e => ({ id: e.id, date: e.date, text: e.summary }));
});
const bestDay = computed(() => {
  let best: { date: string; n: number } | null = null;
  for (const [date, n] of dayCount.value) if (!best || n > best.n) best = { date, n };
  return best;
});
/** 分桶趋势：周报=7 天 / 月报=各周 / 年报=12 个月 */
const buckets = computed(() => {
  const out: { label: string; n: number; cur: boolean }[] = [];
  const { from, days } = range.value;
  if (props.mode === "week") {
    for (let i = 0; i < 7; i++) {
      const d = new Date(from + "T00:00:00");
      d.setDate(d.getDate() + i);
      const s = isoDate(d);
      out.push({ label: WEEK_CN[i], n: dayCount.value.get(s) ?? 0, cur: s === isoToday() });
    }
  } else if (props.mode === "month") {
    const first = new Date(from + "T00:00:00");
    for (let i = 0; i < Math.ceil(days / 7); i++) {
      const s = new Date(first); s.setDate(s.getDate() + i * 7);
      const e = new Date(s); e.setDate(e.getDate() + 6);
      let n = 0;
      for (const [d, c] of dayCount.value) if (d >= isoDate(s) && d <= isoDate(e)) n += c;
      out.push({ label: `第 ${i + 1} 周`, n, cur: false });
    }
  } else {
    for (let m = 0; m < 12; m++) {
      const p = `${props.date.getFullYear()}-${String(m + 1).padStart(2, "0")}`;
      let n = 0;
      for (const [d, c] of dayCount.value) if (d.startsWith(p)) n += c;
      out.push({ label: `${m + 1} 月`, n, cur: m === props.date.getMonth() });
    }
  }
  const max = Math.max(1, ...out.map(b => b.n));
  return out.map(b => ({ ...b, pct: Math.round((b.n / max) * 100) }));
});
const streak = computed(() => streakOf(props.logs.map(l => l.date)));
/** 本周 / 本月 / 今年：同一期正在过、已过还是还没来，全部从日期算，不写死 */
const curWord = computed(() => (props.mode === "week" ? "本周" : props.mode === "month" ? "本月" : "今年"));
const phase = computed(() => {
  const t = isoToday();
  if (range.value.from > t) return "未开始";
  if (range.value.to < t) return "已结束";
  return curWord.value;
});
const ongoing = computed(() => phase.value === curWord.value && elapsed.value < range.value.days);
const atCur = computed(() => isCurrentPeriod(props.mode, props.date));
const backLabel = computed(() => `回到${curWord.value}`);
/** 待办：本期到期 / 其中已清 / 逾期还没清（数据从 tasks 表异步拉，stats 只做过滤） */
const todos = ref<TodoLite[]>([]);
async function reloadTodos() { todos.value = await loadTodos(); }
const todoStats = computed(() => {
  const { from, to } = range.value;
  const t = isoToday();
  const all = todos.value;
  const due = all.filter(x => x.due && x.due >= from && x.due <= to);
  return {
    due: due.length,
    done: due.filter(x => x.done).length,
    overdue: all.filter(x => !x.done && x.due && x.due < t).length,
  };
});

// ---------- 正文（手写区：跟录入日志一致，点“保存”才落库；读写皆异步）----------
const savedText = ref("");
const savedAt = ref(0);
const text = ref("");
/** 载入指定期已保存的正文并覆盖编辑区（初次挂载与切换周期时调用） */
async function loadBody(k: string) {
  const doc = await loadReport(k);
  savedText.value = doc?.text ?? "";
  savedAt.value = doc?.updatedAt ?? 0;
  text.value = savedText.value;
}
const dirty = computed(() => text.value !== savedText.value);
const words = computed(() => text.value.trim().length);

function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
/** 存指定周期：watch 里 key.value 已经是新一期，所以 key 必须当参数传 */
async function saveNow(k: string) {
  await saveReport(k, text.value);
  const doc = await loadReport(k);
  savedText.value = doc?.text ?? "";
  savedAt.value = doc?.updatedAt ?? Date.now();
  await addEvent("report.saved", `保存了 ${title.value.main}`);
}
function save() {
  if (!dirty.value) return;
  void saveNow(key.value);
}
function revert() {
  text.value = savedText.value;
}
const saveState = computed(() => {
  if (dirty.value) return "有改动未保存";
  return savedAt.value ? `已保存 · ${fmtTime(savedAt.value)}` : "还没写";
});

watch(key, nk => {
  // 未保存的改动由父页在动游标之前 askLeave() 问过，这里只负责重新载新一期
  void loadBody(nk);
  void reloadMilestones();
});

/**
 * 动游标 / 切视图 / 离开本页之前的未保存拦截（统一用应用内确认框，不用浏览器原生 confirm）
 * 返回 false 表示用户选了“留在这一期”，调用方应当放弃本次切换
 */
async function askLeave(what: string, stay = "留在这一期", okText = "保存并切换"): Promise<boolean> {
  if (!dirty.value) return true;
  const r = await askConfirm({
    title: `${writeLabel(props.mode)}还没保存`,
    message: `「${title.value.main}」的正文有改动，${what}之前要先存上吗？`,
    ok: okText,
    also: "丢弃改动",
    cancel: stay,
  });
  if (r === "ok") await saveNow(key.value);
  return r !== "cancel";
}
defineExpose({ askLeave });

// Ctrl/⌘ + S 整页可用
function onHotkey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
}
onMounted(() => {
  window.addEventListener("keydown", onHotkey);
  void loadBody(key.value);
  void reloadMilestones();
  void reloadTodos();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onHotkey));

onBeforeRouteLeave(() => askLeave("离开这一页", "留在本页", "保存并离开"));

/** 草稿：把聚合区压成文字，正文非空时问一句怎么放 */
async function makeDraft() {
  const build = () => {
    const L: string[] = [`# ${title.value.main}`, ""];
    L.push(`- 记录 ${total.value} 条，活跃 ${activeDays.value}/${range.value.days} 天，有记录的日子平均 ${avg.value} 条/天`);
    if (kindStats.value.length) L.push(`- 类别：${kindStats.value.map(k => `${k.key} ${k.n}`).join(" · ")}`);
    if (tagStats.value.length) L.push(`- 高频标签：${tagStats.value.slice(0, 5).map(t => `${t.tag}(${t.n})`).join(" · ")}`);
    if (bestDay.value) L.push(`- 最猛的一天：${md(bestDay.value.date)}（${bestDay.value.n} 条）`);
    if (milestones.value.length) {
      L.push("", "## 本期里程碑");
      for (const m of milestones.value) L.push(`- ${md(m.date)} ${brief(m.text, 80)}`);
    }
    if (props.mode !== "week") {
      L.push("", "## 节奏");
      for (const b of buckets.value) L.push(`- ${b.label}：${b.n} 条`);
    }
    if (todoStats.value.due || todoStats.value.overdue) {
      L.push("", `## 待办
- 本期到期 ${todoStats.value.due} 项，已清 ${todoStats.value.done} 项；逾期未清 ${todoStats.value.overdue} 项`);
    }
    L.push("", `## ${writeLabel(props.mode)}`, "", "做成的事：", "卡住的地方：", "下一期想改的一件事：", "");
    return L.join("\n");
  };
  if (!text.value.trim()) {
    text.value = build();
    return;
  }
  const r = await askConfirm({
    title: "正文已经有内容",
    message: `「${title.value.main}」已经写了 ${words.value} 字，生成的草稿要怎么放？`,
    ok: "追加到下面",
    also: "覆盖正文",
    cancel: "取消",
  });
  if (r === "cancel") return;
  text.value = r === "also" ? build() : `${text.value.trimEnd()}\n\n---\n\n${build()}`;
}
function md(s: string) {
  const d = parseIso(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function plain(s: string) {
  return s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}
/** 列表里只取第一段、截断；全文回日志页看 */
function brief(s: string, n = 52) {
  const first = s.split("\n").map(x => x.trim()).filter(Boolean)[0] ?? "";
  const t = plain(first);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------- 复制 Markdown（不依赖插件，离线可用） ----------
const copied = ref(false);
async function copyMd() {
  const auto = [
    `> ${title.value.main}（${title.value.sub}）`,
    `> 记录 ${total.value} 条 · 活跃 ${activeDays.value}/${range.value.days} 天 · 平均 ${avg.value} 条/天`,
    kindStats.value.length ? `> 类别：${kindStats.value.map(k => `${k.key} ${k.n}`).join(" · ")}` : "",
    milestones.value.length ? `> 里程碑：${milestones.value.map(m => brief(m.text, 40)).join("；")}` : "",
  ].filter(Boolean).join("\n");
  const mdText = [auto, "", text.value.trim()].join("\n").trim();
  try {
    await navigator.clipboard.writeText(mdText);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    // WebView2 偶尔拒绝剪贴板权限，退化成选中文本让用户 Ctrl+C
    (document.getElementById("rp-raw") as HTMLTextAreaElement | null)?.select();
  }
}

const nums = computed(() => [
  { v: String(total.value), s: props.mode === "year" ? "条 / 全年" : "条记录" },
  { v: `${activeDays.value}`, s: props.mode === "week" ? `天 / 已过 ${elapsed.value} 天` : "个活跃天" },
  { v: avg.value, s: "条 / 活跃天" },
  { v: `${streak.value}`, s: "当前连续天" },
]);
const daysShown = computed(() => `${range.value.from} – ${range.value.to}`);
</script>

<template>
  <div class="rp">
    <!-- ============ 头部 ============ -->
    <header class="rp-head">
      <div class="rp-hl">
        <div class="rp-title">
          {{ title.main }}
          <span class="rp-cur" :class="{ done: phase === '已结束', future: phase === '未开始' }">{{ phase }}</span>
        </div>
        <div class="rp-sub">
          {{ title.sub }} · {{ daysShown }}
          <template v-if="ongoing"> · 已过 {{ elapsed }} / {{ range.days }} 天，还能再记 {{ range.days - elapsed }} 天</template>
        </div>
      </div>
      <div class="rp-acts">
        <div class="rp-nav">
          <button class="rp-nb" title="上一期" @click="emit('prev')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button class="rp-nav-lbl" :disabled="atCur" :title="atCur ? '你已经在本期' : backLabel" @click="emit('back')">{{ atCur ? curWord : backLabel }}</button>
          <button class="rp-nb" title="下一期" @click="emit('next')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
        <button class="rp-btn" @click="makeDraft">生成草稿</button>
        <button class="rp-btn" :class="{ ok: copied }" @click="copyMd">{{ copied ? "已复制 ✓" : "复制 Markdown" }}</button>
      </div>
    </header>

    <!-- ============ 自动聚合（只读） ============ -->
    <section class="rp-auto">
      <div class="rp-nums">
        <div v-for="n in nums" :key="n.s" class="rp-n"><b>{{ n.v }}</b><span>{{ n.s }}</span></div>
      </div>

      <div v-if="kindStats.length" class="rp-block">
        <div class="rp-bt">类别构成</div>
        <div v-for="k in kindStats" :key="k.key" class="rp-bar">
          <span class="rp-k">{{ k.key }}</span>
          <span class="rp-track"><i :style="{ width: k.pct + '%', background: k.color }"></i></span>
          <span class="rp-v">{{ k.n }}</span>
        </div>
      </div>

      <div v-if="buckets.length" class="rp-block">
        <div class="rp-bt">{{ mode === 'week' ? '逐日节奏' : mode === 'month' ? '周节奏' : '逐月节奏' }}</div>
        <div class="rp-trend">
          <div v-for="b in buckets" :key="b.label" class="rp-tb" :class="{ cur: b.cur, zero: !b.n }">
            <b>{{ b.n }}</b>
            <span class="rp-tbar"><i :style="{ height: b.pct + '%' }"></i></span>
            <span class="rp-tl">{{ b.label }}</span>
          </div>
        </div>
      </div>

      <div v-if="tagStats.length" class="rp-block">
        <div class="rp-bt">高频标签</div>
        <div class="rp-tags">
          <span v-for="t in tagStats" :key="t.tag" class="rp-tag">#{{ t.tag }}<i>{{ t.n }}</i></span>
        </div>
      </div>

      <div class="rp-block">
        <div class="rp-bt">里程碑</div>
        <ul v-if="milestones.length" class="rp-ms">
          <li v-for="m in milestones" :key="m.id">
            <span class="rp-ms-d">{{ md(m.date) }}</span>
            <span class="rp-ms-t">{{ brief(m.text) }}</span>
          </li>
        </ul>
        <div v-else class="rp-none">{{ mode === 'year' ? '这一年没有标记过里程碑' : '本期没有里程碑' }}</div>
      </div>

      <div class="rp-block">
        <div class="rp-bt">待办</div>
        <div class="rp-td">
          本期到期 <b>{{ todoStats.due }}</b> 项 · 已清 <b>{{ todoStats.done }}</b> 项
          <span :class="{ warn: todoStats.overdue > 0 }">· 逾期未清 <b>{{ todoStats.overdue }}</b> 项</span>
          <span v-if="bestDay" class="rp-best">最猛的一天：{{ parseIso(bestDay.date).getMonth() + 1 }}/{{ parseIso(bestDay.date).getDate() }}（{{ bestDay.n }} 条）</span>
        </div>
      </div>
    </section>

    <!-- ============ 手写正文 ============ -->
    <section class="rp-write">
      <div class="rp-wt">
        {{ writeLabel(mode) }}
        <span class="rp-wtip">只有这一段是你写的，上面的数字实时跟着日志变 · 回车换行，点“保存”才存进本机</span>
      </div>
      <textarea
        id="rp-raw"
        v-model="text"
        spellcheck="false"
        :placeholder="`比如：这期真正做成的事 / 卡在哪 / 下一期想改的一件事…（支持 **文字** 加粗）`"
        @keydown.ctrl.enter.prevent="save"
        @keydown.meta.enter.prevent="save"
      ></textarea>
      <div class="rp-foot">
        <span class="rp-fl">
          <span class="rp-save" :class="{ dirty }">{{ saveState }}</span>
          <span v-if="words" class="rp-sep">·</span>
          <span v-if="words" class="rp-cnt">{{ words }} 字</span>
        </span>
        <span class="rp-fr">
          <button v-if="dirty" class="rp-back" @click="revert">放弃改动</button>
          <button class="rp-save-btn" :class="{ on: dirty }" :disabled="!dirty" :title="dirty ? '写入本机（Ctrl + S）' : '没有改动'" @click="save">保存</button>
        </span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rp { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

/* 头部 */
.rp-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.rp-title { font-size: 16px; font-weight: 700; color: var(--text-1); letter-spacing: -.3px; display: flex; align-items: center; gap: 8px; }
.rp-cur { font-size: 10px; font-weight: 600; color: var(--accent-dark); background: var(--accent-soft); border-radius: 999px; padding: 2px 8px; letter-spacing: 0; }
.rp-cur.done { color: var(--text-3); background: var(--chip); }
.rp-cur.future { color: var(--text-3); background: var(--chip); }
.rp-sub { font-size: 11px; color: var(--text-3); margin-top: 3px; font-variant-numeric: tabular-nums; }
.rp-acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rp-nav { display: flex; align-items: center; gap: 1px; margin-right: 4px; }
.rp-nb {
  width: 26px; height: 26px; border: 1px solid var(--line); background: var(--card);
  border-radius: 8px; display: grid; place-items: center; color: var(--text-3); cursor: pointer;
  transition: border-color .15s ease, color .15s ease;
}
.rp-nb:hover { border-color: var(--accent); color: var(--accent-dark); }
.rp-nav-lbl {
  border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 0 10px; height: 26px;
  font-size: 11px; font-weight: 600; color: var(--accent-dark); font-family: inherit; cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease;
}
.rp-nav-lbl:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); }
.rp-nav-lbl:disabled { color: var(--text-3); cursor: default; }
.rp-btn {
  border: 1px solid var(--line); background: var(--card); border-radius: 9px; color: var(--text-2);
  font-size: 11.5px; font-family: inherit; padding: 5px 12px; cursor: pointer;
  transition: border-color .15s ease, color .15s ease, background-color .15s ease;
}
.rp-btn:hover { border-color: var(--accent); color: var(--accent-dark); }
.rp-btn.ok { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-dark); font-weight: 600; }

/* 卡片外壳 */
.rp-auto, .rp-write {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--r);
  box-shadow: var(--shadow-sm);
}

/* 聚合区 */
.rp-auto { padding: 18px 20px; display: flex; flex-direction: column; gap: 16px; }
.rp-nums { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.rp-n b { display: block; font-size: 22px; font-weight: 700; color: var(--text-1); letter-spacing: -.7px; line-height: 1.15; font-variant-numeric: tabular-nums; }
.rp-n span { font-size: 10.5px; color: var(--text-3); }
.rp-block { display: flex; flex-direction: column; gap: 8px; }
.rp-bt { font-size: 11px; font-weight: 700; color: var(--text-2); letter-spacing: .2px; }
.rp-bar { display: grid; grid-template-columns: 32px 1fr 26px; align-items: center; gap: 9px; }
.rp-k { font-size: 11px; color: var(--text-2); }
.rp-track { height: 5px; background: var(--track); border-radius: 3px; overflow: hidden; }
.rp-track i { display: block; height: 100%; border-radius: 3px; transition: width .35s ease; }
.rp-v { font-size: 11px; color: var(--text-3); text-align: right; font-variant-numeric: tabular-nums; }

.rp-trend { display: flex; gap: 6px; align-items: stretch; }
.rp-tb { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.rp-tb b { font-size: 10.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.rp-tb.zero b { color: var(--text-3); }
.rp-tb.cur b { color: var(--accent-dark); }
.rp-tbar { width: 100%; max-width: 34px; height: 40px; background: var(--track); border-radius: 4px; display: flex; align-items: flex-end; overflow: hidden; }
.rp-tbar i { display: block; width: 100%; background: var(--accent); opacity: .75; border-radius: 4px 4px 0 0; transition: height .35s ease; }
.rp-tb.zero .rp-tbar i { background: transparent; }
.rp-tl { font-size: 9.5px; color: var(--text-3); white-space: nowrap; }

.rp-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.rp-tag {
  font-size: 10.5px; color: var(--text-2); background: var(--chip); border-radius: 999px; padding: 2px 9px;
  display: inline-flex; gap: 5px; align-items: center;
}
.rp-tag i { font-style: normal; color: var(--text-3); font-variant-numeric: tabular-nums; }

.rp-ms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.rp-ms li { display: flex; gap: 10px; font-size: 12px; color: var(--text-2); line-height: 1.6; min-width: 0; }
.rp-ms-d { flex: 0 0 42px; font-size: 11px; color: var(--accent-dark); font-weight: 600; font-variant-numeric: tabular-nums; padding-top: 1px; }
.rp-ms-t { min-width: 0; }
.rp-none { font-size: 11.5px; color: var(--text-3); }

.rp-td { font-size: 11.5px; color: var(--text-2); display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.rp-td b { color: var(--text-1); font-variant-numeric: tabular-nums; }
.rp-td .warn b { color: var(--danger); }
.rp-best { color: var(--text-3); }

/* 手写区 */
.rp-write { padding: 16px 20px 12px; }
.rp-wt { font-size: 12px; font-weight: 700; color: var(--text-1); display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.rp-wtip { font-size: 10.5px; font-weight: 500; color: var(--text-3); }
.rp-write textarea {
  width: 100%; min-height: 190px; margin-top: 11px; border: 1px solid transparent; border-radius: 10px;
  background: var(--hover-2); padding: 12px 14px; font-size: 13px; line-height: 1.85; color: var(--text-1);
  font-family: inherit; outline: none; resize: vertical; box-sizing: border-box;
  transition: border-color .15s ease, background-color .15s ease;
}
.rp-write textarea:focus { border-color: var(--accent); background: var(--field); }
.rp-write textarea::placeholder { color: var(--text-3); }
.rp-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; font-size: 10.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.rp-fl, .rp-fr { display: flex; align-items: center; gap: 7px; }
.rp-save.dirty { color: var(--orange); font-weight: 600; }
.rp-back {
  border: none; background: none; font-family: inherit; font-size: 10.5px; color: var(--text-3);
  cursor: pointer; padding: 4px 6px; border-radius: 7px; transition: background-color .15s ease, color .15s ease;
}
.rp-back:hover { background: var(--hover); color: var(--text-1); }
.rp-save-btn {
  border: 1px solid transparent; border-radius: 9px; padding: 5px 16px; cursor: pointer;
  font-size: 11.5px; font-weight: 600; font-family: inherit; background: var(--track); color: var(--text-3);
  transition: background-color .15s ease, color .15s ease, box-shadow .15s ease;
}
.rp-save-btn.on { background: var(--accent); color: #fff; box-shadow: 0 2px 6px rgba(23, 161, 125, .26); }
.rp-save-btn.on:hover { background: var(--accent-dark); }
.rp-save-btn:disabled { background: var(--track); color: var(--text-3); cursor: default; }

/* 响应式：断点体系见 global.css */
@media (max-width: 1023px) {
  .rp-nums { grid-template-columns: repeat(4, 1fr); }
}
@media (max-width: 767px) {
  .rp-auto { padding: 16px 14px; gap: 14px; }
  .rp-write { padding: 14px; }
  .rp-foot { flex-wrap: wrap; }
  .rp-nums { grid-template-columns: repeat(2, 1fr); gap: 14px 10px; }
  .rp-tl { font-size: 8.5px; }
  .rp-tbar { height: 32px; }
  .rp-btn { padding: 8px 12px; }
}
</style>
