# 第三方声明 / Third-party notices

MoucX 的原始贡献使用 MIT 许可（见 `LICENSE`）。下列第三方代码保留其各自的许可证，
版权归其原作者所有。

## KAMUCL — MIT（界面层源码）

上游仓库：<https://github.com/kamubaba-i/KAMUCL>，版权 (c) 2026 kamubaba-i。

**上游完整渲染层源码已随本仓库分发**在 [`vendor/KAMUCL/`](vendor/KAMUCL/)（372 个 `.vue`/`.ts`/`.css`
文件，含上游 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 原文），许可证文本在 [`licenses/`](licenses/)。
`src/renderer/src/kamu/` 是从这份源码移植过来的部分，已接入 MoucX 自己的数据层。

本项目使用的移植位置与范围：

| 本项目路径 | 来源 | 说明 |
| --- | --- | --- |
| `src/renderer/src/kamu/styles/kamu.css` | `src/renderer/src/styles.css` | 全局组件基线样式 + 六套主题色板，原样保留 |
| `src/renderer/src/kamu/styles/ui-system.css` | `src/renderer/src/ui-system.css` | 统一设计令牌与控件尺寸 |
| `src/renderer/src/kamu/views/*.vue` | `src/renderer/src/views/*.vue` | 按视图移植，文件头标注对应上游文件 |
| `src/renderer/src/kamu/components/*.vue` | `src/renderer/src/components/*.vue` | 按组件移植，文件头标注对应上游文件 |
| `src/renderer/src/kamu/api/*.ts` | `src/renderer/src/api.ts` | 上游是扁平函数式 IPC 封装；这里改写成调用 MoucX 自己的 `window.mouc`，只有调用形状与错误语义保持一致 |

移植时对数据层做了必要改写：MoucX 的主进程服务、下载引擎、账户实现、模组加载器安装、
NBT/服务器 ping/中继协议等均为本项目独立实现，未使用 KAMUCL 的主进程代码。

完整许可证文本：[`licenses/KAMUCL-MIT.txt`](licenses/KAMUCL-MIT.txt)。

### 随仓库分发但本项目代码未使用的部分

上游 `src/renderer/src/vendor/skinview3d/**`（第三方 skinview3d，MIT，见 `licenses/skinview3d.txt`、
`licenses/three.txt`）与上游 `src/main/core/voxlink/**`（LGPL-3.0-only，见 `licenses/LGPL-3.0.txt`、
`licenses/GPL-3.0.txt`）都只在 `vendor/KAMUCL/` 里作为上游源码存档存在，
`src/` 下没有任何文件包含或链接它们的代码。若将来启用，需要按 LGPL-3.0 提供可修改的
对应源码与许可证副本——本仓库已经分发源码，届时补齐声明即可。

上游的吉祥物、开屏脸、方块生物等美术素材未引入 `src/`：MoucX 使用自己的品牌
（母图 `brand/moucx-logo.png`，各尺寸图标由 `scripts/gen-icons.mjs` 以矢量重绘后逐个原生
栅格化），混用上游美术会让产品看起来像另一个启动器。

## Mojang / Microsoft 接口

启动器从 Mojang 官方公开端点下载游戏文件，正版验证走微软官方 OAuth 接口。
Minecraft 是 Mojang / Microsoft 的商标，本项目与官方无关，也不随附任何 Mojang 的 jar。
实测端点记录见 [`docs/endpoints.md`](docs/endpoints.md)。

## 字体与图标

界面图标为上游 KAMUCL 的内联 SVG 符号与本项目自绘图标；不使用任何图标字体或 emoji。
