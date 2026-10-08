/**
 * MoucX i18n.
 *
 * Chinese-first: `zh` is the source of truth and its keys define the `I18nKey`
 * union. `en` is typed as `Record<I18nKey, string>`, so a key added to zh and not
 * to en is a compile error — the two dictionaries can never drift apart.
 *
 * Rules enforced here:
 * - No component contains a literal UI string; every label goes through `t()`.
 * - Keys are namespaced (`nav.home`, `launch.start`, `common.retry`).
 * - `{name}` placeholders are used instead of string concatenation, so word order
 *   stays translatable.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Language } from '@shared/types'

const zh = {
  /* ---------------------------------------------------------------- app */
  'app.name': 'MoucX',
  'app.tagline': '自研 Minecraft 启动器',
  'app.loadingView': '视图加载中',
  'app.viewPending': '视图未就绪',
  'app.viewPendingHint': '该视图文件尚未创建，创建后会自动接入，无需修改外壳。',
  'app.expectedFile': '期望文件',
  'app.mockBanner': '浏览器预览：使用内置模拟接口',
  'app.mockEmpty': '空数据模式（?empty）',

  /* --------------------------------------------------------------- nav */
  'nav.home': '开始游戏',
  'nav.instances': '实例',
  'nav.versions': '版本',
  'nav.mods': '模组',
  'nav.accounts': '账户',
  'nav.java': 'Java',
  'nav.online': '联机',
  'nav.settings': '设置',
  'nav.groupGame': '游戏',
  'nav.groupContent': '内容',
  'nav.groupEnv': '环境',
  'nav.groupSystem': '系统',
  'nav.gallery': '组件画廊',

  /* --------------------------------------------------------- titlebar */
  'win.minimize': '最小化',
  'win.maximize': '最大化',
  'win.restore': '还原',
  'win.close': '关闭',
  'win.alwaysOnTop': '总在最前',

  /* -------------------------------------------------------- status bar */
  'status.ready': '就绪',
  'status.speed': '速度',
  'status.eta': '剩余',
  'status.noJob': '无下载任务',
  'status.jobRunning': '正在下载',
  'status.jobPaused': '已暂停',
  'status.jobFailed': '任务失败',
  'status.jobDone': '任务完成',
  'status.gameRunning': '{name} · PID {pid}',
  'status.gameNone': '未在运行',
  'status.versionLabel': '版本',
  'status.theme': '主题',
  'status.themeDark': '深色',
  'status.themeLight': '浅色',
  'status.language': '语言',
  'status.online': '在线',
  'status.offline': '离线',
  'status.updateAvailable': '可更新到 {version}',
  'status.updateLatest': '已是最新版本',
  'status.stats': '{instances} 个实例 · {versions} 个版本',
  'status.openGallery': '打开组件画廊',

  /* -------------------------------------------------------------- auth */
  'account.title': '账户',
  'account.addMicrosoft': '微软登录',
  'account.addOffline': '离线账户',
  'account.type': '类型',
  'account.type.microsoft': '微软',
  'account.type.offline': '离线',
  'account.type.yggdrasil': 'Yggdrasil',
  'account.type.authlibInjector': 'authlib-injector',
  'account.token.valid': '令牌有效',
  'account.token.needsRefresh': '令牌待刷新',
  'account.token.invalid': '令牌失效',
  'account.token.none': '无令牌',
  'account.expiresAt': '{time} 过期',
  'account.selected': '当前账户',
  'account.select': '设为当前',
  'account.skin': '皮肤',
  'account.deviceCode': '设备码',
  'account.deviceCodeHint': '在浏览器打开 {url} 并输入下面的代码。',
  'account.waitForLogin': '等待你在浏览器完成登录',
  'account.loginFailed': '登录失败',

  /* ------------------------------------------------------------ launch */
  'launch.start': '启动游戏',
  'launch.launching': '正在启动',
  'launch.running': '游戏运行中',
  'launch.stop': '停止游戏',
  'launch.currentInstance': '当前实例',
  'launch.recentPlayed': '最近游玩',
  'launch.quickActions': '快捷入口',
  'launch.noInstance': '还没有实例',
  'launch.noInstanceHint': '创建一个实例，或从整合包导入。',
  'launch.createFirst': '新建实例',
  'launch.importModpack': '导入整合包',
  'launch.checking': '启动前检查',
  'launch.readyToLaunch': '可以启动',
  'launch.blocked': '无法启动',
  'launch.previewArgs': '查看启动参数',

  /* ---------------------------------------------------------- instance */
  'instance.new': '新建实例',
  'instance.duplicate': '复制',
  'instance.rename': '重命名',
  'instance.openDir': '打开目录',
  'instance.remove': '删除实例',
  'instance.removeConfirm': '删除「{name}」？',
  'instance.removeFiles': '同时删除文件',
  'instance.isolated': '隔离目录',
  'instance.sharedRoot': '共用根目录',
  'instance.stateOk': '完整',
  'instance.stateMissing': '缺失 {n} 个文件',
  'instance.stateBroken': '版本损坏',
  'instance.loader': '加载器',
  'instance.gameVersion': '游戏版本',
  'instance.memory': '内存',
  'instance.lastPlayed': '最近游玩',
  'instance.modCount': '{n} 个模组',
  'instance.namePlaceholder': '实例名称',
  'instance.sortBy': '排序',
  'instance.sort.name': '按名称',
  'instance.sort.recent': '按最近游玩',
  'instance.sort.created': '按创建时间',
  'instance.filter.all': '全部',
  'instance.pin': '固定到快捷入口',
  'instance.unpin': '取消固定',

  /* ----------------------------------------------------------- version */
  'version.refresh': '刷新列表',
  'version.install': '安装版本',
  'version.installed': '已安装',
  'version.notInstalled': '未安装',
  'version.repair': '校验修复',
  'version.uninstall': '卸载',
  'version.type.release': '正式版',
  'version.type.snapshot': '快照版',
  'version.type.old_beta': '旧版 Beta',
  'version.type.old_alpha': '旧版 Alpha',
  'version.latestRelease': '最新正式版',
  'version.latestSnapshot': '最新快照',
  'version.emptyManifest': '没有可用版本，点击刷新获取列表。',

  /* --------------------------------------------------------------- mod */
  'mod.search': '搜索模组',
  'mod.install': '安装',
  'mod.installed': '已安装',
  'mod.update': '有更新',
  'mod.updateAll': '全部更新',
  'mod.enable': '启用',
  'mod.disable': '停用',
  'mod.remove': '删除模组',
  'mod.localFile': '从本地安装',
  'mod.checkUpdates': '检查更新',
  'mod.provider': '来源',
  'mod.downloads': '{n} 次下载',
  'mod.requiresVersion': '需要 {version}',
  'mod.noResult': '没有找到相关项目',
  'mod.kind.mod': '模组',
  'mod.kind.resourcepack': '资源包',
  'mod.kind.shader': '光影',
  'mod.kind.modpack': '整合包',
  'mod.kind.world': '世界',

  /* -------------------------------------------------------------- java */
  'java.runtimes': '已发现的运行时',
  'java.scan': '扫描本机 Java',
  'java.provision': '下载 Java {major}',
  'java.remove': '移除',
  'java.missing': '缺少 Java {major}',
  'java.missingHint': '该版本需要 Java {major}，本机未安装。',
  'java.broken': '无法执行：{reason}',
  'java.mode': '选择策略',
  'java.mode.auto': '自动匹配',
  'java.mode.mojang': 'Mojang 组件',
  'java.mode.adoptium': 'Adoptium',
  'java.mode.custom': '自定义路径',
  'java.major': 'Java {major}',
  'java.vendor': '发行商',
  'java.arch': '架构',
  'java.path': '路径',
  'java.inUse': '启动将使用',

  /* ------------------------------------------------------------ online */
  'online.servers': '服务器',
  'online.addServer': '添加服务器',
  'online.address': '地址',
  'online.port': '端口',
  'online.ping': 'Ping',
  'online.join': '加入服务器',
  'online.latency': '{n} ms',
  'online.offline': '无法连接',
  'online.motd': 'MotD',
  'online.players': '{online}/{max}',
  'online.lan': '局域网',
  'online.lanScan': '扫描局域网',
  'online.lanStop': '停止扫描',
  'online.lanNone': '没有发现局域网世界',
  'online.relay': '跨网联机',
  'online.relayHost': '建立房间',
  'online.relayJoin': '加入房间',
  'online.relayStop': '断开',
  'online.relayRoom': '房间码',
  'online.relayCopyHint': '把房间码发给朋友即可加入',
  'online.relay.state.idle': '未连接',
  'online.relay.state.hosting': '正在托管',
  'online.relay.state.joining': '正在加入',
  'online.relay.state.connected': '已连接',
  'online.relay.state.error': '连接失败',

  /* -------------------------------------------------------------- misc */
  'log.console': '日志',
  'log.empty': '暂无日志输出',
  'crash.title': '崩溃分析',
  'crash.cause': '原因',
  'crash.suggestion': '建议',
  'crash.evidence': '关键堆栈',
  'crash.severity.info': '提示',
  'crash.severity.warning': '警告',
  'crash.severity.critical': '严重',

  /* -------------------------------------------------------------- game */
  'game.pid': 'PID {pid}',
  'game.duration': '已运行 {time}',
  'game.kill': '结束进程',
  'game.killConfirm': '强制结束「{name}」？未保存的进度可能丢失。',
  'game.exitCode': '退出码 {code}',

  /* ----------------------------------------------------------- settings */
  'settings.gameRoot': '游戏根目录',
  'settings.downloads': '下载',
  'settings.concurrent': '并发数',
  'settings.resume': '断点续传',
  'settings.strict': '严格模式',
  'settings.mirrors': '下载源',
  'settings.appearance': '外观',
  'settings.closeAction': '关闭按钮',
  'settings.closeAction.minimize': '最小化到托盘',
  'settings.closeAction.exit': '退出启动器',
  'settings.closeAction.ask': '每次询问',
  'settings.console': '显示游戏控制台',
  'settings.hideOnLaunch': '启动后隐藏窗口',
  'settings.jvmArgs': 'JVM 参数',
  'settings.proxy': '代理',
  'settings.relayServer': '联机服务器',
  'settings.saved': '设置已保存',
  'settings.resetConfirm': '恢复全部默认设置？',

  /* ------------------------------------------------------------ common */
  'common.confirm': '确定',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.dismiss': '忽略',
  'common.retry': '重试',
  'common.delete': '删除',
  'common.save': '保存',
  'common.apply': '应用',
  'common.reset': '重置',
  'common.add': '添加',
  'common.create': '创建',
  'common.edit': '编辑',
  'common.open': '打开',
  'common.import': '导入',
  'common.export': '导出',
  'common.refresh': '刷新',
  'common.copy': '复制',
  'common.searchPlaceholder': '搜索…',
  'common.clear': '清空',
  'common.loading': '加载中',
  'common.empty': '暂无数据',
  'common.emptyHint': '这里还是空的。',
  'common.noMatch': '无匹配项',
  'common.none': '无',
  'common.unknown': '未知',
  'common.optional': '可选',
  'common.name': '名称',
  'common.status': '状态',
  'common.action': '操作',
  'common.size': '大小',
  'common.time': '时间',
  'common.version': '版本',
  'common.total': '共 {n} 项',
  'common.selectAll': '全选',
  'common.sort': '排序',
  'common.filter': '筛选',
  'common.details': '详情',
  'common.browse': '浏览…',
  'common.back': '返回',
  'common.next': '继续',
  'common.selectPlaceholder': '请选择',
  'common.enabled': '已启用',
  'common.disabled': '已停用',
  'common.yes': '是',
  'common.no': '否',
  'common.paused': '暂停',
  'common.resume': '继续',
  'common.bytesOf': '{done} / {total}',
  'common.copyDone': '已复制',
  'common.showPassword': '显示密码',
  'common.hidePassword': '隐藏密码',
  'common.hotkey': '快捷键',
  'common.more': '更多',
  'common.on': '开',
  'common.off': '关',

  /* ------------------------------------------------------------ relative time */
  'time.justNow': '刚刚',
  'time.secondsAgo': '{n} 秒前',
  'time.minutesAgo': '{n} 分钟前',
  'time.hoursAgo': '{n} 小时前',
  'time.daysAgo': '{n} 天前',
  'time.never': '从未',

  /* ------------------------------------------------------------ modals */
  'modal.confirmTitle': '确认操作',
  'modal.confirmText': '确定要执行这个操作吗？',
  'demo.modalTitle': '删除实例',
  'demo.modalBody': '实例「{name}」的文件会保留在游戏根目录，除非你勾选下面的选项。',
  'demo.modalKeepFiles': '同时删除实例文件',

  /* ------------------------------------------------------------- toasts */
  'toast.regionLabel': '通知',
  'toast.launchOk': '已启动 {name}',
  'toast.jobDone': '下载完成：{title}',
  'toast.copyImage': '已复制图片',
  'toast.demoInfo': '这是一条普通提示',
  'toast.demoSuccess': '操作已完成',
  'toast.demoWarning': '请注意这个情况',
  'toast.demoDanger': '操作失败：{reason}',

  /* -------------------------------------------------------------- demo */
  /* -------------------------------------------------------------- gallery */
  'gallery.title': '组件画廊',
  'gallery.subtitle': '全部 UI 组件、尺寸与状态，只用 design token 上色。',
  'gallery.groupActions': '按钮与输入',
  'gallery.groupSelection': '选择控件',
  'gallery.groupFeedback': '进度与反馈',
  'gallery.groupSurfaces': '容器与数据',
  'gallery.groupIcons': '图标（20 网格 / 描边 1.5 / 16px 实拍）',
  'gallery.density': '密度',
  'gallery.hint': '按 Esc 返回',
  'gallery.controlGroup': '组合示例',
  'gallery.menuOpenDir': '打开目录',
  'gallery.menuCopy': '复制名称',
  'gallery.menuDelete': '删除实例',
  'gallery.pushToast': '推送一条提示',
  'gallery.openModal': '打开对话框',
  'gallery.rangeLow': '低',
  'gallery.rangeHigh': '高',
  'demo.searchHint': '按 Ctrl+F 聚焦',
  'demo.bytes': '{done} · {total}',
  'demo.progressTitle': '下载资产文件',
  'demo.progressSpeed': '{speed} · 剩余 {eta}',
  'demo.instanceFabric': 'Fabric 测试场',
  'demo.instanceBroken': '损坏的旧实例',
  'demo.modName': 'Sodium 渲染优化',
  'demo.serverName': '生存服务器',
  'demo.fieldLabel': '游戏根目录',
  'demo.fieldLabel2': '并发下载数',
  'demo.fieldHint': '所有版本、库文件和资源都会写到这里。',
  'demo.fieldHint2': '网络较差时建议 4 以下。',
  'demo.rowA': '名称',
  'demo.rowB': '版本',
  'demo.rowC': '状态',
  'demo.emptyTitle': '还没有实例',
  'demo.emptyDesc': '创建实例后即可开始游戏。',
  'demo.selectVersion': '游戏版本',
  'demo.selectLoader': '加载器',
  'demo.segmentView': '视图',
  'demo.kbdHint': '按 {keys} 打开画廊'
} as const

export type I18nKey = keyof typeof zh

const en: Record<I18nKey, string> = {
  'app.name': 'MoucX',
  'app.tagline': 'A self-built Minecraft launcher',
  'app.loadingView': 'Loading view',
  'app.viewPending': 'View not ready',
  'app.viewPendingHint': 'This view file has not been created yet; it is picked up automatically.',
  'app.expectedFile': 'Expected file',
  'app.mockBanner': 'Browser preview: built-in mock API',
  'app.mockEmpty': 'Zero-state mode (?empty)',

  'nav.home': 'Launch',
  'nav.instances': 'Instances',
  'nav.versions': 'Versions',
  'nav.mods': 'Mods',
  'nav.accounts': 'Accounts',
  'nav.java': 'Java',
  'nav.online': 'Multiplayer',
  'nav.settings': 'Settings',
  'nav.groupGame': 'Game',
  'nav.groupContent': 'Content',
  'nav.groupEnv': 'Environment',
  'nav.groupSystem': 'System',
  'nav.gallery': 'Components',

  'win.minimize': 'Minimize',
  'win.maximize': 'Maximize',
  'win.restore': 'Restore',
  'win.close': 'Close',
  'win.alwaysOnTop': 'Always on top',

  'status.ready': 'Ready',
  'status.speed': 'Speed',
  'status.eta': 'ETA',
  'status.noJob': 'No downloads',
  'status.jobRunning': 'Downloading',
  'status.jobPaused': 'Paused',
  'status.jobFailed': 'Job failed',
  'status.jobDone': 'Job done',
  'status.gameRunning': '{name} · PID {pid}',
  'status.gameNone': 'Not running',
  'status.versionLabel': 'Version',
  'status.theme': 'Theme',
  'status.themeDark': 'Dark',
  'status.themeLight': 'Light',
  'status.language': 'Language',
  'status.online': 'Online',
  'status.offline': 'Offline',
  'status.updateAvailable': 'Update to {version} available',
  'status.updateLatest': 'Up to date',
  'status.stats': '{instances} instances · {versions} versions',
  'status.openGallery': 'Open component gallery',

  'account.title': 'Accounts',
  'account.addMicrosoft': 'Microsoft sign-in',
  'account.addOffline': 'Offline account',
  'account.type': 'Type',
  'account.type.microsoft': 'Microsoft',
  'account.type.offline': 'Offline',
  'account.type.yggdrasil': 'Yggdrasil',
  'account.type.authlibInjector': 'authlib-injector',
  'account.token.valid': 'Token valid',
  'account.token.needsRefresh': 'Token needs refresh',
  'account.token.invalid': 'Token invalid',
  'account.token.none': 'No token',
  'account.expiresAt': 'Expires {time}',
  'account.selected': 'Active account',
  'account.select': 'Set active',
  'account.skin': 'Skin',
  'account.deviceCode': 'Device code',
  'account.deviceCodeHint': 'Open {url} in a browser and enter the code below.',
  'account.waitForLogin': 'Waiting for you to finish signing in',
  'account.loginFailed': 'Sign-in failed',

  'launch.start': 'Launch',
  'launch.launching': 'Launching',
  'launch.running': 'Game running',
  'launch.stop': 'Stop',
  'launch.currentInstance': 'Active instance',
  'launch.recentPlayed': 'Recently played',
  'launch.quickActions': 'Shortcuts',
  'launch.noInstance': 'No instances yet',
  'launch.noInstanceHint': 'Create one instance, or import a modpack.',
  'launch.createFirst': 'New instance',
  'launch.importModpack': 'Import modpack',
  'launch.checking': 'Pre-launch check',
  'launch.readyToLaunch': 'Ready to launch',
  'launch.blocked': 'Cannot launch',
  'launch.previewArgs': 'Show launch command',

  'instance.new': 'New instance',
  'instance.duplicate': 'Duplicate',
  'instance.rename': 'Rename',
  'instance.openDir': 'Open folder',
  'instance.remove': 'Delete instance',
  'instance.removeConfirm': 'Delete “{name}”?',
  'instance.removeFiles': 'Delete files too',
  'instance.isolated': 'Isolated folder',
  'instance.sharedRoot': 'Shared root',
  'instance.stateOk': 'Complete',
  'instance.stateMissing': '{n} files missing',
  'instance.stateBroken': 'Version broken',
  'instance.loader': 'Loader',
  'instance.gameVersion': 'Game version',
  'instance.memory': 'Memory',
  'instance.lastPlayed': 'Last played',
  'instance.modCount': '{n} mods',
  'instance.namePlaceholder': 'Instance name',
  'instance.sortBy': 'Sort',
  'instance.sort.name': 'By name',
  'instance.sort.recent': 'By last played',
  'instance.sort.created': 'By created date',
  'instance.filter.all': 'All',
  'instance.pin': 'Pin to shortcuts',
  'instance.unpin': 'Unpin',

  'version.refresh': 'Refresh list',
  'version.install': 'Install version',
  'version.installed': 'Installed',
  'version.notInstalled': 'Not installed',
  'version.repair': 'Verify & repair',
  'version.uninstall': 'Uninstall',
  'version.type.release': 'Release',
  'version.type.snapshot': 'Snapshot',
  'version.type.old_beta': 'Old beta',
  'version.type.old_alpha': 'Old alpha',
  'version.latestRelease': 'Latest release',
  'version.latestSnapshot': 'Latest snapshot',
  'version.emptyManifest': 'No versions available — refresh to fetch the manifest.',

  'mod.search': 'Search mods',
  'mod.install': 'Install',
  'mod.installed': 'Installed',
  'mod.update': 'Update available',
  'mod.updateAll': 'Update all',
  'mod.enable': 'Enable',
  'mod.disable': 'Disable',
  'mod.remove': 'Remove mod',
  'mod.localFile': 'Install from file',
  'mod.checkUpdates': 'Check updates',
  'mod.provider': 'Source',
  'mod.downloads': '{n} downloads',
  'mod.requiresVersion': 'Needs {version}',
  'mod.noResult': 'No matching projects',
  'mod.kind.mod': 'Mod',
  'mod.kind.resourcepack': 'Resource pack',
  'mod.kind.shader': 'Shader',
  'mod.kind.modpack': 'Modpack',
  'mod.kind.world': 'World',

  'java.runtimes': 'Detected runtimes',
  'java.scan': 'Scan this machine',
  'java.provision': 'Download Java {major}',
  'java.remove': 'Remove',
  'java.missing': 'Java {major} missing',
  'java.missingHint': 'This version needs Java {major}, which is not installed.',
  'java.broken': 'Not runnable: {reason}',
  'java.mode': 'Strategy',
  'java.mode.auto': 'Auto match',
  'java.mode.mojang': 'Mojang component',
  'java.mode.adoptium': 'Adoptium',
  'java.mode.custom': 'Custom path',
  'java.major': 'Java {major}',
  'java.vendor': 'Vendor',
  'java.arch': 'Architecture',
  'java.path': 'Path',
  'java.inUse': 'Used for launch',

  'online.servers': 'Servers',
  'online.addServer': 'Add server',
  'online.address': 'Address',
  'online.port': 'Port',
  'online.ping': 'Ping',
  'online.join': 'Join server',
  'online.latency': '{n} ms',
  'online.offline': 'Unreachable',
  'online.motd': 'MOTD',
  'online.players': '{online}/{max}',
  'online.lan': 'LAN',
  'online.lanScan': 'Scan LAN',
  'online.lanStop': 'Stop scan',
  'online.lanNone': 'No LAN worlds found',
  'online.relay': 'Cross-network play',
  'online.relayHost': 'Host a room',
  'online.relayJoin': 'Join room',
  'online.relayStop': 'Disconnect',
  'online.relayRoom': 'Room code',
  'online.relayCopyHint': 'Send the room code to a friend so they can join',
  'online.relay.state.idle': 'Not connected',
  'online.relay.state.hosting': 'Hosting',
  'online.relay.state.joining': 'Joining',
  'online.relay.state.connected': 'Connected',
  'online.relay.state.error': 'Connection failed',

  'log.console': 'Log',
  'log.empty': 'No log output yet',
  'crash.title': 'Crash analysis',
  'crash.cause': 'Cause',
  'crash.suggestion': 'Suggestion',
  'crash.evidence': 'Key stack',
  'crash.severity.info': 'Notice',
  'crash.severity.warning': 'Warning',
  'crash.severity.critical': 'Critical',

  'game.pid': 'PID {pid}',
  'game.duration': 'Running {time}',
  'game.kill': 'Kill process',
  'game.killConfirm': 'Force-kill “{name}”? Unsaved progress may be lost.',
  'game.exitCode': 'Exit code {code}',

  'settings.gameRoot': 'Game root',
  'settings.downloads': 'Downloads',
  'settings.concurrent': 'Concurrency',
  'settings.resume': 'Resume partial files',
  'settings.strict': 'Strict mode',
  'settings.mirrors': 'Download sources',
  'settings.appearance': 'Appearance',
  'settings.closeAction': 'Close button',
  'settings.closeAction.minimize': 'Minimize to tray',
  'settings.closeAction.exit': 'Quit launcher',
  'settings.closeAction.ask': 'Ask every time',
  'settings.console': 'Show game console',
  'settings.hideOnLaunch': 'Hide window after launch',
  'settings.jvmArgs': 'JVM arguments',
  'settings.proxy': 'Proxy',
  'settings.relayServer': 'Relay server',
  'settings.saved': 'Settings saved',
  'settings.resetConfirm': 'Restore every default setting?',

  'common.confirm': 'OK',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.dismiss': 'Dismiss',
  'common.retry': 'Retry',
  'common.delete': 'Delete',
  'common.save': 'Save',
  'common.apply': 'Apply',
  'common.reset': 'Reset',
  'common.add': 'Add',
  'common.create': 'Create',
  'common.edit': 'Edit',
  'common.open': 'Open',
  'common.import': 'Import',
  'common.export': 'Export',
  'common.refresh': 'Refresh',
  'common.copy': 'Copy',
  'common.searchPlaceholder': 'Search…',
  'common.clear': 'Clear',
  'common.loading': 'Loading',
  'common.empty': 'Nothing here',
  'common.emptyHint': 'This list is empty.',
  'common.noMatch': 'No match',
  'common.none': 'None',
  'common.unknown': 'Unknown',
  'common.optional': 'Optional',
  'common.name': 'Name',
  'common.status': 'Status',
  'common.action': 'Actions',
  'common.size': 'Size',
  'common.time': 'Time',
  'common.version': 'Version',
  'common.total': '{n} items',
  'common.selectAll': 'Select all',
  'common.sort': 'Sort',
  'common.filter': 'Filter',
  'common.details': 'Details',
  'common.browse': 'Browse…',
  'common.back': 'Back',
  'common.next': 'Continue',
  'common.selectPlaceholder': 'Select…',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.paused': 'Pause',
  'common.resume': 'Resume',
  'common.bytesOf': '{done} / {total}',
  'common.copyDone': 'Copied',
  'common.showPassword': 'Show password',
  'common.hidePassword': 'Hide password',
  'common.hotkey': 'Shortcut',
  'common.more': 'More',
  'common.on': 'On',
  'common.off': 'Off',

  'time.justNow': 'just now',
  'time.secondsAgo': '{n}s ago',
  'time.minutesAgo': '{n} min ago',
  'time.hoursAgo': '{n} h ago',
  'time.daysAgo': '{n} d ago',
  'time.never': 'never',

  'modal.confirmTitle': 'Confirm',
  'modal.confirmText': 'Do you want to proceed?',
  'demo.modalTitle': 'Delete instance',
  'demo.modalBody': 'Files of “{name}” stay in the game root unless you tick the option below.',
  'demo.modalKeepFiles': 'Delete the instance files too',

  'toast.launchOk': 'Launched {name}',
  'toast.jobDone': 'Download finished: {title}',
  'toast.copyImage': 'Image copied',
  'toast.demoInfo': 'This is a plain notice',
  'toast.demoSuccess': 'Done',
  'toast.demoWarning': 'Heads up',
  'toast.demoDanger': 'Failed: {reason}',

  'toast.regionLabel': 'Notifications',
  'gallery.title': 'Component gallery',
  'gallery.subtitle': 'Every UI primitive, size and state — coloured only by design tokens.',
  'gallery.groupActions': 'Buttons & input',
  'gallery.groupSelection': 'Selection',
  'gallery.groupFeedback': 'Progress & feedback',
  'gallery.groupSurfaces': 'Surfaces & data',
  'gallery.groupIcons': 'Icons (20 grid / 1.5 stroke / shot at 16px)',
  'gallery.density': 'Density',
  'gallery.hint': 'Esc to go back',
  'gallery.controlGroup': 'Composed example',
  'gallery.menuOpenDir': 'Open folder',
  'gallery.menuCopy': 'Copy name',
  'gallery.menuDelete': 'Delete instance',
  'gallery.pushToast': 'Push a toast',
  'gallery.openModal': 'Open dialog',
  'gallery.rangeLow': 'Low',
  'gallery.rangeHigh': 'High',
  'demo.searchHint': 'Ctrl+F to focus',
  'demo.bytes': '{done} · {total}',
  'demo.progressTitle': 'Downloading assets',
  'demo.progressSpeed': '{speed} · {eta} left',
  'demo.instanceFabric': 'Fabric playground',
  'demo.instanceBroken': 'Broken legacy instance',
  'demo.modName': 'Sodium rendering',
  'demo.serverName': 'Survival server',
  'demo.fieldLabel': 'Game root',
  'demo.fieldLabel2': 'Parallel downloads',
  'demo.fieldHint': 'All versions, libraries and assets are written here.',
  'demo.fieldHint2': 'Stay below 4 on a slow connection.',
  'demo.rowA': 'Name',
  'demo.rowB': 'Version',
  'demo.rowC': 'Status',
  'demo.emptyTitle': 'No instances yet',
  'demo.emptyDesc': 'Create an instance to start playing.',
  'demo.selectVersion': 'Game version',
  'demo.selectLoader': 'Loader',
  'demo.segmentView': 'View',
  'demo.kbdHint': 'Press {keys} to open the gallery'
}

/* --------------------------------------------------------------------- state */

const STORAGE_KEY = 'mouc.locale'
const listeners = new Set<(locale: Language) => void>()

function readStoredLocale(): Language {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'en-US' || raw === 'zh-CN') return raw
  } catch {
    /* storage can be unavailable; the default keeps the app alive */
  }
  return 'zh-CN'
}

const locale = ref<Language>(readStoredLocale())

const dictionaries: Record<Language, Record<I18nKey, string>> = {
  'zh-CN': zh,
  'en-US': en
}

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' }
]

export type I18nVars = Record<string, string | number>

/** Interpolates `{name}` placeholders. Missing vars stay visible for debugging. */
function interpolate(template: string, vars?: I18nVars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  )
}

export function t(key: I18nKey, vars?: I18nVars): string {
  const table = dictionaries[locale.value]
  return interpolate(table[key] ?? key, vars)
}

/** Used by theme/i18n bridges so settings writes can flow back in. */
export function onLocaleChange(listener: (locale: Language) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setLocale(next: Language): void {
  if (next === locale.value) return
  locale.value = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener(next)
}

export function currentLocale(): Language {
  return locale.value
}

const isChinese = computed(() => locale.value === 'zh-CN')

export interface I18n {
  /** Reading it inside a template makes every `t()` call locale-reactive. */
  locale: Ref<Language>
  t: typeof t
  setLocale: typeof setLocale
  languages: typeof LANGUAGES
  isChinese: ComputedRef<boolean>
}

export function useI18n(): I18n {
  return { locale, t, setLocale, languages: LANGUAGES, isChinese }
}

/* ---------------------------------------------------------------------- */
/* Feature dictionaries                                                    */
/* ---------------------------------------------------------------------- */

export interface FeatureDict<K extends string> {
  /** Locale-reactive lookup — call it inside a template or a computed. */
  text(key: K, vars?: I18nVars): string
  keys: readonly K[]
}

/**
 * Views own their copy. Declaring `[zh, en]` tuples together means a missing
 * translation is a compile error, without every view editing this file.
 */
export function defineDict<T extends Readonly<Record<string, readonly [string, string]>>>(
  source: T
): FeatureDict<keyof T & string> {
  const keys = Object.keys(source) as (keyof T & string)[]
  return {
    text(key, vars) {
      const pair = source[key]
      return interpolate(currentLocale() === 'zh-CN' ? pair[0] : pair[1], vars)
    },
    keys
  }
}
