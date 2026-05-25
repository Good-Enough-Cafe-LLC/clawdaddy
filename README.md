# 🦞 Clawdaddy

**Run local LLMs on your own hardware. Access them from anywhere. No middlemen.**

Clawdaddy is an open source P2P tunnel for local AI inference. Pair your laptop with your home server, your phone with your desktop, or share access with friends, all over a direct encrypted connection that never passes through anyone's cloud.

The long-term idea: a world where you don't need a data center to run AI. Anyone with a decent GPU can be a node. Anyone with a phone can be a client. The switchboard that helps peers find each other is open source too — run your own, or use ours. No accounts, no subscriptions, no company in the middle reading your prompts.

We're early. Come help build it.

---

## How it works

```
[you, anywhere]
      |
      |  WebSocket (signaling only — finding each other)
      v
[switchboard]  ← run yours or use clawdaddyswitch01.goodenoughcafe.com
      |
      |  WebRTC offer/answer exchange
      v
[your node]  ← your machine, your GPU, running Ollama
```

Once the tunnel is established the switchboard drops out entirely. All inference traffic is direct, end-to-end encrypted P2P. The switchboard never sees your messages, your model, or anything except a one-way hash used to verify the handshake.

---

## What's in this repo

| Package | Description |
|---|---|
| `packages/core` | Shared protocol — chunking, crypto, constants |
| `packages/serve` | Server node — runs on your GPU machine alongside Ollama |
| `packages/cli` | Client — interactive console, OpenAI-compatible API mode |
| `signaling/` | Switchboard server — the WebSocket relay that brokers handshakes |
| `mobile/` | React Native app — use your phone as a server node (llama.rn) |

Everything is MIT licensed. Fork it, run it, extend it.

---

## Features

- **True P2P** — inference never touches a relay after the handshake
- **OpenAI + Anthropic compatible API** — works with Claude Code, Continue, or any OpenAI client
- **Mobile node** — run a serve node from your phone via the React Native app
- **Multi-client** — multiple simultaneous connections with per-session memory isolation
- **Persistent memory** — long-term memory (LTM) extracted from conversation and persisted per client, short-term memory (STM) survives reconnects
- **Command layer** — send control commands through the tunnel, hook into external agents via a watched log file
- **Bring your own switchboard** — self-host the signaling server, point both sides at it

---

## Quick start (installed from npm)

**Requirements:** Node.js 18+, [Ollama](https://ollama.ai)

```bash
npm install -g clawdaddy
```

**On the machine with your GPU:**
```bash
ollama pull llama3.2
clawdaddy serve llama3.2
```

**From anywhere else:**
```bash
clawdaddy pair <nodeId> <pairingCode>
clawdaddy console          # interactive chat
clawdaddy api              # OpenAI-compatible API on localhost:3001
clawdaddy web              # browser UI
```

**Same machine — skip the switchboard and WebRTC entirely:**
```bash
clawdaddy serve llama3.2 --local-only
clawdaddy console --local
clawdaddy api --local
```

---

## Local development

**Requirements:** Node.js 18+, npm 9+

```bash
git clone https://github.com/Good-Enough-Cafe-LLC/clawdaddy
cd clawdaddy

# Build core first — other packages depend on it
npm run build -w @clawdaddy/core

# Build everything else
cd packages && npm install && npm run build

# Link globally so you can use the clawdaddy command locally
npm link
```

Rebuild after changes:
```bash
cd packages && npm run build
```

No need to re-link after a rebuild — the global symlink points at the local `dist/` directory.

**Run the serve node without linking:**
```bash
cd packages
npm run dev -- serve llama3.2
```

**Run the switchboard locally:**
```bash
cd signaling/signaling
npm install
npx tsx server.ts
```

---

## Running your own switchboard

The switchboard is a simple Socket.IO signaling relay. It brokers the WebRTC handshake and then gets out of the way, holding no persistent state.

```bash
cd signaling/signaling
npm install
pm2 start npx --name "clawdaddy-signaling" -- tsx server.ts
pm2 save
pm2 startup
```

Then point both sides at your instance:

```json
// ~/.clawdaddy/serve-config.json
{ "signalServer": "https://your-switchboard.example.com" }

// ~/.clawdaddy/client-config.json
{ "signalServer": "https://your-switchboard.example.com" }
```

---

## The command layer

Prefix any message with `/cmd` to send a control command instead of triggering inference:

```
/ping                                       check the node is alive
/get_status                                 connections, memory, rate limits
/get_memory                                 system prompt + LTM + STM in one call
/get_ltm                                    long-term memory facts
/set_ltm_fact {"key":"name","value":"X"}    manually set a memory fact
/clear_ltm                                  wipe long-term memory
/clear_memory                               wipe short-term (conversation) memory
/set_system_prompt <text>                   change personality mid-session
/get_system_prompt                          read current system prompt
/echo <message>                             sanity check the tunnel
```

Log commands are written to `command_log.jsonl` as newline-delimited JSON — the hook for external agents:

```bash
tail -f ~/.clawdaddy/command_log.jsonl | while read line; do
  # your agent logic here
done
```

---

## Configuration

Config files live in `~/.clawdaddy/` and are written on first run.

**`serve-config.json`**
```json
{
  "nodeId": "auto-generated",
  "pairingCode": "auto-generated",
  "model": "llama3.2",
  "maxConnections": 3,
  "contextWindow": 8192,
  "signalServer": "https://clawdaddyswitch01.goodenoughcafe.com"
}
```

**`client-config.json`**
```json
{
  "signalServer": "https://clawdaddyswitch01.goodenoughcafe.com",
  "defaultMaxTokens": 1024,
  "defaultTemperature": 0.7
}
```

**`clients/<clientId>/`** — per-client persistent memory:
- `system_prompt.txt` — current system prompt for this client
- `ltm.json` — long-term memory facts
- `stm.json` — recent conversation history

---

## Publishing to npm

```bash
cd packages
npm run prepare-release   # builds and sets executable bit
npm publish
```

Bump the version in `packages/package.json` before publishing.

---

## Contributing

Issues, PRs, and node operators all welcome. The most useful things right now:

- **Run a node** — more nodes makes the network more useful for everyone
- **Bug reports** — especially around reconnection, chunking, and mobile
- **Switchboard operators** — run your own and tell us about it

---

## License

MIT — [github.com/Good-Enough-Cafe-LLC/clawdaddy](https://github.com/Good-Enough-Cafe-LLC/clawdaddy)