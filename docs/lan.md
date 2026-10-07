# 局域网世界发现

Java 版 Minecraft 在"对局域网开放"后会周期性发 UDP 组播，启动器监听它并把世界列进服务器列表。

## 已确认的部分

| 事实 | 来源 |
| --- | --- |
| 组播地址与端口：`224.0.2.60:4445` | FabricMC/yarn 对 `net/minecraft/client/network/LanServerPinger` 的映射注释："These multicasts will always be sent to `{@code 224.0.2.60:4445}`"（<https://github.com/FabricMC/yarn/blob/1.21.11/mappings/net/minecraft/client/network/LanServerPinger.mapping>） |
| 同一地址端口 | MinecraftForge 对 `LanServerDetection.java` 的补丁：`new MulticastSocket(4445)`、`InetAddress.getByName("224.0.2.60")`、`joinGroup`（<https://github.com/MinecraftForge/MinecraftForge/blob/26.3/patches/minecraft/net/minecraft/client/server/LanServerDetection.java.patch>） |
| 报文文本格式 `[MOTD]<motd>[/MOTD][AD]<port>[/AD]`，UTF-8，每 1.5s 一次；MOTD 内的 `[` `]` 转义成 `(` `)` | 同上 yarn 注释里的 `createAnnouncement` 示例，以及 ObsidianMC 的 `LanBroadcasterService.cs`（<https://github.com/ObsidianMC/Obsidian/blob/1.21.x/Obsidian/Services/LanBroadcasterService.cs>） |
| 加入地址 = UDP 报文的**源地址** + 报文里的端口 | Forge 补丁同上；源地址必须是实际发包地址，否则多网卡/NAT 机器会连不上 |
| 组播端口 4445 与报文里的游戏端口是两个不同的值 | Arch Linux "Minecraft" 词条："UDP port 4445 to broadcast your game" |

实现：`src/main/online/lanScanner.ts`。常量 `LAN_MULTICAST_GROUP` / `LAN_MULTICAST_PORT` 就来自上表。

> 注意：`49550` 是**基岩版**的局域网端口，别和这个混。`src/shared/constants.ts` 里的
> `mcLanPort` 已改成 4445。

## 未确认、按宽容回退处理的部分

- 空格分隔的老式文本 `[MOTD:…] [ip:…] [port:…] [gamemode:…]`：没能找到一手来源，
  解析器把它当**回退格式**尝试，解析不出来就忽略该报文。
- 纯 NBT 形式的公告包：同上，用 `src/main/online/nbt.ts` 尽力解析，失败即忽略。
- IPv6 组播（`ff02::1` 一类）：未实现，只走 IPv4 组播 + 广播。

## 行为细节

- 加入组播组时对每个可用网卡都 `addMembership`，否则多网卡机器只有一张能收到。
- 同一世界的判定：`源地址 + 端口`。重复报文只刷新 `seenAt`。
- 60s 没再出现就过期，列表里的行会消失。
- 停止扫描时显式 `dropMembership` 并 `close()`，避免端口泄漏。
