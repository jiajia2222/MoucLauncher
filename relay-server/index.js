/**
 * MoucX 跨网联机中继服务端。
 *
 * 它只做一件事：把两个 TCP 字节流接起来。不解析 Minecraft 协议、不存任何文件、
 * 不执行任何外部命令。房间口令只保存在内存里，进程重启即失效。
 *
 * 协议见 docs/relay-protocol.md（帧格式与 src/main/online/relay/framing.ts 一致）。
 *
 * 用法：  node index.js            环境变量： PORT / MAX_PEERS / IDLE_MS
 */
'use strict'

const { createServer } = require('node:http')
const { WebSocketServer } = require('ws')

const PORT = Number(process.env.PORT ?? 8758)
const MAX_PEERS = Math.max(1, Number(process.env.MAX_PEERS ?? 8))
const IDLE_MS = Math.max(10_000, Number(process.env.IDLE_MS ?? 60_000))
const HELLO_MS = 5_000
const MAX_CONTROL_BYTES = 64 * 1024
const MAX_DATA_BYTES = 256 * 1024
const DATA_MARKER = 0x01
const DATA_HEADER_BYTES = 3
const PROTOCOL_NAME = 'moucx-relay'
const PROTOCOL_VERSION = 1

const CONTROL_TYPES = new Set([
  'hello',
  'host',
  'join',
  'ok',
  'open',
  'opened',
  'peer-open',
  'peer-close',
  'peers',
  'error',
  'ping',
  'pong',
  'close'
])

/** room -> { host, joiners:Map<peerId,peer>, password, token, createdAt } */
const rooms = new Map()
let peerCounter = 0

function log(message) {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`)
}

function newPeerId() {
  peerCounter = (peerCounter + 1) % 0xffffff
  return `p${Date.now().toString(36)}${peerCounter.toString(36)}`
}

function newToken() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}

function isRoomName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\x00-\x20\x7f]/.test(value)
}

function sendControl(peer, frame) {
  if (!peer || peer.socket.readyState !== peer.socket.OPEN) return
  try {
    peer.socket.send(JSON.stringify(frame))
  } catch (error) {
    log(`send failed peer=${peer.id}: ${error.message}`)
  }
}

function fail(peer, code, message) {
  sendControl(peer, { t: 'error', code, message })
}

function parseControl(raw) {
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONTROL_BYTES) return { error: '控制帧过大' }
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'string' || !CONTROL_TYPES.has(parsed.t)) {
        return { error: '不是控制帧' }
      }
      return { frame: parsed }
    } catch {
      return { error: 'JSON 解析失败' }
    }
  }
  if (Buffer.isBuffer(raw) && raw.length >= DATA_HEADER_BYTES && raw.readUInt8(0) === DATA_MARKER) {
    return { data: decodeData(raw) }
  }
  return { error: '无法识别的帧' }
}

/** `[0x01][uint16 BE peerIdLen][peerId][payload]` -> {peerId, payload}. */
function decodeData(bytes) {
  if (bytes.readUInt8(0) !== DATA_MARKER) return undefined
  const idLength = bytes.readUInt16BE(1)
  if (idLength === 0 || idLength > 64 || bytes.length < DATA_HEADER_BYTES + idLength) return undefined
  const peerId = bytes.toString('utf8', DATA_HEADER_BYTES, DATA_HEADER_BYTES + idLength)
  const payload = bytes.subarray(DATA_HEADER_BYTES + idLength)
  if (payload.length > MAX_DATA_BYTES) return undefined
  return { peerId, payload }
}

function encodeData(peerId, payload) {
  const id = Buffer.from(peerId, 'utf8')
  const out = Buffer.allocUnsafe(DATA_HEADER_BYTES + id.length + payload.length)
  out.writeUInt8(DATA_MARKER, 0)
  out.writeUInt16BE(id.length, 1)
  id.copy(out, DATA_HEADER_BYTES)
  payload.copy(out, DATA_HEADER_BYTES + id.length)
  return out
}

function roomOf(peer) {
  return peer.room.length > 0 ? rooms.get(peer.room) : undefined
}

function peerInfo(room) {
  if (!room) return []
  const list = []
  if (room.host) list.push({ id: room.host.id, name: room.host.id })
  for (const joiner of room.joiners.values()) list.push({ id: joiner.id, name: joiner.id })
  return list
}

function leave(peer) {
  const room = roomOf(peer)
  if (!room) return
  peer.room = ''
  if (room.host === peer) {
    // The host leaving ends the room: everyone loses the tunnel at once.
    for (const joiner of [...room.joiners.values()]) {
      sendControl(joiner, { t: 'error', code: 'no-host', message: '房主已断开' })
      joiner.room = ''
      closePeer(joiner, 'no-host')
    }
    rooms.delete(peer.roomKey)
    log(`room closed ${peer.roomKey} by host`)
    return
  }
  room.joiners.delete(peer.id)
  if (room.host) sendControl(room.host, { t: 'peer-close', peer: peer.id })
  if (room.joiners.size === 0 && !room.host) rooms.delete(peer.roomKey)
}

function closePeer(peer, reason) {
  try {
    peer.socket.close(1000, reason ?? 'bye')
  } catch {
    /* already gone */
  }
}

function routeData(from, targetPeerId, payload) {
  const room = roomOf(from)
  if (!room) {
    fail(from, 'no-room', '尚未加入任何房间')
    return
  }
  const target = targetPeerId === room.host?.id ? room.host : room.joiners.get(targetPeerId)
  if (!target || target === from) {
    // Unknown peer: the other end already closed its tunnel. Tell the sender so it
    // can tear its side down instead of writing into a black hole.
    sendControl(from, { t: 'peer-close', peer: targetPeerId })
    return
  }
  if (!target.socket || target.socket.readyState !== target.socket.OPEN) return
  try {
    target.socket.send(encodeData(from.id, payload))
  } catch (error) {
    log(`route failed ${from.id}->${target.id}: ${error.message}`)
  }
}

function handleControl(peer, frame) {
  peer.lastSeen = Date.now()
  switch (frame.t) {
    case 'hello': {
      peer.gotHello = true
      if (frame.protocol !== PROTOCOL_VERSION || frame.client !== PROTOCOL_NAME) {
        fail(peer, 'protocol', `需要 ${PROTOCOL_NAME} v${PROTOCOL_VERSION}，收到 ${frame.client ?? '?'} v${frame.protocol ?? '?'}`)
        closePeer(peer, 'protocol')
      }
      return
    }
    case 'host': {
      if (!isRoomName(frame.room)) return fail(peer, 'bad-request', '房间号不合法')
      const existing = rooms.get(frame.room)
      if (existing && existing.host && existing.host !== peer) return fail(peer, 'room-exists', '房间号已被占用')
      const room = existing ?? { host: undefined, joiners: new Map(), password: '', token: newToken(), createdAt: Date.now() }
      room.host = peer
      room.password = typeof frame.password === 'string' ? frame.password : ''
      room.targetPort = Number.isInteger(frame.targetPort) ? frame.targetPort : 25565
      rooms.set(frame.room, room)
      peer.room = frame.room
      peer.roomKey = frame.room
      peer.role = 'host'
      sendControl(peer, { t: 'ok', role: 'host', room: frame.room, peer: peer.id, token: room.token })
      log(`host joined ${frame.room} (port ${room.targetPort}, max ${MAX_PEERS})`)
      return
    }
    case 'join': {
      if (!isRoomName(frame.room)) return fail(peer, 'bad-request', '房间号不合法')
      const room = rooms.get(frame.room)
      if (!room) return fail(peer, 'no-room', '没有这个房间')
      if (!room.host) return fail(peer, 'no-host', '房主不在房间中')
      if (room.joiners.size >= MAX_PEERS) return fail(peer, 'full', `房间已满（上限 ${MAX_PEERS} 人）`)
      if (room.password.length > 0) {
        const supplied = typeof frame.password === 'string' ? frame.password : ''
        const token = typeof frame.token === 'string' ? frame.token : ''
        if (supplied !== room.password && token !== room.token) return fail(peer, 'bad-password', '房间口令不正确')
      }
      peer.room = frame.room
      peer.roomKey = frame.room
      peer.role = 'joiner'
      room.joiners.set(peer.id, peer)
      sendControl(peer, { t: 'ok', role: 'joiner', room: frame.room, peer: peer.id, peers: peerInfo(room) })
      sendControl(room.host, { t: 'peer-open', peer: peer.id, name: peer.id })
      log(`joiner ${peer.id} entered ${frame.room} (${room.joiners.size}/${MAX_PEERS})`)
      return
    }
    case 'open': {
      const room = roomOf(peer)
      if (!room || !room.host) return fail(peer, 'no-host', '还没有房主可以连接')
      sendControl(peer, { t: 'opened', peer: room.host.id })
      return
    }
    case 'peer-close': {
      const room = roomOf(peer)
      if (!room) return
      const other = peer === room.host ? undefined : room.host
      if (other) sendControl(other, { t: 'peer-close', peer: peer.id })
      return
    }
    case 'ping':
      sendControl(peer, { t: 'pong', ts: Number(frame.ts) || Date.now() })
      return
    case 'close':
      leave(peer)
      closePeer(peer, 'client-close')
      return
    default:
      return fail(peer, 'bad-request', `未支持的控制帧 ${frame.t}`)
  }
}

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`moucx-relay ok rooms=${rooms.size}\n`)
    return
  }
  res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('这是一个 WebSocket 中继，请用 MoucX 的 联机 页面连接 ws://此主机:' + PORT + '/ws\n')
})

const wss = new WebSocketServer({ server, maxPayload: MAX_DATA_BYTES + 1024 })

wss.on('connection', (socket) => {
  const peer = { id: newPeerId(), socket, room: '', roomKey: '', role: '', gotHello: false, lastSeen: Date.now() }
  peer.OPEN = socket.OPEN
  log(`connection ${peer.id} from ${socket._socket?.remoteAddress ?? '?'}`)
  const helloTimer = setTimeout(() => {
    if (!peer.gotHello) {
      fail(peer, 'bad-request', '连接后没有收到 hello')
      closePeer(peer, 'no-hello')
    }
  }, HELLO_MS)

  socket.on('message', (data, isBinary) => {
    const raw = isBinary ? data : data.toString('utf8')
    const parsed = parseControl(Buffer.isBuffer(raw) ? raw : raw)
    if (parsed.error) {
      log(`bad frame from ${peer.id}: ${parsed.error}`)
      return
    }
    if (parsed.data) {
      if (parsed.data) routeData(peer, parsed.data.peerId, Buffer.from(parsed.data.payload))
      return
    }
    handleControl(peer, parsed.frame)
  })
  socket.on('close', () => {
    clearTimeout(helloTimer)
    leave(peer)
    log(`disconnect ${peer.id}`)
  })
  socket.on('error', (error) => {
    log(`socket error ${peer.id}: ${error.message}`)
    leave(peer)
    closePeer(peer, 'error')
  })
})

const sweeper = setInterval(() => {
  const now = Date.now()
  for (const peer of wss.clients) {
    if (now - peer.lastSeen > IDLE_MS) closePeer(peer, 'idle')
  }
  for (const [name, room] of rooms) {
    if (!room.host && room.joiners.size === 0) rooms.delete(name)
  }
}, 10_000)

server.listen(PORT, () => {
  log(`${PROTOCOL_NAME} v${PROTOCOL_VERSION} listening on :${PORT} (max ${MAX_PEERS} peers/room, idle ${IDLE_MS}ms)`)
})

function shutdown(signal) {
  log(`${signal}, closing`)
  clearInterval(sweeper)
  for (const peer of wss.clients) sendControl(peer, { t: 'close', reason: '中继服务器正在退出' })
  wss.close(() => server.close(() => process.exit(0)))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
