/**
 * Clawdaddy Node — Mobile App
 * ────────────────────────────
 * Two pages, swipeable:
 *   LEFT  → Server mode  (broadcast node, accepts remote inference)
 *   RIGHT → Client mode  (local chat UI, talks to the model directly)
 *
 * Both share llamaRef and inferringRef — first request wins.
 */
import BackgroundService from 'react-native-background-actions';
import { createSocketClient } from './src/network/socketClient';
import { runInference, Mode } from './src/inference/inferenceEngine';
import { handleCommand } from './src/commands/commandEngine';
import { createLocalAdapter, InferencePacket, AdapterPacket } from './src/network/localAdapter';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  SafeAreaView, Text, Switch, StyleSheet, View, ScrollView,
  TouchableOpacity, Animated, Easing, StatusBar, Platform,
  TextInput, KeyboardAvoidingView, FlatList, Dimensions,
} from 'react-native';
import { initLlama, LlamaContext } from 'llama.rn';
import RNFS from 'react-native-fs';

// ─── Config ───────────────────────────────────────────────────────────────────
const SIGNAL_SERVER = 'https://clawdaddyswitch01.goodenoughcafe.com';
const CONFIG_PATH = `${RNFS.DocumentDirectoryPath}/clawdaddy.config.json`;
const MODES_PATH = `${RNFS.DocumentDirectoryPath}/clawdaddy.modes.json`;
const { width: SCREEN_W } = Dimensions.get('window');



const normalizePairingCode = (code: string): string => {
  const cleaned = code.trim().toUpperCase().replace(/\s+/g, '');
  if (cleaned.length === 8 && !cleaned.includes('-')) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
  }
  return cleaned;
};


const generateNodeId = () => {
  const hex = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
};

const generatePairingCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const part1 = Array(4).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
  const part2 = Array(4).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${part1}-${part2}`;
};



const MODEL_DOWNLOAD_URL = 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf';
const MODEL_FILENAME = 'gemma4-e2b-q4.gguf';
const MODEL_PATH = `${RNFS.DocumentDirectoryPath}/${MODEL_FILENAME}`;

// ─── Types ────────────────────────────────────────────────────────────────────
type AppPhase = 'loading' | 'ready' | 'downloading';
type LogType = 'info' | 'success' | 'error' | 'data';
type MsgRole = 'user' | 'assistant';

interface LogEntry { time: string; msg: string; type: LogType }
interface ChatMessage {
  id: string; role: MsgRole; content: string;
  streaming?: boolean; stats?: { tokens: number; ms: number; tps: number };
}

// Inline editor state — null means closed, 'new' means creating
type EditingMode = { id: string; name: string; icon: string; systemPrompt: string } | null;

const timestamp = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const uid = () => Math.random().toString(36).slice(2);
const slugify = (s: string) => s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

// ─── Built-in modes ───────────────────────────────────────────────────────────
const DEFAULT_MODE: Mode = {
  id: 'default', name: 'Default', icon: '🏮',
  systemPrompt: 'You are a helpful assistant.',
  locked: true,
};
const BUILTIN_MODES: Mode[] = [
  DEFAULT_MODE,
  {
    id: 'crabby', name: 'Crabby Bot', icon: '🦀',
    systemPrompt: "You are Clawdaddy, a grumpy but helpful crab. You're easily annoyed and use crab puns. Keep it snappy.",
    locked: false
  },
];

// ─── App ──────────────────────────────────────────────────────────────────────
const App = () => {

  // Phase & model
  const [phase, setPhase] = useState<AppPhase>('loading');
  const [modelPath, setModelPath] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadedMB, setDownloadedMB] = useState(0);
  const [totalMB, setTotalMB] = useState(0);

  // Modes
  const [modes, setModes] = useState<Mode[]>(BUILTIN_MODES);
  const [activeModeId, setActiveModeId] = useState('default');
  const modesRef = useRef<Mode[]>(BUILTIN_MODES);
  const activeModeIdRef = useRef('default');
  useEffect(() => { modesRef.current = modes; }, [modes]);
  useEffect(() => { activeModeIdRef.current = activeModeId; }, [activeModeId]);

  // Inline personality editor
  const [editing, setEditing] = useState<EditingMode>(null);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const isNewMode = editing !== null && !modes.find(m => m.id === editing.id);

  // Identity / network
  const [phoneId, setPhoneId] = useState('');
  const [active, setActive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [inferring, setInferring] = useState(false);
  const inferringRef = useRef(false);
  const llamaRef = useRef<LlamaContext | null>(null);
  const clientRef = useRef<any>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [showPairingCode, setShowPairingCode] = useState(false);

  // Swipe / page
  const [page, setPage] = useState(0);
  const pageScrollRef = useRef<ScrollView>(null);
  const swipeHintAnim = useRef(new Animated.Value(0)).current;
  const hasHinted = useRef(false);

  // Client chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [clientInferring, setClientInf] = useState(false);
  const chatScrollRef = useRef<FlatList<ChatMessage>>(null);
  const activeRequestId = useRef<string | null>(null);

  // Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const logScrollRef = useRef<ScrollView>(null);

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // ── Persist user modes ────────────────────────────────────────────────────
  const persistUserModes = useCallback(async (allModes: Mode[]) => {
    const builtinIds = new Set(BUILTIN_MODES.map(m => m.id));
    try {
      await RNFS.writeFile(MODES_PATH, JSON.stringify(allModes.filter(m => !builtinIds.has(m.id))), 'utf8');
    } catch (_) { }
  }, []);

  // ── Logging ───────────────────────────────────────────────────────────────
  const addLog = useCallback((msg: string, type: LogType = 'info') => {
    setLogs(prev => [...prev.slice(-199), { time: timestamp(), msg, type }]);
    setTimeout(() => logScrollRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  const backgroundOptions = {
    taskName: 'ClawdaddyNode',
    taskTitle: 'Clawdaddy is active',
    taskDesc: 'Providing AI inference to the network',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: '#ef4444',
  };

  // This function just loops forever to keep the JS engine from sleeping
  const backgroundTask = async (taskData: any) => {
    await new Promise(async (resolve) => {
      while (BackgroundService.isRunning()) {
        // Heartbeat log (optional)
        // console.log('Background task running...');
        await new Promise(r => setTimeout(r, 5000));
      }
    });
  };

  // ── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        if (await RNFS.exists(MODES_PATH)) {
          const saved: Mode[] = JSON.parse(await RNFS.readFile(MODES_PATH, 'utf8'));
          const builtinIds = new Set(BUILTIN_MODES.map(m => m.id));
          const merged = [...BUILTIN_MODES, ...saved.filter(m => !builtinIds.has(m.id))];
          setModes(merged);
          modesRef.current = merged;
        }
      } catch { addLog('Failed to load modes', 'error'); }

      try {
        const configExists = await RNFS.exists(CONFIG_PATH);
        const config = configExists ? JSON.parse(await RNFS.readFile(CONFIG_PATH, 'utf8')) : {};
        const savedId = config.nodeId ?? generateNodeId();
        const savedCode = config.pairingCode ? normalizePairingCode(config.pairingCode) : generatePairingCode();
        
        setPhoneId(savedId);
        setPairingCode(savedCode);

        if (config.modelPath && await RNFS.exists(config.modelPath)) {
          setModelPath(config.modelPath);
          addLog('Model found. Loading…', 'info');
          try {
            llamaRef.current = await initLlama({
              model: config.modelPath, n_ctx: 4096, n_threads: 4, n_gpu_layers: 1, n_batch: 512,
            } as any);
            addLog('Model ready.', 'success');
          } catch (e: any) { addLog(`Model load failed: ${e?.message}`, 'error'); }
        }
        await RNFS.writeFile(CONFIG_PATH, JSON.stringify({ ...config, nodeId: savedId, pairingCode: savedCode }), 'utf8');
      } catch (e: any) {
        addLog(`Boot error: ${e?.message}`, 'error');
        setPhoneId(generateNodeId());
      }

      setPhase('ready');

      setTimeout(() => {
        if (hasHinted.current) return;
        hasHinted.current = true;
        Animated.sequence([
          Animated.timing(swipeHintAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
          Animated.delay(700),
          Animated.timing(swipeHintAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
        ]).start();
      }, 1400);
    })();
    Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }).start();
  }, []);

  // ── Pulse while inferring ─────────────────────────────────────────────────
  useEffect(() => {
    if (inferring) {
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])).start();
    } else { pulseAnim.stopAnimation(); pulseAnim.setValue(1); }
  }, [inferring]);

  // ── Node ID refresh ───────────────────────────────────────────────────────
  const refreshNodeId = useCallback(async () => {
    const newId = generateNodeId();
    setPhoneId(newId);
    clientRef.current?.disconnect(); clientRef.current = null;
    setConnected(false); setActive(false);
    try {
      const cfg = await RNFS.exists(CONFIG_PATH) ? JSON.parse(await RNFS.readFile(CONFIG_PATH, 'utf8')) : {};
      await RNFS.writeFile(CONFIG_PATH, JSON.stringify({ ...cfg, nodeId: newId }), 'utf8');
    } catch (_) { }
    addLog(`Node ID refreshed: ${newId}`, 'info');
  }, [addLog]);

  const refreshPairingCode = useCallback(async () => {
    const newCode = generatePairingCode();
    setPairingCode(newCode);
    // If node is active, disconnect clients since their authHash just changed
    if (active) {
      clientRef.current?.disconnect();
      clientRef.current = null;
      setConnected(false);
      addLog(`Pairing code changed — existing clients disconnected`, 'info');
    }
    try {
      const cfg = await RNFS.exists(CONFIG_PATH) ? JSON.parse(await RNFS.readFile(CONFIG_PATH, 'utf8')) : {};
      await RNFS.writeFile(CONFIG_PATH, JSON.stringify({ ...cfg, pairingCode: newCode }), 'utf8');
    } catch (_) { }
    addLog(`Pairing code refreshed`, 'info');
  }, [active, addLog]);

  // ── Personality editor actions ────────────────────────────────────────────
  const openEdit = useCallback((mode: Mode) => {
    setEditName(mode.name);
    setEditIcon(mode.icon ?? '');
    setEditPrompt(mode.systemPrompt);
    setEditing({ id: mode.id, name: mode.name, icon: mode.icon ?? '', systemPrompt: mode.systemPrompt });
  }, []);

  const openNew = useCallback(() => {
    const draft = { id: `mode_${uid()}`, name: '', icon: '✨', systemPrompt: '' };
    setEditName(''); setEditIcon('✨'); setEditPrompt('');
    setEditing(draft);
  }, []);

  const closeEdit = useCallback(() => setEditing(null), []);

  const saveEdit = useCallback(() => {
    if (!editing) return;
    const name = editName.trim();
    const prompt = editPrompt.trim();
    if (!name || !prompt) return;

    const saved: Mode = {
      id: isNewMode ? slugify(name) || editing.id : editing.id,
      name,
      icon: editIcon.trim() || '🤖',
      systemPrompt: prompt,
      locked: false
    };

    const updated = isNewMode
      ? [...modesRef.current, saved]
      : modesRef.current.map(m => m.id === saved.id ? saved : m);

    setModes(updated);
    persistUserModes(updated);
    setEditing(null);
    addLog(`Mode ${isNewMode ? 'created' : 'updated'}: ${name}`, 'success');
  }, [editing, editName, editIcon, editPrompt, isNewMode, persistUserModes, addLog]);

  const deleteMode = useCallback((id: string) => {
    const target = modesRef.current.find(m => m.id === id);
    if (!target || target.locked) return;
    const updated = modesRef.current.filter(m => m.id !== id);
    setModes(updated);
    persistUserModes(updated);
    if (activeModeIdRef.current === id) setActiveModeId('default');
    setEditing(null);
    addLog(`Mode deleted: ${target.name}`, 'info');
  }, [persistUserModes, addLog]);

  // ── Server socket ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active || !phoneId) {
      clientRef.current?.disconnect(); clientRef.current = null;
      setConnected(false);
      BackgroundService.stop();
      //addLog('Background Service Stopped', 'info');
      if (!active) addLog('Node offline.', 'info');
      return;
    }

    // BackgroundService.start(backgroundTask, backgroundOptions);
    // addLog('Background Service Started', 'info');
    const client = createSocketClient({
      url: SIGNAL_SERVER,
      phoneId,
      pairingCode,
      onConnect: () => addLog(`Registered as ${phoneId}`, 'info'),
      onDisconnect: () => addLog('Disconnected from switchboard.', 'error'),
      onTunnelOpen: () => { setConnected(true); addLog('Tunnel active · P2P', 'success'); },
      onTunnelClose: () => setConnected(false),
      log: addLog,
      onPacket: (packet, send) => {
        switch (packet.type) {
          case 'inference': {
            const mode = modesRef.current.find(m => m.id === activeModeIdRef.current) ?? DEFAULT_MODE;
            runInference({
              request: { ...packet, activeMode: mode }, llama: llamaRef.current, send,
              isBusy: () => inferringRef.current,
              onStart: () => { setInferring(true); inferringRef.current = true; },
              onEnd: () => { setInferring(false); inferringRef.current = false; },
              onLog: addLog,
            });
            break;
          }
          case 'command': {
            const { requestId, command, payload } = packet;
            switch (command) {
              case 'get_modes':
                send({ type: 'command_result', requestId, result: modesRef.current }); break;
              case 'upsert_mode': {
                const inc = payload as Mode;
                if (modesRef.current.find(m => m.id === inc.id)?.locked) {
                  send({ type: 'command_error', requestId, error: `Mode "${inc.id}" is locked.` }); break;
                }
                const up = [...modesRef.current.filter(m => m.id !== inc.id), inc];
                setModes(up); persistUserModes(up);
                send({ type: 'command_result', requestId, result: { ok: true } });
                addLog(`Mode saved: ${inc.name}`, 'info'); break;
              }
              case 'delete_mode': {
                const tid = payload as string;
                const t = modesRef.current.find(m => m.id === tid);
                if (!t) { send({ type: 'command_error', requestId, error: 'Not found.' }); break; }
                if (t.locked) { send({ type: 'command_error', requestId, error: 'Locked.' }); break; }
                const up = modesRef.current.filter(m => m.id !== tid);
                setModes(up); persistUserModes(up);
                if (activeModeIdRef.current === tid) setActiveModeId('default');
                send({ type: 'command_result', requestId, result: { ok: true } }); break;
              }
              case 'set_active_mode': {
                const nid = payload as string;
                const f = modesRef.current.find(m => m.id === nid);
                if (!f) { send({ type: 'command_error', requestId, error: 'Not found.' }); break; }
                setActiveModeId(nid);
                send({ type: 'command_result', requestId, result: { ok: true } });
                addLog(`Mode → ${f.icon ?? ''} ${f.name}`, 'info'); break;
              }
              default: handleCommand({ request: packet, send, onLog: addLog });
            }
            break;
          }
          default: addLog(`Unknown packet: ${packet.type}`, 'error');
        }
      },
    });

    clientRef.current = client;
    return () => { client.disconnect(); clientRef.current = null; setConnected(false); };
  }, [active, phoneId, addLog]);

  // ── Local adapter ─────────────────────────────────────────────────────────
  const localAdapter = useRef(
    createLocalAdapter({
      llamaRef, modesRef, activeModeIdRef, inferringRef,
      onStart: () => { setInferring(true); inferringRef.current = true; setClientInf(true); },
      onEnd: () => { setInferring(false); inferringRef.current = false; setClientInf(false); },
      onLog: addLog,
      onPacket: (pkt: AdapterPacket) => {
        switch (pkt.type) {
          case 'token':
            setMessages(prev => prev.map(m =>
              m.id === pkt.requestId ? { ...m, content: m.content + pkt.token } : m
            ));
            setTimeout(() => chatScrollRef.current?.scrollToEnd({ animated: false }), 0);
            break;
          case 'done':
            setMessages(prev => prev.map(m =>
              m.id === pkt.requestId ? { ...m, streaming: false, stats: pkt.stats } : m
            ));
            activeRequestId.current = null;
            break;
          case 'error':
            setMessages(prev => prev.map(m =>
              m.id === pkt.requestId ? { ...m, content: `⚠️ ${pkt.error}`, streaming: false } : m
            ));
            activeRequestId.current = null;
            break;
        }
      },
    })
  ).current;

  // ── Send local message ────────────────────────────────────────────────────
  const sendLocalMessage = useCallback(() => {
    const text = inputText.trim();
    if (!text || !llamaRef.current || clientInferring) return;
    setInputText('');
    const reqId = uid();
    activeRequestId.current = reqId;
    const history = messages.filter(m => !m.streaming).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    setMessages(prev => [
      ...prev,
      { id: uid(), role: 'user', content: text },
      { id: reqId, role: 'assistant', content: '', streaming: true },
    ]);
    localAdapter.sendPacket({ type: 'inference', requestId: reqId, messages: [...history, { role: 'user', content: text }] });
  }, [inputText, messages, clientInferring, localAdapter]);

  // ── Navigation helpers ────────────────────────────────────────────────────
  const goToPage = (p: number) => {
    pageScrollRef.current?.scrollTo({ x: p * SCREEN_W, animated: true });
    setPage(p);
  };

  const hintTranslate = swipeHintAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -22] });

  // ── Model management ──────────────────────────────────────────────────────
  const pairModel = async (path: string) => {
    try {
      addLog('Loading model…', 'info');
      llamaRef.current = await initLlama({ model: path, n_ctx: 4096, n_threads: 4, n_gpu_layers: 1, n_batch: 512 });
      await RNFS.writeFile(CONFIG_PATH, JSON.stringify({ modelPath: path }), 'utf8');
      setModelPath(path); setPhase('ready');
      addLog('Model loaded and ready.', 'success');
    } catch (e: any) { addLog(`Failed to load model: ${e.message}`, 'error'); }
  };

  const unpairModel = async () => {
    try { await llamaRef.current?.release(); } catch (_) { }
    llamaRef.current = null;
    try { await RNFS.unlink(CONFIG_PATH); } catch (_) { }
    setModelPath(null); setPhase('ready');
    addLog('Model unpaired.', 'info');
  };

  const handleDownload = async () => {
    setPhase('downloading'); setDownloadProgress(0);
    addLog('Starting Gemma 4 E2B download (~1.3 GB)…', 'info');
    try {
      if (await RNFS.exists(MODEL_PATH)) await RNFS.unlink(MODEL_PATH);
      const dl = RNFS.downloadFile({
        fromUrl: MODEL_DOWNLOAD_URL, toFile: MODEL_PATH,
        begin: res => { setTotalMB(res.contentLength / 1024 / 1024); },
        progress: res => {
          setDownloadProgress(Math.floor((res.bytesWritten / res.contentLength) * 100));
          setDownloadedMB(res.bytesWritten / 1024 / 1024);
        },
      });
      const result = await dl.promise;
      if (result.statusCode === 200) { addLog('Download complete.', 'success'); await pairModel(MODEL_PATH); }
      else throw new Error(`HTTP ${result.statusCode}`);
    } catch (e: any) {
      addLog(`Download failed: ${e.message}`, 'error');
      if (await RNFS.exists(MODEL_PATH)) await RNFS.unlink(MODEL_PATH);
      setPhase('ready');
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />

      {/*
        KeyboardAvoidingView is intentionally placed here — outside the
        horizontal paged ScrollView. On iOS, KAV must be an ancestor that
        has direct knowledge of the screen height. Nesting it inside a
        horizontal ScrollView breaks the height calculation and the keyboard
        covers the input bar. Being here, it compresses the whole layout
        upward when the keyboard opens, which is exactly what we want.
      */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <Animated.View style={[s.container, { opacity: fadeAnim }]}>

          {/* ── Header ── */}
          <View style={s.header}>
            <Text style={s.subtitle}>Good Enough Cafe</Text>
            <Text style={s.logo}>🦞</Text>
            <Text style={s.title}>CLAWDADDY</Text>
            <Text style={s.subtitle}>Personal AI Node</Text>
          </View>

          {/* ── Page dots ── */}
          <View style={s.pageIndicator}>
            <TouchableOpacity onPress={() => goToPage(0)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <View style={[s.dot, page === 0 && s.dotActive]} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => goToPage(1)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <View style={[s.dot, page === 1 && s.dotActive]} />
            </TouchableOpacity>
            {/* <Animated.Text style={[s.swipeHint, { transform: [{ translateX: hintTranslate }] }]}>
              swipe for chat
            </Animated.Text> */}
          </View>

          {/* ── Pages ── */}
          <ScrollView
            ref={pageScrollRef}
            horizontal pagingEnabled showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onMomentumScrollEnd={e => setPage(Math.round(e.nativeEvent.contentOffset.x / SCREEN_W))}
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
          >

            {/* ══ PAGE 0 · SERVER ══════════════════════════════════════════ */}
            <View style={[s.page, { width: SCREEN_W }]}>

              {phase === 'loading' && (
                <View style={s.centerCard}>
                  <Text style={s.loadingText}>Checking device…</Text>
                </View>
              )}

              {phase === 'ready' && (
                <View style={s.pairedContainer}>
                  <View style={s.toggleCard}>
                    <View style={s.toggleRow}>
                      <View>
                        <Text style={s.toggleLabel}>Broadcast Node</Text>
                        <Text style={s.toggleSub}>{active ? 'Visible to network' : 'Hidden from network'}</Text>
                      </View>
                      <Switch
                        value={active} onValueChange={setActive}
                        trackColor={{ false: '#27272a', true: '#ef4444' }}
                        thumbColor={active ? '#fff' : '#71717a'}
                      />
                    </View>
                  </View>

                  {active && (
                    <View style={s.statusRow}>
                      <Animated.View style={[
                        s.statusDot,
                        inferring && { transform: [{ scale: pulseAnim }] },
                        { backgroundColor: inferring ? '#f59e0b' : connected ? '#22c55e' : '#3f3f46' },
                      ]} />
                      <Text style={s.statusText}>
                        {inferring ? 'Inferring…' : connected ? 'Tunnel active · P2P' : 'Waiting…'}
                      </Text>
                    </View>
                  )}

                  <View style={s.idRow}>
                    <Text style={s.idLabel}>NODE ID</Text>
                    <Text style={s.idValue}>{phoneId || '--------'}</Text>
                    <TouchableOpacity onPress={refreshNodeId} style={s.refreshBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Text style={s.refreshIcon}>↻</Text>
                    </TouchableOpacity>
                  </View>

                  {/* Pairing Code row (NEW) */}
                  <View style={s.idRow}>
                    <Text style={s.idLabel}>PAIRING CODE</Text>
                    <Text style={s.idValue}>
                      {showPairingCode ? pairingCode : '••••-••••'}
                    </Text>
                    <TouchableOpacity onPress={() => setShowPairingCode(!showPairingCode)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Text style={s.refreshIcon}>{showPairingCode ? '👁' : '👁‍🗨'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={refreshPairingCode} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Text style={s.refreshIcon}>↻</Text>
                    </TouchableOpacity>
                  </View>

                  {modelPath ? (
                    <View style={s.modelBadge}>
                      <Text style={s.modelBadgeLabel}>MODEL · READY</Text>
                      <Text style={s.modelBadgeName}>{modelPath.split('/').pop()?.replace('.gguf', '') ?? 'Unknown'}</Text>
                      <TouchableOpacity onPress={unpairModel} style={{ marginTop: 10 }}>
                        <Text style={s.unpairBtnText}>Remove model</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={s.modelBadge}>
                      <Text style={s.modelBadgeLabel}>MODEL · NOT PAIRED</Text>
                      <Text style={s.cardBody}>Node can broadcast but cannot run inference until a model is paired.</Text>
                      <TouchableOpacity style={s.primaryBtn} onPress={handleDownload}>
                        <Text style={s.primaryBtnText}>📥  Download Gemma 4 E2B</Text>
                        <Text style={s.primaryBtnSub}>~1.3 GB · Q4_K_M quantized</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              )}

              {phase === 'downloading' && (
                <View style={s.downloadOverlay}>
                  <Text style={s.cardTitle}>Downloading Model</Text>
                  <Text style={s.downloadStats}>{downloadedMB.toFixed(0)} MB / {totalMB.toFixed(0)} MB</Text>
                  <View style={s.progressTrack}>
                    <View style={[s.progressFill, { width: `${downloadProgress}%` }]} />
                  </View>
                  <Text style={s.progressPct}>{downloadProgress}%</Text>
                  <Text style={s.cardBody}>Keep the app open. This only happens once.</Text>
                </View>
              )}

              {/* Log drawer */}
              <View style={[s.console, showLogs && s.consoleOpen]}>
                <TouchableOpacity style={s.consoleHandle} onPress={() => setShowLogs(v => !v)}>
                  <View style={s.consolePill} />
                  <Text style={s.consoleToggleText}>{showLogs ? 'Hide' : 'Logs'}</Text>
                </TouchableOpacity>
                {showLogs && (
                  <ScrollView ref={logScrollRef} style={s.logScroll}
                    onContentSizeChange={() => logScrollRef.current?.scrollToEnd({ animated: true })}>
                    {logs.map((e, i) => (
                      <Text key={i} style={[s.logLine, s[`log_${e.type}` as keyof typeof s] as any]}>
                        <Text style={s.logTime}>{e.time}  </Text>{e.msg}
                      </Text>
                    ))}
                  </ScrollView>
                )}
              </View>
            </View>

            {/* ══ PAGE 1 · CLIENT ══════════════════════════════════════════ */}
            <View style={[s.page, { width: SCREEN_W }]}>

              {/* ── Mode picker strip (now wraps) ── */}
              <View style={s.modePickerBar}>
                <View style={s.modePicker}>
                  {modes.map(m => (
                    <TouchableOpacity
                      key={m.id}
                      style={[s.modeChip, m.id === activeModeId && s.modeChipActive]}
                      onPress={() => { setActiveModeId(m.id); closeEdit(); }}
                      onLongPress={() => !m.locked && openEdit(m)}
                    >
                      <Text style={s.modeChipIcon}>{m.icon ?? '🤖'}</Text>
                      <Text style={[s.modeChipName, m.id === activeModeId && s.modeChipNameActive]}>
                        {m.name}
                      </Text>
                      {!m.locked && (
                        <TouchableOpacity
                          onPress={() => editing?.id === m.id ? closeEdit() : openEdit(m)}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          style={s.chipEditBtn}
                        >
                          <Text style={[s.chipEditIcon, editing?.id === m.id && s.chipEditIconActive]}>
                            {editing?.id === m.id ? '✕' : '✎'}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    style={[s.modeChip, s.modeChipNew, isNewMode && s.modeChipActive]}
                    onPress={() => isNewMode ? closeEdit() : openNew()}
                  >
                    {/* <Text style={s.modeChipIcon}>{isNewMode ? '✕' : '+'}</Text> */}
                    <Text style={s.modeChipName}>{isNewMode ? 'cancel' : 'new'}</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* ── Inline editor panel ── */}
              {editing !== null && (
                <View style={s.editorPanel}>
                  <View style={s.editorRow}>
                    {/* Icon field */}
                    <TextInput
                      style={s.editorIconInput}
                      value={editIcon}
                      onChangeText={setEditIcon}
                      maxLength={2}
                      placeholder="🤖"
                      placeholderTextColor="#3f3f46"
                    />
                    {/* Name field */}
                    <TextInput
                      style={[s.editorInput, { flex: 1 }]}
                      value={editName}
                      onChangeText={setEditName}
                      placeholder="Mode name"
                      placeholderTextColor="#3f3f46"
                      autoCapitalize="words"
                    />
                  </View>
                  {/* System prompt */}
                  <TextInput
                    style={[s.editorInput, s.editorPromptInput]}
                    value={editPrompt}
                    onChangeText={setEditPrompt}
                    placeholder="System prompt — describe how the AI should behave…"
                    placeholderTextColor="#3f3f46"
                    multiline
                    numberOfLines={3}
                  />
                  {/* Action row */}
                  <View style={s.editorActions}>
                    {!isNewMode && (
                      <TouchableOpacity
                        style={s.editorDeleteBtn}
                        onPress={() => deleteMode(editing.id)}
                      >
                        <Text style={s.editorDeleteText}>Delete</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[s.editorSaveBtn, (!editName.trim() || !editPrompt.trim()) && s.editorSaveBtnDisabled]}
                      onPress={saveEdit}
                      disabled={!editName.trim() || !editPrompt.trim()}
                    >
                      <Text style={s.editorSaveText}>{isNewMode ? 'Create' : 'Save'}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* ── Messages ── */}
              {messages.length === 0 ? (
                <View style={s.emptyChat}>
                  <Text style={s.emptyChatEmoji}>🦞</Text>
                  <Text style={s.emptyChatText}>
                    {llamaRef.current ? 'Start chatting' : 'No model loaded'}
                  </Text>
                  <Text style={s.emptyChatSub}>
                    {llamaRef.current
                      ? `Running locally · ${modes.find(m => m.id === activeModeId)?.name ?? 'Default'}`
                      : 'Swipe left → Server → download a model first'}
                  </Text>
                </View>
              ) : (
                <FlatList
                  ref={chatScrollRef}
                  data={messages}
                  keyExtractor={m => m.id}
                  contentContainerStyle={s.messageList}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => (
                    <View style={[s.msgRow, item.role === 'user' ? s.msgRowUser : s.msgRowAssistant]}>
                      <View style={[s.msgBubble, item.role === 'user' ? s.bubbleUser : s.bubbleAssistant]}>
                        <Text selectable={true} style={[s.msgText, item.role === 'user' && s.msgTextUser]}>
                          {item.content}
                          {item.streaming && <Text style={s.cursor}>▌</Text>}
                        </Text>
                      </View>
                      {item.stats && !item.streaming && (
                        <Text style={s.msgStats}>
                          {item.stats.tokens} tok · {item.stats.tps.toFixed(1)} t/s
                        </Text>
                      )}
                    </View>
                  )}
                />
              )}

              {/* ── Input bar ── */}
              <View style={s.inputBar}>
                <TextInput
                  style={s.chatInput}
                  value={inputText}
                  onChangeText={setInputText}
                  placeholder={llamaRef.current ? 'Message…' : 'No model loaded'}
                  placeholderTextColor="#3f3f46"
                  multiline
                  editable={!!llamaRef.current && !clientInferring}
                  returnKeyType="send"
                  onSubmitEditing={sendLocalMessage}
                  blurOnSubmit={false}
                  onFocus={() => setEditing(null)} // close editor when keyboard opens
                />
                <TouchableOpacity
                  style={[s.sendBtn, (!llamaRef.current || clientInferring || !inputText.trim()) && s.sendBtnDisabled]}
                  onPress={sendLocalMessage}
                  disabled={!llamaRef.current || clientInferring || !inputText.trim()}
                >
                  <Text style={s.sendBtnText}>{clientInferring ? '…' : '↑'}</Text>
                </TouchableOpacity>
              </View>

            </View>
            {/* ════════════════════════════════════════════════════════════ */}

          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  container: { flex: 1 },
  page: { flex: 1 },

  // Header
  header: { alignItems: 'center', paddingTop: 44, paddingBottom: 6 },
  logo: { fontSize: 38, marginBottom: 4 },
  title: { fontSize: 24, fontWeight: '900', color: '#ef4444', letterSpacing: 8 },
  subtitle: { fontSize: 10, color: '#52525b', letterSpacing: 4, marginTop: 2, textTransform: 'uppercase' },

  // Page indicator
  pageIndicator: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingVertical: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#52525b' },
  dotActive: { width: 18, height: 6, borderRadius: 3, backgroundColor: '#ef4444' },
  swipeHint: { position: 'absolute', right: 20, fontSize: 10, color: '#52525b', letterSpacing: 0.5 },

  // Server page
  centerCard: { flex: 1, marginHorizontal: 24, justifyContent: 'center' },
  loadingText: { color: '#52525b', fontSize: 14, textAlign: 'center' },
  pairedContainer: { flex: 1, paddingHorizontal: 22, paddingTop: 6 },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#f4f4f5', marginBottom: 8 },
  cardBody: { fontSize: 13, color: '#71717a', lineHeight: 20, marginBottom: 18 },
  primaryBtn: { backgroundColor: '#ef4444', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 18, alignItems: 'center', marginBottom: 10 },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  primaryBtnSub: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 3 },
  toggleCard: { backgroundColor: '#18181b', borderRadius: 14, padding: 18, borderWidth: 1, borderColor: '#27272a', marginBottom: 14 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleLabel: { color: '#f4f4f5', fontSize: 15, fontWeight: '600', marginBottom: 2 },
  toggleSub: { color: '#52525b', fontSize: 11 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  statusText: { color: '#a1a1aa', fontSize: 13 },
  idRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18, paddingHorizontal: 2 },
  idLabel: { color: '#52525b', fontSize: 10, letterSpacing: 3, fontWeight: '700' },
  idValue: { color: '#52525b', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', flex: 1 },
  refreshBtn: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#27272a', alignItems: 'center', justifyContent: 'center' },
  refreshIcon: { color: '#71717a', fontSize: 13, lineHeight: 16 },
  modelBadge: { backgroundColor: '#18181b', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 10, borderWidth: 1, borderColor: '#27272a' },
  modelBadgeLabel: { color: '#52525b', fontSize: 9, letterSpacing: 3, fontWeight: '700', marginBottom: 4 },
  modelBadgeName: { color: '#e4e4e7', fontSize: 12, fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  unpairBtnText: { color: '#3f3f46', fontSize: 11 },
  downloadStats: { color: '#a1a1aa', fontSize: 12, marginBottom: 10 },
  progressTrack: { height: 5, backgroundColor: '#27272a', borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  progressFill: { height: '100%', backgroundColor: '#ef4444', borderRadius: 3 },
  progressPct: { color: '#ef4444', fontWeight: '700', fontSize: 12, marginBottom: 16 },
  downloadOverlay: { position: 'absolute', inset: 0, backgroundColor: '#0a0a0a', justifyContent: 'center', paddingHorizontal: 24 },

  // Log drawer
  console: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#111', borderTopWidth: 1, borderTopColor: '#1a1a1a', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '45%', paddingBottom: 20 },
  consoleOpen: { height: '45%' },
  consoleHandle: { alignItems: 'center', paddingVertical: 10 },
  consolePill: { width: 30, height: 3, backgroundColor: '#27272a', borderRadius: 2, marginBottom: 4 },
  consoleToggleText: { color: '#ef4444', fontSize: 10, letterSpacing: 2, fontWeight: '700', textTransform: 'uppercase' },
  logScroll: { paddingHorizontal: 14 },
  logLine: { fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 3, lineHeight: 16 },
  logTime: { color: '#3f3f46' },
  log_info: { color: '#71717a' },
  log_success: { color: '#22c55e' },
  log_error: { color: '#ef4444' },
  log_data: { color: '#f59e0b' },

  // Client page — mode picker bar
  modePickerBar: { borderBottomWidth: 1, borderBottomColor: '#18181b', maxHeight: 120 },
  modePicker: { paddingHorizontal: 14, paddingVertical: 10, gap: 8, flexDirection: 'row', flexWrap: 'wrap' },
  modeChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 6, borderRadius: 20, backgroundColor: '#18181b', borderWidth: 1, borderColor: '#27272a' },
  modeChipActive: { borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.07)' },
  modeChipNew: { borderStyle: 'dashed' },
  modeChipIcon: { fontSize: 13 },
  modeChipName: { fontSize: 11, color: '#52525b', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  modeChipNameActive: { color: '#f59e0b' },
  chipEditBtn: { marginLeft: 2 },
  chipEditIcon: { fontSize: 11, color: '#3f3f46' },
  chipEditIconActive: { color: '#f59e0b' },

  // Inline editor panel
  editorPanel: { backgroundColor: '#0f0f0f', borderBottomWidth: 1, borderBottomColor: '#1a1a1a', padding: 14, gap: 10 },
  editorRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  editorIconInput: { width: 44, height: 44, backgroundColor: '#18181b', borderWidth: 1, borderColor: '#27272a', borderRadius: 10, textAlign: 'center', fontSize: 20, color: '#e4e4e7' },
  editorInput: { backgroundColor: '#18181b', borderWidth: 1, borderColor: '#27272a', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, color: '#e4e4e7', fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  editorPromptInput: { height: 80, textAlignVertical: 'top', paddingTop: 10 },
  editorActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  editorDeleteBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#3f3f46' },
  editorDeleteText: { color: '#ef4444', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  editorSaveBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, backgroundColor: '#ef4444' },
  editorSaveBtnDisabled: { backgroundColor: '#27272a' },
  editorSaveText: { color: '#fff', fontSize: 12, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  // Client page — empty state
  emptyChat: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyChatEmoji: { fontSize: 42, opacity: 0.2 },
  emptyChatText: { fontSize: 13, color: '#3f3f46', letterSpacing: 1 },
  emptyChatSub: { fontSize: 11, color: '#27272a', textAlign: 'center', paddingHorizontal: 40, lineHeight: 17 },

  // Client page — messages
  messageList: { padding: 16, gap: 12, flexGrow: 1 },
  msgRow: { maxWidth: '84%' },
  msgRowUser: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  msgRowAssistant: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  msgBubble: { borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14 },
  bubbleUser: { backgroundColor: '#ef4444' },
  bubbleAssistant: { backgroundColor: '#18181b', borderWidth: 1, borderColor: '#27272a' },
  msgText: { fontSize: 14, color: '#e4e4e7', lineHeight: 22 },
  msgTextUser: { color: '#fff' },
  cursor: { color: '#22c55e' },
  msgStats: { fontSize: 10, color: '#3f3f46', marginTop: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  // Client page — input
  inputBar: { flexDirection: 'row', padding: 12, gap: 10, borderTopWidth: 1, borderTopColor: '#18181b', backgroundColor: '#0a0a0a', alignItems: 'flex-end' },
  chatInput: { flex: 1, backgroundColor: '#18181b', borderWidth: 1, borderColor: '#27272a', borderRadius: 20, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, color: '#e4e4e7', fontSize: 14, maxHeight: 120 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#ef4444', alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: '#1f1f1f' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700', lineHeight: 22 },
} as any);

export default App;