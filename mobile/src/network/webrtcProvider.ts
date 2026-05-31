// webrtcProvider.ts - Complete working version
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
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
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

  log(`📱 Creating WebRTC receiver for session ${sessionId.slice(0, 8)}...`, 'info');

  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
    ],
  });

  // Send ICE candidates
  pc.addEventListener('icecandidate', (event: any) => {
    if (event.candidate && !isClosed && sessionId) {
      log(`❄️ Sending ICE candidate`, 'info');
      socket.emit('signal', {
        sessionId,
        signalData: { candidate: event.candidate },
      });
    }
  });

  // Log ICE connection state
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc) {
      const state = pc.iceConnectionState;
      log(`❄️ ICE state: ${state}`, 'info');
      if (state === 'connected') {
        log('✅ ICE connected!', 'success');
      } else if (state === 'failed') {
        log('❌ ICE failed', 'error');
      }
    }
  });

  // Handle connection state
  pc.addEventListener('connectionstatechange', () => {
    if (pc) {
      const state = pc.connectionState;
      log(`🔌 Connection state: ${state}`, 'info');
      if (state === 'connected' && !isConnected && !isClosed) {
        isConnected = true;
        log('🎉 WebRTC connected!', 'success');
        onOpen();
      }
    }
  });

  // Handle incoming data channel (client will create it)
  pc.addEventListener('datachannel', (event: any) => {
    log('📨 Data channel received!', 'success');
    const channel = event.channel;
    
    // Setup the data channel
    channel.onopen = () => {
      log('🔓 Data channel open', 'success');
      if (!isConnected && !isClosed) {
        isConnected = true;
        onOpen();
      }
    };
    
    channel.onclose = () => {
      log('🔒 Data channel closed', 'info');
      if (isConnected && !isClosed) {
        isConnected = false;
        onClose();
      }
    };
    
    channel.onerror = (error: any) => {
      log(`❌ Data channel error: ${error.message}`, 'error');
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
              log('❌ HMAC failed', 'error');
              return;
            }
            onData(packet.payload);
          } else {
            onData(packet);
          }
        } else if (parsed.signature && parsed.payload) {
          if (!verifyHMAC(sharedKey, parsed.payload, parsed.signature)) {
            log('❌ HMAC failed', 'error');
            return;
          }
          onData(parsed.payload);
        } else {
          onData(parsed);
        }
      } catch (e) {
        log(`❌ Message error: ${e}`, 'error');
      }
    };
    
    dataChannel = channel;
  });

  // Signal method for MultiPeerManager to call
  const signal = async (signalData: any) => {
    try {
      if (signalData.type === 'offer') {
        log(`📞 Received offer, creating answer...`, 'info');
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(signalData));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          log(`📞 Sending answer`, 'info');
          socket.emit('signal', { sessionId, signalData: answer });
        }
      } else if (signalData.candidate) {
        log(`❄️ Adding ICE candidate`, 'info');
        if (pc) {
          await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
        }
      }
    } catch (e: any) {
      log(`❌ Signal error: ${e.message}`, 'error');
    }
  };

  // Send function with proper error handling
  // Replace the send function in webrtcProvider.ts with this debugging version:

const send = (packet: any) => {
  log(`📤 send() called`, 'info');
  
  if (!dataChannel) {
    log('❌ dataChannel is null', 'error');
    return;
  }
  
  // Log everything about the dataChannel object
  log(`📊 dataChannel keys: ${Object.keys(dataChannel).join(', ')}`, 'info');
  log(`📊 dataChannel prototype keys: ${Object.keys(Object.getPrototypeOf(dataChannel)).join(', ')}`, 'info');
  log(`📊 dataChannel.readyState: ${dataChannel.readyState}`, 'info');
  log(`📊 typeof dataChannel.send: ${typeof dataChannel.send}`, 'info');
  log(`📊 dataChannel._send: ${typeof dataChannel._send}`, 'info');
  log(`📊 dataChannel.sendMessage: ${typeof dataChannel.sendMessage}`, 'info');
  
  // Try different possible method names
  let sendMethod = null;
  
  if (typeof dataChannel.send === 'function') {
    sendMethod = dataChannel.send;
    log('✅ Using dataChannel.send', 'info');
  } else if (typeof dataChannel._send === 'function') {
    sendMethod = dataChannel._send;
    log('✅ Using dataChannel._send', 'info');
  } else if (typeof dataChannel.sendMessage === 'function') {
    sendMethod = dataChannel.sendMessage;
    log('✅ Using dataChannel.sendMessage', 'info');
  } else if (typeof dataChannel.sendData === 'function') {
    sendMethod = dataChannel.sendData;
    log('✅ Using dataChannel.sendData', 'info');
  }
  
  if (!sendMethod) {
    log('❌ No send method found on dataChannel!', 'error');
    // Try to see if there's any function on the object
    for (const key of Object.keys(dataChannel)) {
      if (typeof dataChannel[key] === 'function') {
        log(`   Found function: ${key}`, 'info');
      }
    }
    return;
  }
  
  // Bind the method to the dataChannel object
  const boundSend = sendMethod.bind(dataChannel);
  
  try {
    const signature = computeHMAC(sharedKey, packet);
    const securePacket = { payload: packet, signature };
    const serialised = JSON.stringify(securePacket);
    const id = generateSimpleUUID();
    const total = Math.ceil(serialised.length / CHUNK_SIZE);
    
    log(`📤 Sending ${total} chunks, total size: ${serialised.length} bytes`, 'info');
    
    for (let i = 0; i < total; i++) {
      const frame = {
        id,
        index: i,
        total,
        data: serialised.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      };
      boundSend(JSON.stringify(frame));
    }
    
    log(`✅ Packet sent successfully`, 'success');
  } catch (err: any) {
    log(`❌ Send error: ${err.message}`, 'error');
    log(`   Stack: ${err.stack}`, 'error');
  }
};

  const close = () => {
    if (isClosed) return;
    isClosed = true;
    if (dataChannel) {
      try { dataChannel.close(); } catch (_) {}
    }
    if (pc) {
      try { pc.close(); } catch (_) {}
    }
    isConnected = false;
  };

  return { send, signal, close };
};