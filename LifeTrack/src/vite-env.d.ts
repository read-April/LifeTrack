/// <reference types="vite/client" />

// 由 vite.config.ts 的 define 注入（来源：package.json 版本号 + 构建时刻）
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// updater 插件类型声明（npm install 后可删除此声明）
declare module "@tauri-apps/plugin-updater" {
  export interface Update {
    version: string;
    body?: string;
    date?: string;
    downloadAndInstall: () => Promise<void>;
  }
  export function check(): Promise<Update | null>;
}
