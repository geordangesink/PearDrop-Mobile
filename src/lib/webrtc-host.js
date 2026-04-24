/* global WebSocket */

import * as ExpoCrypto from 'expo-crypto'
import b4a from 'b4a'
import DHT from '@hyperswarm/dht-relay'
import RelayStream from '@hyperswarm/dht-relay/ws'
import {
  RTCPeerConnection as RNRTCPeerConnection,
  RTCIceCandidate as RNRTCIceCandidate
} from 'react-native-webrtc'

const DEFAULT_ICE_SERVERS = [
  {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'stun:global.stun.twilio.com:3478',
      'stun:stun.sipgate.net:3478',
      'stun:stun.nextcloud.com:443',
      'stun:openrelay.metered.ca:80',
      'stun:openrelay.metered.ca:443'
    ]
  }
]

const PeerConnectionCtor =
  typeof globalThis.RTCPeerConnection === 'function'
    ? globalThis.RTCPeerConnection
    : RNRTCPeerConnection
const IceCandidateCtor =
  typeof globalThis.RTCIceCandidate === 'function' ? globalThis.RTCIceCandidate : RNRTCIceCandidate

export async function createWebRtcHost({ invite, rpc }) {
  const normalizedInvite = String(invite || '').trim()
  if (!normalizedInvite) throw new Error('Missing invite for WebRTC host')
  if (!rpc || typeof rpc.request !== 'function') throw new Error('RPC client unavailable')

  const parsedInvite = new URL(normalizedInvite)
  const relayUrl = parsedInvite.searchParams.get('relay') || 'wss://pear-drops.up.railway.app'

  const relaySocket = new WebSocket(relayUrl)
  await onceWebSocketOpen(relaySocket)
  let closed = false

  const relayTransport = new RelayStream(true, relaySocket)
  patchEmitterCompat(relayTransport)
  relayTransport.on?.('error', onBenignConnectionError)
  const seed = await deriveStableSignalSeed(normalizedInvite)
  const keyPair = DHT.keyPair(seed)
  const dht = new DHT(relayTransport, { keyPair })
  const server = dht.createServer()
  server.on?.('error', onBenignConnectionError)

  server.on('connection', (signalSocket) => {
    signalSocket.on?.('error', onBenignConnectionError)
    void handleSignalConnection(signalSocket, { invite: normalizedInvite, rpc })
  })
  await server.listen(keyPair)

  const markClosed = () => {
    closed = true
  }
  relaySocket.addEventListener('close', markClosed)
  relaySocket.addEventListener('error', markClosed)

  const webLink = buildWebLink({
    signalKey: b4a.toString(keyPair.publicKey, 'hex'),
    relayUrl,
    invite: normalizedInvite
  })

  return {
    webLink,
    isAlive() {
      if (closed) return false
      return relaySocket.readyState === WebSocket.OPEN
    },
    async close() {
      closed = true
      try {
        await server.close()
      } catch {}
      try {
        await dht.destroy()
      } catch {}
      try {
        relaySocket.close()
      } catch {}
    }
  }
}

async function deriveStableSignalSeed(invite) {
  const input = `peardrop-mobile-webrtc-share-v1\0${String(invite || '').trim()}`
  try {
    const digest = await ExpoCrypto.digestStringAsync(
      ExpoCrypto.CryptoDigestAlgorithm.SHA256,
      input
    )
    const hex = String(digest || '').trim()
    if (hex.length === 64) return b4a.from(hex, 'hex')
  } catch {
    // Fall through to deterministic JS fallback.
  }
  return deterministicSeedFromString(input)
}

function deterministicSeedFromString(text) {
  const input = String(text || '')
  const bytes = new Uint8Array(32)
  for (let lane = 0; lane < 8; lane += 1) {
    let hash = (0x811c9dc5 ^ (lane * 0x9e3779b1)) >>> 0
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i) & 0xff
      hash = Math.imul(hash, 0x01000193) >>> 0
      hash ^= (input.charCodeAt(i) >>> 8) & 0xff
      hash = Math.imul(hash, 0x01000193) >>> 0
      hash = (hash ^ (hash >>> 13)) >>> 0
    }
    const offset = lane * 4
    bytes[offset] = hash & 0xff
    bytes[offset + 1] = (hash >>> 8) & 0xff
    bytes[offset + 2] = (hash >>> 16) & 0xff
    bytes[offset + 3] = (hash >>> 24) & 0xff
  }
  return b4a.from(bytes)
}

function buildWebLink({ signalKey, relayUrl, invite }) {
  const url = new URL('peardrops-web://join')
  url.searchParams.set('signal', String(signalKey || ''))
  url.searchParams.set('relay', String(relayUrl || ''))
  url.searchParams.set('invite', String(invite || ''))
  return url.toString()
}

async function handleSignalConnection(signalSocket, { invite, rpc }) {
  signalSocket.on?.('error', onBenignConnectionError)
  const peer = createLinePeer(signalSocket)
  let pc = null
  let dataChannel = null
  let remoteDescriptionSet = false
  let pendingRemoteCandidates = []
  let lastOfferSdp = ''
  let lastAnswerSdp = ''
  let currentOfferId = 0

  peer.send({
    type: 'ready',
    hostNowMs: Date.now(),
    punchAtMs: Date.now() + 900
  })

  const destroyPeerConnection = () => {
    if (dataChannel && dataChannel.readyState !== 'closed') {
      try {
        dataChannel.close()
      } catch {}
    }
    dataChannel = null
    if (pc) {
      try {
        pc.onicecandidate = null
        pc.oniceconnectionstatechange = null
        pc.onconnectionstatechange = null
        pc.ondatachannel = null
        pc.close()
      } catch {}
    }
    pc = null
    remoteDescriptionSet = false
    pendingRemoteCandidates = []
  }

  const addRemoteCandidate = async (candidate) => {
    if (!candidate) {
      await pc.addIceCandidate(null)
      return true
    }
    const candidateForAdd = IceCandidateCtor ? new IceCandidateCtor(candidate) : candidate
    await pc.addIceCandidate(candidateForAdd)
    return true
  }

  const flushPendingCandidates = async () => {
    if (!remoteDescriptionSet || !pendingRemoteCandidates.length) return
    while (pendingRemoteCandidates.length) {
      const candidate = pendingRemoteCandidates.shift()
      try {
        await addRemoteCandidate(candidate)
      } catch {}
    }
  }

  const createPeerConnection = () => {
    destroyPeerConnection()
    const localPc = new PeerConnectionCtor({
      iceServers: DEFAULT_ICE_SERVERS,
      iceCandidatePoolSize: 8
    })
    pc = localPc

    localPc.onicecandidate = (event) => {
      if (pc !== localPc) return
      if (event.candidate) {
        const normalized = normalizeCandidateForSignal(event.candidate)
        if (!normalized) return
        if (isMdnsIceCandidate(normalized)) return
        peer.send({
          type: 'candidate',
          candidate: normalized,
          offerId: currentOfferId || undefined
        })
        return
      }
      peer.send({
        type: 'candidate-end',
        endOfCandidates: true,
        offerId: currentOfferId || undefined
      })
    }

    localPc.oniceconnectionstatechange = () => {
      if (pc !== localPc) return
      peer.send({
        type: 'host-ice-state',
        state: String(localPc.iceConnectionState || '')
      })
    }

    localPc.onconnectionstatechange = () => {
      if (pc !== localPc) return
      peer.send({
        type: 'host-conn-state',
        state: String(localPc.connectionState || '')
      })
    }

    localPc.ondatachannel = (event) => {
      if (pc !== localPc) return
      dataChannel = event.channel
      bindDataChannel(dataChannel, { invite, rpc })
    }
  }

  createPeerConnection()

  const handleOfferMessage = async (message) => {
    const incomingOfferSdp = sanitizeIceSdp(String(message.sdp || ''))
    const incomingOfferId = Number(message.offerId || 0)
    if (incomingOfferId > 0) currentOfferId = incomingOfferId

    if (lastAnswerSdp && incomingOfferSdp && incomingOfferSdp === lastOfferSdp) {
      peer.send({
        type: 'answer',
        sdp: lastAnswerSdp,
        offerId: incomingOfferId || currentOfferId || undefined
      })
      return
    }

    if (String(pc?.signalingState || '') !== 'stable') {
      if (lastAnswerSdp) {
        peer.send({
          type: 'answer',
          sdp: lastAnswerSdp,
          offerId: incomingOfferId || currentOfferId || undefined
        })
      }
      return
    }

    remoteDescriptionSet = false
    pendingRemoteCandidates = []

    try {
      await pc.setRemoteDescription({
        type: 'offer',
        sdp: incomingOfferSdp
      })
      remoteDescriptionSet = true
      await flushPendingCandidates()
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      const sdp = sanitizeIceSdp(String(answer.sdp || ''))
      lastOfferSdp = incomingOfferSdp
      lastAnswerSdp = sdp
      peer.send({
        type: 'answer',
        sdp,
        offerId: incomingOfferId || undefined
      })
      if (incomingOfferId > 0) {
        peer.send({ type: 'offer-ack', offerId: incomingOfferId, stage: 'answered' })
      }
    } catch (error) {
      peer.send({
        type: 'error',
        error: String(error?.message || error || 'Failed to process offer')
      })
    }
  }

  peer.onMessage(async (message) => {
    if (!pc) return
    if (message.type === 'offer' && message.sdp) {
      await handleOfferMessage(message)
      return
    }
    if (message.type === 'candidate' && message.candidate) {
      const normalized = normalizeCandidateForSignal(message.candidate)
      if (!normalized) return
      const candidateOfferId = Number(message.offerId || 0)
      if (candidateOfferId > 0 && currentOfferId > 0 && candidateOfferId !== currentOfferId) {
        return
      }
      if (isMdnsIceCandidate(normalized)) return
      if (!remoteDescriptionSet) {
        pendingRemoteCandidates.push(normalized)
        return
      }
      try {
        await addRemoteCandidate(normalized)
      } catch {}
      return
    }
    if (message.type === 'candidate-end' || message.endOfCandidates === true) {
      const candidateOfferId = Number(message.offerId || 0)
      if (candidateOfferId > 0 && currentOfferId > 0 && candidateOfferId !== currentOfferId) {
        return
      }
      if (!remoteDescriptionSet) {
        pendingRemoteCandidates.push(null)
        return
      }
      try {
        await addRemoteCandidate(null)
      } catch {}
    }
  })

  signalSocket.on('close', () => {
    destroyPeerConnection()
  })
}

function onBenignConnectionError(error) {
  if (isBenignConnectionError(error)) return
  console.error('Non-benign relay connection error:', error)
}

function isBenignConnectionError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    message.includes('connection reset by peer') ||
    message.includes('stream was destroyed') ||
    message.includes('socket closed')
  )
}

function bindDataChannel(channel, { invite, rpc }) {
  channel.onmessage = async (event) => {
    let request = null
    try {
      request = JSON.parse(String(event.data || '{}'))
    } catch {
      return
    }

    const id = typeof request.id === 'number' ? request.id : 0
    const reply = (payload) => {
      if (channel.readyState !== 'open') return
      channel.send(JSON.stringify({ id, ...payload }))
    }

    try {
      if (request.type === 'manifest') {
        const manifest = await rpc.request(3, { invite })
        reply({ ok: true, manifest })
        return
      }

      if (request.type === 'file') {
        const entry = await rpc.request(6, { invite, drivePath: request.path })
        reply({ ok: true, dataBase64: entry.dataBase64 })
        return
      }

      if (request.type === 'file-chunk') {
        const entry = await rpc.request(10, {
          invite,
          drivePath: request.path,
          offset: Number(request.offset || 0),
          length: Number(request.length || 0)
        })
        reply({
          ok: true,
          offset: Number(entry?.offset || 0),
          byteLength: Number(entry?.byteLength || 0),
          dataBase64: entry?.dataBase64 || ''
        })
        return
      }

      reply({ ok: false, error: 'Unknown request type' })
    } catch (error) {
      reply({ ok: false, error: String(error?.message || error || 'Data request failed') })
    }
  }
}

function createLinePeer(signalSocket) {
  let buffered = ''
  const listeners = new Set()

  signalSocket.on('data', (chunk) => {
    buffered += b4a.toString(chunk, 'utf8')
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) {
        try {
          const message = JSON.parse(line)
          for (const listener of listeners) {
            void listener(message)
          }
        } catch {}
      }
      newline = buffered.indexOf('\n')
    }
  })

  return {
    send(message) {
      signalSocket.write(b4a.from(`${JSON.stringify(message)}\n`, 'utf8'))
    },
    onMessage(listener) {
      listeners.add(listener)
    }
  }
}

function patchEmitterCompat(streamLike) {
  if (!streamLike || typeof streamLike !== 'object') return

  if (typeof streamLike.setMaxListeners !== 'function') {
    streamLike.setMaxListeners = () => streamLike
  } else {
    const original = streamLike.setMaxListeners.bind(streamLike)
    streamLike.setMaxListeners = (...args) => {
      try {
        original(...args)
      } catch {}
      return streamLike
    }
  }

  if (typeof streamLike.once !== 'function' && typeof streamLike.on === 'function') {
    streamLike.once = (eventName, listener) => {
      if (typeof listener !== 'function') return streamLike
      const wrapped = (...args) => {
        try {
          if (typeof streamLike.off === 'function') streamLike.off(eventName, wrapped)
          else if (typeof streamLike.removeListener === 'function') {
            streamLike.removeListener(eventName, wrapped)
          }
        } catch {}
        listener(...args)
      }
      streamLike.on(eventName, wrapped)
      return streamLike
    }
  }
}

function onceWebSocketOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      socket.removeEventListener?.('open', onOpen)
      socket.removeEventListener?.('error', onError)
    }
    const onOpen = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onError = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Relay connection failed'))
    }
    socket.addEventListener?.('open', onOpen)
    socket.addEventListener?.('error', onError)
  })
}

function normalizeCandidateForSignal(candidateLike) {
  if (!candidateLike) return null
  if (typeof candidateLike === 'string') return { candidate: candidateLike }

  const candidateText = String(candidateLike.candidate || '').trim()
  if (!candidateText) return null
  const normalized = { candidate: candidateText }

  const sdpMid = String(candidateLike.sdpMid || '').trim()
  if (sdpMid) normalized.sdpMid = sdpMid

  const sdpMLineIndex = Number(candidateLike.sdpMLineIndex)
  if (Number.isFinite(sdpMLineIndex)) normalized.sdpMLineIndex = sdpMLineIndex

  const usernameFragment = String(candidateLike.usernameFragment || '').trim()
  if (usernameFragment) normalized.usernameFragment = usernameFragment

  return normalized
}

function sanitizeIceSdp(sdpText) {
  const raw = String(sdpText || '')
  if (!raw) return raw
  const lines = raw.split(/\r?\n/)
  const out = []
  for (const line of lines) {
    const value = String(line || '')
    if (!value) {
      out.push(value)
      continue
    }
    if (value.startsWith('a=candidate:')) {
      if (isMdnsIceCandidate(value)) continue
    }
    out.push(value)
  }
  return out.join('\r\n')
}

function isMdnsIceCandidate(candidateLike) {
  const line =
    typeof candidateLike === 'string' ? candidateLike : String(candidateLike?.candidate || '')
  return /\b[a-z0-9-]+\.local\b/i.test(line)
}
