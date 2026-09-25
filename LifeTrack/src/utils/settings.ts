/**
 * 应用设置数据层：昵称、关窗行为、悬浮球开关——统一走偏好层（trackbook.json，见 prefs.ts）
 * 主题不在这里（由 theme.ts 管），但同存于同一份 Prefs；本模块只是它的一个同步视图
 * 对外 API（loadSettings / saveSettings / AppSettings / CloseBehavior）保持不变，消费方无需改动
 */
import { readPrefs, writePrefs, type CloseBehavior } from "./prefs";

export type { CloseBehavior };

export interface AppSettings {
  /** 用户昵称，用于 Dashboard 问候语和头像首字母 */
  nickname: string;
  /** 主窗口点 X 的行为：每次询问 / 最小化到托盘 / 直接退出（永久记忆，设置页单选） */
  closeBehavior: CloseBehavior;
  /** 桌面悬浮球是否开启（关掉后仅留托盘，球窗隐藏） */
  ballEnabled: boolean;
}

export function loadSettings(): AppSettings {
  const p = readPrefs();
  return { nickname: p.nickname, closeBehavior: p.closeBehavior, ballEnabled: p.ballEnabled };
}

export function saveSettings(s: AppSettings) {
  writePrefs({ nickname: s.nickname, closeBehavior: s.closeBehavior, ballEnabled: s.ballEnabled });
}
