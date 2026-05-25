# 🦞 Clawdaddy

**Run local LLMs on your own hardware. Access them from anywhere. No middlemen.**

Clawdaddy is an open source P2P tunnel for local AI inference. Pair your laptop with your home server, your phone with your desktop, or share access with friends, all over a direct encrypted connection that never passes through anyone's cloud.

The long-term idea: a world where you don't need a data center to run AI. Anyone with a decent GPU can be a node. Anyone with a phone can be a client. The switchboard that helps peers find each other is open source too — run your own, or use ours. No accounts, no subscriptions, no company in the middle reading your prompts.

We're early. Come help build it → [github.com/Good-Enough-Cafe-LLC/clawdaddy](https://github.com/Good-Enough-Cafe-LLC/clawdaddy)

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

## Requirements

- Node.js 18+
- [Ollama](https://ollama.ai) running locally (for `serve`)

---

## Install

```bash
npm install -g clawdaddy
```

---

## Quick start

**On the machine with your GPU:**
```bash
ollama pull llama3.2
clawdaddy serve llama3.2
# prints your node ID and pairing code
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

## Features

- **True P2P** — inference never touches a relay after the handshake
- **OpenAI + Anthropic compatible API** — works with Claude Code, Continue, or any OpenAI client
- **Mobile node** — run a serve node from your phone via the React Native app
- **Multi-client** — multiple simultaneous connections with per-session memory isolation
- **Persistent memory** — long-term memory (LTM) extracted from conversation and persisted per client, short-term memory (STM) survives reconnects
- **Command layer** — send control commands through the tunnel, hook into external agents via a watched log file
- **Bring your own switchboard** — self-host the signaling server, point both sides at it

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

`POST /v1/command` exposes the same interface over HTTP locally if you want to drive commands from scripts without a tunnel.

---

## Running a serve node persistently (pm2)

```bash
npm install -g clawdaddy pm2
pm2 start clawdaddy --name "clawdaddy-serve" -- serve llama3.2
pm2 save
pm2 startup
```

```bash
pm2 logs clawdaddy-serve     # tail logs
pm2 restart clawdaddy-serve  # restart after config change
pm2 stop clawdaddy-serve     # stop
```

---

## Running your own switchboard

The switchboard is open source and included in the repo. It's a simple Socket.IO signaling relay — it brokers the WebRTC handshake and then gets out of the way, holding no persistent state.

```bash
git clone https://github.com/Good-Enough-Cafe-LLC/clawdaddy
cd clawdaddy/signaling/signaling
npm install
pm2 start npx --name "clawdaddy-signaling" -- tsx server.ts
```

Then point both sides at your instance:

```json
// ~/.clawdaddy/serve-config.json
{ "signalServer": "https://your-switchboard.example.com" }

// ~/.clawdaddy/client-config.json
{ "signalServer": "https://your-switchboard.example.com" }
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

## License

MIT — [github.com/Good-Enough-Cafe-LLC/clawdaddy](https://github.com/Good-Enough-Cafe-LLC/clawdaddy)