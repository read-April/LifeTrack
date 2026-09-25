/**
 * 应用内确认框：替代浏览器原生 confirm()
 * 桌面端浏览器/WebView2 的原生弹窗样式与应用主题完全脱节，且只能给"确定/取消"两个按钮，
 * 这里做成 Promise 形式的三态对话框（主按钮 / 次按钮 / 取消），由 ConfirmDialog.vue 渲染。
 */
import { reactive } from "vue";

export type ConfirmResult = "ok" | "also" | "cancel";

export type ConfirmOpts = {
  title: string;
  message?: string;
  /** 主按钮（主题色实底），回车触发；不传则不显示 */
  ok?: string;
  /** 次按钮（描边），如"丢弃改动" */
  also?: string;
  /** 弱化按钮（纯文字），Esc / 点遮罩等价于它；默认"取消" */
  cancel?: string;
  /** 危险操作：主按钮转红，用于删除类 */
  danger?: boolean;
};

const DEFAULTS: ConfirmOpts = { title: "", ok: "确定", cancel: "取消" };

/** 同一时刻只有一个确认框（confirm 语义本就是阻塞的） */
export const confirmBox = reactive<{ open: boolean; opts: ConfirmOpts }>({
  open: false,
  opts: { ...DEFAULTS, title: "" },
});

let pending: ((r: ConfirmResult) => void) | null = null;

export function askConfirm(opts: ConfirmOpts): Promise<ConfirmResult> {
  // 理论上不会重入（调用方都 await），真出现时让旧的先取消，避免 Promise 悬挂
  pending?.("cancel");
  confirmBox.opts = { ...DEFAULTS, ...opts };
  confirmBox.open = true;
  return new Promise<ConfirmResult>(resolve => { pending = resolve; });
}

export function settleConfirm(r: ConfirmResult) {
  if (!confirmBox.open) return;
  confirmBox.open = false;
  const resolve = pending;
  pending = null;
  resolve?.(r);
}

/** 只有一步确认的删除类操作，写起来更顺一点 */
export function askDelete(title: string, message?: string): Promise<boolean> {
  return askConfirm({ title, message, ok: "删除", danger: true }).then(r => r === "ok");
}
