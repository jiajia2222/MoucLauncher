# 端点可用性记录

所有网络端点在 **2026-10-07** 从国内网络（带代理）用 `curl` 实测过。代码里出现的 URL 只有这一份来源：
`src/shared/constants.ts`。改端点就改那个文件，然后跑 `npm test`。

## Mojang 官方

| 端点 | 状态 | 备注 |
| --- | --- | --- |
| `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json` | 200 | 918 个版本，`latest.release = 26.3`，`latest.snapshot = 26.4-snapshot-3` |
| `https://piston-meta.mojang.com/v1/packages/<sha>/26.3.json` | 200 | 版本 JSON；见下方字段实测 |
| `https://piston-data.mojang.com/v1/objects/<sha>/client.jar` | 200 | 客户端 jar（41,918,883 字节 @26.3） |
| `https://libraries.minecraft.net/...` | 200 | 库 jar |
| `https://resources.download.minecraft.net/<2>/<rest>` | 主机可达 | 资源对象，路径来自 asset index 的 sha1 |
| `https://launchermeta.mojang.com/v1/products/java-runtime/<hash>/all.json` | **404** | `BlobNotFound`。社区启动器里流传的那个 hash 已经失效 |
| `https://piston-meta.mojang.com/v1/products/java-runtime-epsilon/all.json` | **404** | 用 `javaVersion.component` 拼的几种路径全部 404 |
| 同上 `.../manifest.json`、`/mc/game/java-runtime-epsilon.json` | **404** | 同上 |

**结论**：Mojang 的 Java 运行时元数据当前无法通过任何已知公开路径发现，所以 MoucX 用
Adoptium 供给 Java，`javaVersion.component` 只用于展示，不用于下载。

### 26.3 版本 JSON 实测字段

```
顶层: arguments, assetIndex, assets, complianceLevel, downloads, id, javaVersion,
      libraries, logging, mainClass, minimumLauncherVersion, releaseTime, time, type
javaVersion: {"component":"java-runtime-epsilon","majorVersion":25}
assetIndex:  {"id":"36","sha1":"8b18bfed…","size":606244,"totalSize":475778007}
downloads.client: {"sha1":"96611d3c…","size":41918883,"url":"…/objects/…/client.jar"}
logging.client.argument: -Dlog4j.configurationFile=${path}
```
新版只有 `arguments`，没有旧的 `minecraftArguments`；1.5 及更老版本才需要旧字段回退。

## 中国镜像（BMCLAPI / OpenBMCLAPI）

| 端点 | 状态 |
| --- | --- |
| `https://bmclapi2.bangbang93.com/` | 302 → `https://bmclapidoc.bangbang93.com` |
| `https://bmclapi2.bangbang93.com/minecraft/manifest/minecraft` | **404** |
| `.../manifest/minecraft`、`.../bmc/version.json`、`.../minecraft/version_manifest_v2.json` | **404** |
| `.../v2/minecraft/manifest/minecraft`、`.../version/manifest`、`.../minecraft/v1/packages/<sha>/client.jar` | **404** |
| `.../fabric-meta/v2/versions/loader/1.20.4` | 请求失败（未拿到响应） |
| `https://openbmclapi.bangbang93.com/mirrors/` | **404** |

**结论**：BMCLAPI 的公网 API 现在没有一个可用路由，所以 MoucX **不内置任何公共镜像**。
下载源被实现成数据驱动的 `MirrorRule`（官方 host → 镜像 host 的改写表），用户在
`设置 → 下载源` 里填自己的镜像即可，代码不需要改。`src/main/download/mirror.ts` 的改写规则
针对 BMCLAPI 风格的路径布局（`libraries` 走 `/maven` 前缀，其余同路径）。

## Mod Loader / 模组仓库

| 端点 | 状态 |
| --- | --- |
| `https://meta.fabricmc.net/v2/versions/loader/1.20.4` | 200 |
| `https://meta.quiltmc.org/v3/versions/loader/1.20.4` | 200 |
| `https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml` | 200 |
| `https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml` | 200 |
| `https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json` | 200 |
| `https://api.modrinth.com/v2/search?query=fabric&limit=1` | 200 |
| `https://api.curseforge.com/v1/mods/search?gameId=432` | **403**（必须 `x-access-token`） |
| `https://mirrors.huaweicloud.com/repository/maven/net/minecraftforge/forge/maven-metadata.xml` | **404** |

CurseForge 的 key 需要用户自己在设置里填；没填时相关功能直接返回"未配置"，不会静默失败。

## Java 供给（Adoptium）

| 端点 | 状态 |
| --- | --- |
| `https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse` | 200，`jdk-25.0.4.1+1` |
| 同上 major = 21 | 200，`jdk-21.0.12.1+1` |
| 同上 major = 17 | 200，`jdk-17.0.20.1+1` |
| 同上 major = 8 | 200，`jdk8u504-b01` |

## 微软正版登录

| 端点 | 状态 |
| --- | --- |
| `https://login.microsoftonline.com/consumers/oauth2/v2.0/token` | 200（GET 返回错误页，主机可达） |
| `https://user.auth.xboxlive.com/user/authenticate` | 405（只接受 POST，主机可达） |
| `https://api.minecraftservices.com/minecraft/profile/lookup/binder/by/minecraft/<name>` | 404（需要 bearer） |

设备码流需要用户自己的 Azure 应用 `client_id`（设置里填）。Xbox / Minecraft Services 各跳的
请求体字段无法在没有 client_id 的情况下端到端验证，见 `docs/microsoft-auth.md`。

## authlib-injector

`https://authlib-injector.yushi.moe/artifact/latest.json` → 200。
