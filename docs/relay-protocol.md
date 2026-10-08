# 跨网联机中继协议 `moucx-relay` v1

用途：让不在同一个局域网的两台机器玩同一个世界。房主在局域网开放世界后，
用启动器把本地端口挂到中继房间；加入者的启动器在本地开一个端口，游戏里直接连
`localhost`，字节经中继转发。

实现分三处，互不重复：

| 位置 | 角色 |
| --- | --- |
| `src/main/online/relay/framing.ts` | 纯编解码（无 IO、无 Electron），有单元测试 |
| `src/main/online/relay/client.ts` | 启动器一侧的客户端（房主 / 加入者两种角色） |
| `relay-server/index.js` | 可自托管的服务端 |

传输是 WebSocket（一条连接同时承载控制与数据）。启动器用 Electron 44 内置的
`globalThis.WebSocket`，因此不需要 `ws` 依赖；服务端用 `ws`。

## 帧

**控制帧**：UTF-8 JSON 文本，必须带 `t` 字段。超过 64 KiB 直接丢弃。

| `t` | 方向 | 字段 | 含义 |
| --- | --- | --- | --- |
| `hello` | 客户端 → 服务端 | `client`, `protocol` | 连接后第一帧，5s 内不发就被踢；名字或版本不匹配回 `error(protocol)` 并关闭 |
| `host` | 客户端 → 服务端 | `room`, `password?`, `targetPort?`, `listen?` | 建房。房间被占 → `error(room-exists)` |
| `join` | 客户端 → 服务端 | `room`, `password?`, `token?` | 进房。没有房间 → `no-room`；房主不在 → `no-host`；人满 → `full`；口令错 → `bad-password` |
| `ok` | 服务端 → 客户端 | `role`, `room`, `peer`, `token?`, `peers?` | 注册成功。`peer` 是服务端给这条连接分配的编号；房主额外拿到 `token`（下次免口令） |
| `open` | 加入者 → 服务端 | `room` | 加入者的本地端口已经有游戏连上，请求对端 |
| `opened` | 服务端 → 加入者 | `peer` | 告知对端（房主）编号，随后本地字节按这个编号封装 |
| `peer-open` | 服务端 → 房主 | `peer`, `name?` | 有新加入者，房主去拨本地游戏端口并绑定该编号 |
| `peer-close` | 双向 | `peer` | 我这一侧结束了与该编号的隧道；对端收到后销毁对应隧道 |
| `peers` | 服务端 → 客户端 | `peers[]` | 房间成员快照 |
| `ping` / `pong` | 双向 | `ts` | 保活（启动器默认 20s 一次），`pong` 原样回 `ts`，用于算 RTT |
| `error` | 服务端 → 客户端 | `code`, `message` | 错误码见下 |
| `close` | 服务端 → 客户端 | `reason?` | 服务端主动退出 |

`code` 取值：`bad-request` `bad-password` `no-room` `no-host` `room-exists` `full` `protocol` `internal`。

**数据帧**：二进制。

```
[0x01][uint16 BE 对端编号长度][对端编号 UTF-8][原始 TCP 字节]
```

首字节 `0x01` 用来区分两类帧（JSON 不可能以它开头）。对端编号 1–64 字节可打印 ASCII，
单帧负载上限 256 KiB。服务端按编号在同一房间内路由，并把头部改写成**发送者**的编号，
所以两边各自只需用"对端编号"索引自己的隧道。目标不存在时回一条 `peer-close`，
避免一端写进黑洞。

## 一次完整握手

```
房主                          中继                          加入者
 ├─ hello ───────────────────▶│
 ├─ host{room,pw,port} ──────▶│◀───────────────── hello ─┤
 │◀──────────── ok{peer,token}│◀──── join{room,pw} ──────┤
 │                            │──── ok{peer,peers} ─────▶│
 │◀──────── peer-open{p2} ────│                          │
 │  （拨 127.0.0.1:25565）      │◀──────── open{room} ────┤
 │                            │──── opened{peer=host} ──▶│
 ├═ data[p2] 游戏字节 ═══════▶│═══════ data[p1] ════════▶│
 │◀═ data[p2] 游戏字节 ═══════│◀══════ data[p1] ═════════│
 ├─ peer-close{p2} ──────────▶│────── peer-close{p1} ───▶│
```

## 启动器一侧的行为

- `settings.relayServerUrl` 为空时功能显示为"未启用"并给出说明，不会去连、也不会卡住转圈。
- 房主模式：若目标端口已被游戏占用，退回到临时端口并**主动拨**游戏的端口（`upstreamPort`），
  所以游戏不需要任何改动；若端口空闲则直接绑定它。
- 加入者模式：优先绑定 `25565`，被占用则退回临时端口并把实际端口回报在 `RelayStatus.localPort`，
  游戏里连 `localhost:<该端口>`。
- 隧道建立前游戏就可能发出握手字节，因此这些字节先排队，拿到对端编号后再冲刷。
- 断线只自动重连一次（房间号与口令还在），再失败就落到 `state:'error'` 并带类型化错误。
- 停止时：先拒绝所有等待中的请求，再销毁隧道与本地套接字，最后关闭监听。

## 安全边界

- 中继能看到全部游戏流量，请只连你自己信任的实例。
- 口令是明文比对，`token` 只是免重输的凭据；对外部署请套 wss。
- 房间号、对端编号都会被严格校验（长度、可打印 ASCII、目录穿越无关）。
- 服务端不写文件、不起子进程、不解析 Minecraft 协议。
