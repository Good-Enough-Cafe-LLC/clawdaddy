import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCDataChannel,
} from 'react-native-webrtc';
import { computeHMAC, verifyHMAC, reassemble, ChunkFrame } from '@clawdaddy/core';

// ─── createWebRTC ─────────────────────────────────────────────────────────────
//
// Mobile is always the SERVER / RECEIVER role:
//   - Registers with the switchboard as a server node (done in socketClient.ts)
//   - Receives client_session events when a client wants to connect
//   - Receives offers via the signal event and sends answers back
//   - All signals are routed by sessionId — no targetId or authHash on signals
//
// One WebRTC instance is created per client session. The socketClient creates
// a new instance each time a client_session arrives.

export const createWebRTC = ({
  socket,
  authHash,
  sharedKey,
  onData,
  onOpen,
  onClose,
  log,
}: {
  socket:    any;
  authHash:  string;
  sharedKey: string;
  onData:    (data: any) => void;
  onOpen:    () => void;
  onClose:   () => void;
  log:       (msg: string, type?: any) => void;
}) => {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  });

  let dataChannel:  RTCDataChannel | null = null;
  let isConnected   = false;
  let currentSession: string | null = null;  // sessionId of the connected client

  // ── ICE candidates ────────────────────────────────────────────────────────
  // Send candidates back to the client using sessionId as the routing key.
  // The switchboard routes by sessionId + our socket identity (server).
  pc.onicecandidate = ({ candidate }: any) => {
    if (!candidate || !currentSession) return;
    socket.emit('signal', {
      sessionId:  currentSession,
      signalData: { candidate: candidate.toJSON() },
    });
  };

  // ── Connection state ──────────────────────────────────────────────────────
  pc.onconnectionstatechange = () => {
    log(`Connection state: ${pc.connectionState}`);

    if (pc.connectionState === 'connected') {
      if (!isConnected) {
        isConnected = true;
        onOpen();
      }
    } else if (
      pc.connectionState === 'disconnected' ||
      pc.connectionState === 'failed'
    ) {
      if (isConnected) {
        isConnected = false;
        onClose();
      }
      currentSession = null;
    }
  };

  // ── Data channel ──────────────────────────────────────────────────────────
  // Mobile is the receiver, so the data channel is created by the initiator
  // (CLI/web) and we receive it here via ondatachannel.
  pc.ondatachannel = ({ channel }: any) => {
    log('📨 Incoming data channel');
    dataChannel = channel;
    setupDataChannel(channel);
  };

  const setupDataChannel = (channel: RTCDataChannel) => {
    // Chunk reassembly buffer — matches the frame format used by @clawdaddy/core
    channel.onmessage = ({ data }: any) => {
      try {
        const raw    = typeof data === 'string' ? data : data.toString();
        const parsed = JSON.parse(raw);

        // ── Chunk frame path ──────────────────────────────────────────────
        if (
          typeof parsed.id    === 'string' &&
          typeof parsed.index === 'number' &&
          typeof parsed.total === 'number'
        ) {
          const serialised = reassemble(parsed as ChunkFrame);
          if (serialised === null) return; // still waiting for more chunks

          const packet = JSON.parse(serialised);

          if (packet.signature && packet.payload) {
            if (!verifyHMAC(sharedKey, packet.payload, packet.signature)) {
              log('❌ HMAC verification failed', 'error');
              return;
            }
            onData(packet.payload);
          } else {
            onData(packet);
          }
          return;
        }

        // ── Legacy / non-chunked path (backwards compat) ──────────────────
        if (parsed.signature && parsed.payload) {
          if (!verifyHMAC(sharedKey, parsed.payload, parsed.signature)) {
            log('❌ HMAC verification failed (legacy packet)', 'error');
            return;
          }
          onData(parsed.payload);
        } else {
          onData(parsed);
        }
      } catch (e) {
        log(`❌ Malformed packet: ${String(e)}`, 'error');
      }
    };

    channel.onopen = () => {
      log('🔓 Data channel opened');
      if (!isConnected) {
        isConnected = true;
        onOpen();
      }
    };

    channel.onclose = () => {
      log('🔒 Data channel closed');
      if (isConnected) {
        isConnected = false;
        onClose();
      }
      currentSession = null;
    };
  };

  // ── Inbound signals ───────────────────────────────────────────────────────
  // Switchboard forwards signals from the client as { sessionId, signalData }.
  // We store the sessionId on the first offer so we know where to route
  // our answer and ICE candidates.
  const handleSignal = async ({ sessionId, signalData }: any) => {
    try {
      if (signalData.type === 'offer') {
        currentSession = sessionId;
        log(`📞 Offer received (session: ${sessionId.slice(0, 8)}...)`, 'info');

        await pc.setRemoteDescription(new RTCSessionDescription(signalData));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        log(`📞 Sending answer (session: ${sessionId.slice(0, 8)}...)`, 'info');
        socket.emit('signal', { sessionId, signalData: answer });

      } else if (signalData.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
      }
    } catch (e) {
      log(`❌ Signal error: ${String(e)}`, 'error');
    }
  };

  socket.on('signal', handleSignal);

  // ── Send ──────────────────────────────────────────────────────────────────
  // Wraps outgoing packets in an HMAC-signed envelope.
  // No chunking on the send side — react-native-webrtc handles larger messages
  // natively and the CLI/web reassembler will handle chunks if we add them later.
  const send = (packet: any) => {
    if (dataChannel?.readyState !== 'open') {
      log('⚠️ Cannot send: data channel not open', 'error');
      return;
    }

    const signature  = computeHMAC(sharedKey, packet);
    const securePacket = { payload: packet, signature };
    dataChannel.send(JSON.stringify(securePacket));
  };

  // ── Cleanup ───────────────────────────────────────────────────────────────
  const close = () => {
    socket.off('signal', handleSignal);
    if (dataChannel) { try { dataChannel.close(); } catch (_) { } }
    try { pc.close(); } catch (_) { }
    currentSession = null;
  };

  return { pc, send, close };
};