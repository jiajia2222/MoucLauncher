# MoucLauncher

一个 Windows 上的 Minecraft（Java 版）启动器。Electron 44 + Vue 3 + TypeScript，
发布形态有三种：**安装包**、**免安装单文件**、**快捷包 zip**。

> 分工说清楚，不含糊。**数据层与协议全部自研**：下载引擎（含 HTTP CONNECT 代理隧道）、
> 版本清单与继承解析、natives 解压、启动参数拼装、Java 扫描与 Adoptium 供给、离线/微软账户、
> Fabric/Quilt/Forge/NeoForge 安装、Modrinth/CurseForge 对接、NBT 与服务端状态 ping、
> 局域网发现、联机中继协议与可自托管服务端——都是本仓库自己写的（443 个单元测试）。
>
> **界面层以 [KAMUCL](https://github.com/kamubaba-i/KAMUCL) 的源码为基础移植**（MIT，已署名）。
> 上游完整渲染层源码随仓库分发在 `vendor/KAMUCL/`，许可证文本在 `licenses/`，
> 移植范围与边界写在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
> 品牌是本项目的：名称、代码绘制的图标（`scripts/gen-icons.mjs`）、安装包与快捷包。

CI 与发布产物：

![CI](https://github.com/jiajia2222/MoucLauncher/actions/workflows/ci.yml/badge.svg)
![Release](https://img.shields.io/github/v/release/jiajia2222/MoucLauncher)
![License](https://img.shields.io/badge/license-MIT-green)

---

## 下载

到 [Releases](https://github.com/jiajia2222/MoucLauncher/releases) 页面，三选一：

| 文件 | 形态 | 适合谁 |
| --- | --- | --- |
| `MoucLauncher-<版本>-Setup-x64.exe` | NSIS 安装包 | 想要桌面/开始菜单快捷方式、正常卸载流程 |
| `MoucLauncher-<版本>-portable-x64.exe` | 免安装单文件 | 只想双击就用，不想装东西 |
| `MoucLauncher-<版本>-windows-x64.zip` | 快捷包（解压即用） | U 盘、多版本并存、绿色软件习惯 |

三种产物里跑的是同一个程序，游戏数据默认都写在
`文档/MoucLauncher/`（可在设置里改），配置和令牌写在
`%APPDATA%/mouc-launcher/`。

校验：每个 release 都带 `SHA256SUMS.txt`。

```powershell
Get-FileHash .\MoucLauncher-*-Setup-x64.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

**SmartScreen**：本项目没有代码签名证书，第一次运行会弹"Windows 已保护你的电脑 →
更多信息 → 仍要运行"。这是预期行为，不是恶意软件——所以上面的 SHA256 校验请真的去做。

---

## 为什么不直接改一个现成的

| 项目 | 许可证 | 对"拿来做自研产品"的限制 |
| --- | --- | --- |
| PCL-CE | 根目录 Apache-2.0，但 `Plain Craft Launcher 2/` 是自定义《PCL 分发有限许可》 | 派生名称必须以 "Plain Craft Launcher" 开头、界面主色必须保持蓝色、关于页署名顺序固定 |
| HMCL | GPL-3.0 + §7 附加条款 | 修改版**必须改名改版本号**，且整体传染性 copyleft |
| KAMUCL | MIT，但声明"仅覆盖自研部分" | 其仓库自己记录了曾未经授权使用上游代码并被迫重写的过程 |

所以本项目的取舍是：**界面用 KAMUCL 的**（它自己的 MIT 声明覆盖其原创渲染层，源码与许可证全文
已随 `vendor/KAMUCL/` + `licenses/` 分发，署名见 `THIRD_PARTY_NOTICES.md`；它上游那部分以
LGPL-3.0 发布的 VoxLink 协议代码与第三方 skinview3d 只作为源码存档存在，`src/` 里没有引用）。
**PCL 的界面不能搬**——它的自定义许可不是"补个许可证文本"就能合规的，硬性要求派生名称以
"Plain Craft Launcher" 开头，那就不能叫 MoucLauncher。**HMCL** 是 GPL-3.0 加 §7 改名条款，同理不搬。

从这三家能拿的是**知识**：版本清单长什么样、加载器元数据接口在哪、Modrinth 怎么搜、
NBT 与服务端状态协议怎么读——这些是公开事实，本项目的每一个端点都实测过并记在
[`docs/endpoints.md`](docs/endpoints.md)。

---

## 功能

### 版本与实例
- 官方版本清单（含快照/旧版_beta/alpha 过滤），6 小时本地缓存
- 版本隔离实例：每个实例自己的 `instances/<id>/`，共享 `versions/` 与 `libraries/`
- 版本继承合并（`inheritsFrom`）、`rules` 判定、新旧两种参数格式
- 整合包导入：Modrinth `.mrpack`、Curse 压缩包、MultiMC 目录包；导出 mrpack / zip
- 复制实例、删除（可选连带文件）、打开目录、重命名、图标、备注

### 下载
- 并发下载、断点续传（`Range`）、指数退避重试、SHA1 全文件校验、失败项单独重试
- 下载源是**数据驱动**的 host 改写表：`设置 → 下载源` 填任意 BMCLAPI 风格镜像地址
- 全局进度事件（速度/ETA/字节数），任务列表可取消

### Java
- 扫描系统 Java（`JAVA_HOME`、`PATH`、常见安装目录），解析 `java -version`
- 缺失时按版本要求自动从 Adoptium 下载对应 major 的 JRE 并解压
- 每实例可固定 Java，也可全局自定义路径

### 账户
- 离线账户（UUID 用 Java `nameUUIDFromBytes("OfflinePlayer:"+name)` 算法，与服务端一致）
- Microsoft 正版登录：设备码流程 → Xbox Live → Minecraft Services，含刷新令牌
- 令牌走系统级加密存储（Chromium `safeStorage` / Windows DPAPI）
- 皮肤查看

### Mod 与资源
- Fabric / Legacy Fabric / Quilt / Forge / NeoForge 自动安装（含 Forge processors 执行）
- Modrinth 搜索/浏览/安装/更新检查，依赖自动补齐
- CurseForge 支持（需要自己的 API key）
- 已装 Mod 列表：解析 `fabric.mod.json` / `quilt.mod.json` / `mods.toml` / `mcmod.info`
- 启用/禁用（重命名约定）、删除、本地 jar 安装
- 模组 / 资源包 / 光影 / 整合包分类下载

### 联机
- 服务器列表读写 `servers.dat`（NBT，保留未知字段）
- 真实协议的状态 ping：延迟、MOTD、人数、图标
- 局域网世界发现（UDP 组播/广播包解析）
- 启动直接进服（`--quickPlayMultiplayer` / `--server`）
- 跨网房间：内置中继客户端 + 可自托管的 `relay-server/`（见 docs/relay-protocol.md）

### 界面
- 布局与主题层移植自 KAMUCL（MIT，署名见 `THIRD_PARTY_NOTICES.md`）：侧栏分组导航、
  顶部拖拽条 + 下载中心/通知/导入、开始页大卡片 + 渐变启动按钮、运行环境/内存/状态三块磁贴
- 六套配色（`transparent` 深灰玻璃、`blue-white`、`black-orange`、`white-pink`、`black-pink`、
  `custom`），状态栏的主题开关与设置页同步；tone（dark/light）写回 `settings.theme`
- 中英双语文案；Alt+1…8 切视图；`#view=<id>` 直接定位（QA 与截图用）
- 品牌是自己的：名称、代码绘制的图标（`scripts/gen-icons.mjs`，强调色跟 UI 走 `#9475ed`）

### 诊断与体验
- 崩溃日志规则化分析（Java 版本、内存、Mod 冲突/缺依赖、Mixin、LWJGL/显卡、natives、资源损坏…）
- 游戏日志窗口 + 落盘
- 启动参数预览（复制完整命令行）
- 无边框窗口，关闭行为可选最小化到后台（托盘）/退出/询问

---

## 已知限制

写在这里而不是藏在 issue 里：

- **没有代码签名**。个人项目，签名证书需要组织身份与年度费用。
- **不内置公共下载镜像**。实测 2026-10-07，`bmclapi2.bangbang93.com` 的公开 API 路由全部 404，
  `openbmclapi.bangbang93.com/mirrors/` 也 404。所以镜像改写成可配置项，官方源为默认。
  细节与实测记录：[docs/endpoints.md](docs/endpoints.md)。
- **Java 不从 Mojang 下载**。`launchermeta.mojang.com/v1/products/java-runtime/...` 的
  已知路径全部返回 `BlobNotFound`，改用 Adoptium Temurin。
- **正版登录需要自己的 Azure 应用 `client_id`**。启动器不能内置别人的客户端密钥。
  创建步骤与未验证环节：[docs/microsoft-auth.md](docs/microsoft-auth.md)。
- **跨网联机需要自己跑中继**。`relay-server/` 是一个独立的 Node 包，`docker run` 即可；
  没有公共中继，未配置时功能显示为"未启用"而不是卡住。
- **CurseForge 需要 API key**（官方要求，无 key 时返回 403）。
- **离线账户的皮肤注入没有做**：微软账户的皮肤可以读取展示，离线皮肤只能放到
  `<游戏目录>/skins/<名字>.png` 由启动器读出来，没有向客户端注入的可靠机制，不做假把式。
- 只支持 Windows x64。macOS/Linux 不在 v1 范围内。
- 界面是**逐视图**从上游移植的，进度以 `src/renderer/src/kamu/views/` 为准；
  仍有个别视图挂在旧实现上（功能完整、外观尚未统一），会在后续版本替换。

---

## 开发

需要 Node.js 24（`engines` 里对齐 electron-vite 5 的要求）与 npm。

```bash
npm ci            # 安装（国内镜像已在 .npmrc 配好）
npm run dev       # Electron 开发模式，热更新
npm run dev:web   # 只在浏览器里跑界面（用内置 mock API，做 UI 时用这个）
npm run typecheck # tsc + vue-tsc
npm test          # vitest，全部离线（本地 fixture 服务器，不碰真实网络）
npm run build     # 打包 out/
npm run smoke     # 真的启动一次 Electron，自检 preload/渲染/服务后退出
npm run dist      # 图标 → bundle → electron-builder → 产物校验 + SHA256SUMS
```

### 目录

```
src/shared/     类型、IPC 契约、常量（唯一 URL 来源）、纯函数工具
src/main/       主进程服务，每个能力一个目录
  core/         容器契约、路径、配置、实例注册表、日志、ZIP、fs、事件总线
  download/     HTTP 传输（含 CONNECT 代理隧道）+ 下载调度
  minecraft/    版本清单/继承/安装/natives/参数拼装/进程启动
  java/         扫描 + Adoptium 供给
  account/      离线 / Microsoft / 加密存储 / 皮肤
  loader/       Fabric / Quilt / Legacy Fabric / Forge / NeoForge
  mods/         Modrinth / CurseForge / 本地 jar 元数据
  online/       NBT / servers.dat / 状态 ping / 局域网 / 中继客户端
  crash/        崩溃规则库
  modpack/      mrpack / curse / multimc 导入导出
src/preload/    contextBridge，按 IPC 表自动生成 window.mouc
src/renderer/   Vue 3：styles(设计令牌) / components(自绘组件与图标) / views / stores / mock
relay-server/   独立 Node 包，自托管联机中继
scripts/        图标生成、打包、产物校验、启动自检
tests/          vitest 用例 + 离线 fixture
docs/           端点实测、认证流程、中继协议、局域网格式
```

### 架构约束

- 渲染进程只能用 `window.mouc`，方法集合就是 `src/shared/ipc.ts` 里的 `MoucApi`；
  preload 按同一张表自动生成，主进程按同一张表注册 handler，三处不会漂移。
- 每个 IPC 调用返回 `Result<T>`（`{ok,data} | {ok,error}`），错误带 `code`，
  渲染进程不需要 try/catch 也不会因为一个失败调用崩掉。
- 主进程服务之间**不互相 import 实现**，只依赖 `src/main/core/contracts.ts` 里的接口，
  由 `container.ts` 注入。所以每个能力目录都能单独测试、单独替换。
- 网络地址只有 `src/shared/constants.ts` 一个来源，且每个都记录了实测状态码。

### 测试策略

单元测试全部离线：HTTP 用本地 `node:http` fixture 服务器或注入的假 `HttpClient`，
进程启动注入假 `spawn`，NBT/ZIP/协议编解码用合成字节。真实端点的响应形状是**人工用 curl
抓一次**存进 `tests/fixtures/` 再断言的，不在测试里联网。

---

## 致谢与免责

- 参考了 [PCL-CE](https://github.com/PCL-Community/PCL-CE)、[HMCL](https://github.com/HMCL-dev/HMCL)、
  [KAMUCL](https://github.com/kamubaba-i/KAMUCL) 的功能范围（仅功能，不含代码）。
- Minecraft 是 Mojang / Microsoft 的商标，本项目与官方无关，不提供游戏文件，
  正版验证走微软官方接口。
- 许可证：MIT。
