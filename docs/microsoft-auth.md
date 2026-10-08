# Microsoft 正版登录流程（account/microsoft.ts）

本文档说明 MoucX 的 Microsoft 登录链路、哪些部分已验证、哪些未验证，
以及如何创建自己的 Azure 应用（launcher 不内置任何客户端 ID）。

## 创建 Azure 应用

1. 打开 <https://portal.azure.com> → Microsoft Entra ID → 应用注册。
2. 名称随意；受支持的账户类型选 “个人 Microsoft 账户和任何组织目录中的账户”。
3. 重定向 URI 不需要（我们使用设备码流 Device Code Flow）。
4. 创建后在 “API 权限” 添加 delegated 权限 `XboxLive.signin`、`offline_access`
   （`allowPublicClient = true`，公共客户端无法保存密钥）。
5. 把 “应用程序(客户端) ID” 填入启动器 设置 → 账户（`settings.microsoftClientId`）。
   设备码流使用公共客户端，没有 client_secret，因此把 ID 放在本地是安全的。

## 每一跳的说明（按顺序）

| # | 端点（constants.ts） | 作用 | 请求要点 |
|---|---|---|---|
| 1 | `ENDPOINTS.msDeviceCode` | 申请设备码 | form: `client_id` + `scope = XboxLive.signin offline_access`（`MS_FLOW.scope`） |
| 2 | `ENDPOINTS.msToken`（轮询） | 等用户授权后换 MS token | form: `grant_type=urn:ietf:params:oauth:grant-type:device_code` + `device_code`；错误在 4xx 的 JSON body 里：`authorization_pending`、`slow_down`（间隔 +5s）、`expired_token`、`access_denied` |
| 3 | `ENDPOINTS.msToken`（刷新） | `refresh()` 重跑链路 | form: `grant_type=refresh_token` + `refresh_token` |
| 4 | `ENDPOINTS.xboxUserAuth` | MS token → XBL token | JSON: `{RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT", Properties: {AuthMethod: "RPOP", UserToken: <ms access token>, SandboxId: "RETAIL"}}`；响应含 `Token`、`DisplayClaims.Uhs[0]`（userhash） |
| 5 | `ENDPOINTS.xboxXsts` | XBL → XSTS 安全令牌 | 同上，`UserToken` 换成 XBL token；`XErr` 非空即失败（如 2148916233 = 无 Xbox 档案） |
| 6 | `ENDPOINTS.minecraftLoginWithXbox` | XSTS → Minecraft 令牌 | JSON: `{identity: "XBL3.0 x=<userhash>;<xsts token>"}` |
| 7 | `ENDPOINTS.minecraftProfile` | 取 `{id, name, skins}` | header `Authorization: Bearer <mc token>`；皮肤 URL 保留在 `Account.skinUrl` |
| 8 | `ENDPOINTS.minecraftEntitlements` | 检测是否购买了 Java 版 | 未购买 Java 版只作为 `MicrosoftLoginProgress` 的警告文案，不判失败 |

## 已验证 vs 未验证

已验证（2026-10-07，本机网络探测，见 docs/endpoints.md 同款方法）：

- 上表全部 URL 可达并且会返回结构化 JSON 错误（401/400/bad-request），说明端点活着。
- `login.microsoftonline.com` 的两个 form 端点 POST-only、支持设备码错误码语义。
- Minecraft 档案/entitlements 响应字段名（`id/name/skins/capes/items`）。

**未验证**（无法在没有真实 Azure 客户端 ID、真实 Xbox 账户的情况下端到端跑通）：

- `MS_FLOW` 中的 XBL/XSTS 常量：`xboxRelyingParty`、`xstsRelyingParty`（均为
  `http://auth.xboxlive.com`）、`tokenType: "JWT"`、`authMethod: "RPOP"`、`sandbox: "RETAIL"`。
  这些值取自社区通行做法（PCL/HMCL 类流程的公开文档），但本项目从未用真实账户走完
  整条链路。它们全部集中在 `src/main/account/microsoft.ts` 导出的 `MS_FLOW` 常量里，
  真机验证失败时只需改这一处。
- `XBL3.0 x=<uhs>;<token>` 身份串的确切格式（同上，仅集中在 `completeWithProfile`）。
- MC 访问令牌 24h 有效期（`MS_FLOW.mcTokenLifetimeMs`）是观测经验值，非官方承诺。
- entitlements 判定 Java 版归属的条件（`skuName` 含 “java” / `skuId` / `isBaseGame`）。
- 皮肤：`skins[].url` 指向需要鉴权的 api.minecraftservices.com，本实现把 URL 末段的
  纹理 hash 换成公共的 `ENDPOINTS.skinBlobServer`（textures.minecraft.net）下载；
  该替换未端到端验证。

## 其它行为约定

- 会话可取消：`microsoftCancel(sessionKey)` 会 abort 正在等待的轮询；会话按
  `expires_in` 过期后 `poll` 直接返回 `failed`。
- 轮询间隔遵守服务端返回的 `interval`；收到 `slow_down` 时按 OAuth 规范 +5s。
- 每个阶段（waiting-user → microsoft-ok → xbox-ok → live-ok → minecraft-ok →
  profile-ok → done/failed）都会通过注入的 `onStage` 回调推送，并由
  `AccountService` 转发成 `EVENTS.microsoft`。
- 令牌落盘见 `src/main/account/store.ts` + `electronCipher.ts`：refresh/access token
  仅以 Electron safeStorage 密文形式写入 `<configDir>/accounts.json`，绝无明文。
