# moucx-relay-server

MoucX 的跨网联机中继。独立进程，不依赖启动器的任何代码，也不属于启动器的打包产物。

它只搬运 TCP 字节：房主把本地 Minecraft 端口挂到房间，加入者的启动器在 `127.0.0.1` 开一个
本地端口，两边之间的字节都走这一条 WebSocket。**它不解析 Minecraft 协议、不落盘、不执行命令。**

## 跑起来

```bash
cd relay-server
npm install          # 只有 ws 一个依赖
npm start            # 默认监听 :8758
```

或者用 Docker：

```bash
docker build -t moucx-relay .
docker run -d --name moucx-relay -p 8758:8758 -e MAX_PEERS=8 moucx-relay
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8758` | 监听端口 |
| `MAX_PEERS` | `8` | 单房间加入者上限 |
| `IDLE_MS` | `60000` | 多久没有任何控制帧就踢掉这条连接（启动器每 20s 发一次 ping） |

## 在启动器里填什么

设置 → 联机 → 中继地址：

```
ws://你的服务器IP:8758/ws
```

公网部署请放在反向代理后面加 wss（Caddy / nginx 都支持 WebSocket 升级），并只开放必要端口。

## 健康检查

```
GET /healthz -> moucx-relay ok rooms=0
```

## 协议

帧格式与状态机见 [`../docs/relay-protocol.md`](../docs/relay-protocol.md)。
实现与本服务端逐帧对应的是启动器里的 `src/main/online/relay/framing.ts`（纯编解码，有单元测试）。

## 已知边界

- 房间状态只在内存里，重启即清空。
- 口令是明文比对（`join.password` 或房主下发的 `token`）。要真正的保密性请自己套 wss。
- 不做带宽限制，也不审计转发内容。
