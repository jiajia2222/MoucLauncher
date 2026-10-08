/**
 * Shell copy.
 *
 * `i18n.ts` owns the shared dictionary and forbids literal strings in components, but the
 * shell must not edit that file while four other agents are porting views against it, so
 * the shell-only lines (download centre, notices, palette names, health chip) live here
 * using the sanctioned `defineDict()` feature-dictionary escape hatch. Chinese-first.
 */
import { defineDict } from '../../i18n'

export const copy = defineDict({
  /* download centre (upstream 下载中心 panel) */
  downloadCenter: ['下载中心', 'Download centre'],
  noTasks: ['没有进行中的任务', 'No active tasks'],
  goVersions: ['去版本下载', 'Go to version downloads'],
  computingTotal: ['正在计算总量', 'Measuring total size'],
  totalProgress: ['总进度 {percent}%', 'Total {percent}%'],
  pausedState: ['已暂停 · {text}', 'Paused · {text}'],
  cancellingState: ['正在停止网络与后台任务…', 'Stopping network and background work…'],
  doneState: ['已完成', 'Done'],
  cancelledState: ['已取消', 'Cancelled'],
  failedState: ['失败于「{stage}」阶段：{error}', 'Failed during “{stage}”: {error}'],
  removeFromList: ['移除记录', 'Remove entry'],
  cancelFailed: ['取消失败：{error}', 'Cancel failed: {error}'],
  jobDoneToast: ['任务完成：{title}', 'Task finished: {title}'],
  jobFailedToast: ['任务失败：{message}', 'Task failed: {message}'],
  unknownError: ['未知错误', 'Unknown error'],
  eta: ['剩余', 'ETA'],
  cancel: ['取消', 'Cancel'],
  retry: ['重试', 'Retry'],
  statInstances: ['{count} 个实例', '{count} instances'],
  statVersions: ['{count} 个版本', '{count} versions'],
  gameStoppedNotice: ['游戏已结束', 'Game exited'],
  /* notices (upstream 通知 panel) */
  notices: ['通知', 'Notifications'],
  noNotices: ['暂无通知', 'No notifications'],
  clearNotices: ['清空', 'Clear'],
  openNotices: ['打开通知中心', 'Open the notification centre'],
  backPrevious: ['返回上一个页面', 'Back to the previous page'],
  /* top bar extras */
  updateLog: ['更新日志', 'Changelog'],
  pickPack: ['选择整合包文件', 'Pick a modpack file'],
  hasUpdate: ['可更新到 {version}', 'Update available: {version}'],
  noUpdateLine: ['已是最新版本', 'Up to date'],
  /* sidebar health chip */
  healthOk: ['全部系统运行正常', 'All systems nominal'],
  healthBusy: ['{count} 项后台任务进行中', '{count} background tasks running'],
  healthError: ['最近启动出现异常', 'Last launch ended in error'],
  healthOffline: ['离线模式：仅本地文件', 'Offline: local files only'],
  /* window chrome */
  closeHint: ['关闭启动器不影响游戏，游戏继续运行', 'Closing the launcher does not stop the game — it keeps running'],
  /* theme switcher */
  themeGroup: ['主题配色', 'Theme palette'],
  paletteDefault: ['默认·黑紫', 'Default · Charcoal'],
  paletteBlueWhite: ['白蓝', 'Blue & White'],
  paletteBlackOrange: ['橙黑', 'Orange & Black'],
  paletteWhitePink: ['粉白', 'White & Pink'],
  paletteBlackPink: ['粉黑', 'Pink & Black'],
  paletteCustom: ['个性化', 'Custom'],
  switchTheme: ['切换主题', 'Switch theme'],
  switchLanguage: ['切换语言', 'Switch language'],
  /* status bar */
  gameRunningTip: ['游戏中 · PID {pid}', 'In game · PID {pid}'],
  killGameConfirm: ['确定结束 {name} 的游戏进程？', 'End the game process for {name}?'],
  updateChecking: ['正在检查更新…', 'Checking for updates…'],
  noUpdate: ['检查更新失败：{error}', 'Update check failed: {error}'],
  gameRootLabel: ['游戏目录', 'Game folder'],
  statsLine: ['{size} · {files} 个文件', '{size} · {files} files'],
  /* brand */
  brandName: ['MoucX', 'MoucX'],
  brandTail: ['X', 'X'],
  brandSub: ['Minecraft 启动器', 'Minecraft Launcher'],
  motto: ['用心做好每一次启动', 'A careful launch, every time']
})

export type CopyKey = (typeof copy.keys)[number]
