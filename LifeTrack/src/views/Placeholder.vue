<script setup lang="ts">
import { useRoute } from "vue-router";

const route = useRoute();

// 各页面路由的中文名，与侧栏导航一致
const titles: Record<string, string> = {
  timeline: "时间线",
  projects: "目标",
  logs: "日志",
  settings: "设置",
};
</script>

<template>
  <div>
    <div class="hello">
      <h1>{{ titles[route.name as string] ?? "页面" }}</h1>
      <p>该模块正在开发中，按计划一个页面一个页面来。</p>
    </div>
  </div>
</template>
