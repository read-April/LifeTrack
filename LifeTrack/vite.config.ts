import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
// 构建期取版本号（关于页用），避开前端再写一份版本常量；Vite 要求 JSON 导入带 import attribute
import pkg from "./package.json" with { type: "json" };
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [vue()],

  // 关于页的版本号/构建时间：单一来源 package.json + 构建时刻，不往页面里写死
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  //    端口避开 Windows 保留段（本机 1374–1473 被 Hyper-V/WSL 划走，1420 会 EACCES）
  server: {
    port: 1520,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1521,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
