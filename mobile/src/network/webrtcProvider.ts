// webrtcProvider.ts - Clean version (no verbose logs)
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc';
import {
  computeHMAC,
  verifyHMAC,
  reassemble,
  ChunkFrame,
  MAX_SERIALIZED_SIZE,
  CHUNK_SIZE,
} from '@clawdaddy/core';

type RTCDataChannel = any;

const reassemblyBuffers = new Map<string, Map<number, string>>();

function processChunk(frame: ChunkFrame): string | null {
  let buffer = reassemblyBuffers.get(frame.id);
  if (!buffer) {
    buffer = new Map();
    reassemblyBuffers.set(frame.id, buffer);
  }
  buffer.set(frame.index, frame.data);

  if (buffer.size === frame.total) {
    let result = '';
    for (let i = 0; i < frame.total; i++) result += buffer.get(i);
    reassemblyBuffers.delete(frame.id);
    return result;
  }
  return null;
}

const generateSimpleUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export const createWebRTC = ({
  socket,
  sharedKey,
  sessionId,
  onData,
  onOpen,
  onClose,
  log,
}: {
  socket: any;
  sharedKey: string;
  sessionId: string;
  onData: (data: any) => void;
  onOpen: () => void;
  onClose: () => void;
  log: (msg: string, type?: any) => void;
}) => {
  let pc: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let isConnected = false;
  let isClosed = false;

  pc = new RTCPeerConnection({
    iceServers: [
      // Fast, reliable STUN servers
      { urls: 'stun:stun.cloudflare.com:3478' }, // Cloudflare's STUN (very fast)
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    iceCandidatePoolSize: 5, // Reduce from default to speed up
    bundlePolicy: 'max-bundle', // Bundle media streams (faster)
    rtcpMuxPolicy: 'require', // Reduce ports needed
  });

  // Send ICE candidates
  pc.addEventListener('icecandidate', (event: any) => {
    if (event.candidate && !isClosed && sessionId) {
      socket.emit('signal', {
        sessionId,
        signalData: { candidate: event.candidate },
      });
    }
  });

  // Handle connection state
  pc.addEventListener('connectionstatechange', () => {
    if (pc && pc.connectionState === 'connected' && !isConnected && !isClosed) {
      isConnected = true;
      onOpen();
    }
  });

  // Handle incoming data channel
  pc.addEventListener('datachannel', (event: any) => {
    const channel = event.channel;

    channel.onopen = () => {
      if (!isConnected && !isClosed) {
        isConnected = true;
        onOpen();
      }
    };

    channel.onclose = () => {
      if (isConnected && !isClosed) {
        isConnected = false;
        onClose();
      }
    };

    channel.onerror = (error: any) => {
      log(`Data channel error: ${error.message}`, 'error');
    };

    channel.onmessage = (event: any) => {
      try {
        const raw = event.data.toString();
        const parsed = JSON.parse(raw);

        if (parsed.id && typeof parsed.index === 'number') {
          const serialised = processChunk(parsed);
          if (!serialised) return;
          const packet = JSON.parse(serialised);
          if (packet.signature && packet.payload) {
            if (!verifyHMAC(sharedKey, packet.payload, packet.signature)) {
              log('HMAC verification failed', 'error');
              return;
            }
            onData(packet.payload);
          } else {
            onData(packet);
          }
        } else if (parsed.signature && parsed.payload) {
          if (!verifyHMAC(sharedKey, parsed.payload, parsed.signature)) {
            log('HMAC verification failed', 'error');
            return;
          }
          onData(parsed.payload);
        } else {
          onData(parsed);
        }
      } catch (e) {
        log(`Message error: ${e}`, 'error');
      }
    };

    dataChannel = channel;
  });

  const signal = async (signalData: any) => {
    try {
      if (signalData.type === 'offer') {
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(signalData));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { sessionId, signalData: answer });
        }
      } else if (signalData.candidate) {
        if (pc) {
          await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        }
      }
    } catch (e: any) {
      log(`Signal error: ${e.message}`, 'error');
    }
  };

  const send = (packet: any) => {
    if (!dataChannel || dataChannel.readyState !== 'open') {
      log('Cannot send: data channel not ready', 'error');
      return;
    }

    try {
      const signature = computeHMAC(sharedKey, packet);
      const securePacket = { payload: packet, signature };
      const serialised = JSON.stringify(securePacket);
      const id = generateSimpleUUID();
      const total = Math.ceil(serialised.length / CHUNK_SIZE);

      for (let i = 0; i < total; i++) {
        const frame = {
          id,
          index: i,
          total,
          data: serialised.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        };
        dataChannel.send(JSON.stringify(frame));
      }
    } catch (err: any) {
      log(`Send error: ${err.message}`, 'error');
    }
  };

  const close = () => {
    if (isClosed) return;
    isClosed = true;
    if (dataChannel) {
      try {
        dataChannel.close();
      } catch (_) {}
    }
    if (pc) {
      try {
        pc.close();
      } catch (_) {}
    }
    isConnected = false;
  };

  return { send, signal, close };
};
