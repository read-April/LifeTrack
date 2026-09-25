import { createRouter, createWebHashHistory } from "vue-router";

// Tauri 生产环境下 hash 路由无需服务端 rewrite，最稳妥
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // 打开应用默认进随记（记录是最高频动作）；仪表盘给独立入口
    { path: "/", redirect: "/logs" },
    { path: "/dashboard", name: "dashboard", component: () => import("../views/Dashboard.vue") },
    { path: "/timeline", name: "timeline", component: () => import("../views/Timeline.vue") },
    { path: "/projects", name: "projects", component: () => import("../views/Projects.vue") },
    { path: "/projects/:id", name: "goal-detail", component: () => import("../views/GoalDetail.vue") },
    { path: "/logs", name: "logs", component: () => import("../views/Logs.vue") },
    { path: "/settings", name: "settings", component: () => import("../views/Settings.vue") },
    // 托盘浮窗（独立无边框 WebviewWindow 加载）：meta.bare 让 App.vue 跳过侧栏外壳与开屏层
    { path: "/quick-note", name: "quick-note", component: () => import("../views/QuickNote.vue"), meta: { bare: true } },
    { path: "/focus", name: "focus", component: () => import("../views/FocusTimer.vue"), meta: { bare: true } },
    { path: "/focus-record", name: "focus-record", component: () => import("../views/FocusRecord.vue"), meta: { bare: true } },
    // 常驻悬浮球（启动即建的独立置顶透明窗）：拖动 / 贴边吸附 / 弹 dock 定位全在本页 JS 接管（尺寸恒定）
    { path: "/ball", name: "ball", component: () => import("../views/Ball.vue"), meta: { bare: true } },
    // 悬浮球 hover 弹出的胶囊 dock：另一个固定尺寸独立透明窗，只 show/hide，不 resize
    { path: "/ball-dock", name: "ball-dock", component: () => import("../views/BallDock.vue"), meta: { bare: true } },
  ],
});

export default router;
