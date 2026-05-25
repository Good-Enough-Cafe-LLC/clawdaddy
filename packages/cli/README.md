# 🦞 Clawdaddy

**Your GPU. Your models. Accessible from anywhere.**

Clawdaddy lets you run local LLMs on your own hardware and access them securely from anywhere.

No cloud, no API costs, and no data passing through anyone else's servers.

It exposes an OpenAI and Claude compatible API for tools like Claude Code, and goes beyond inference with a command layer for triggering workflows and agents on your host machine.

---

## Why

Most “run LLMs locally” tools stop at localhost. Making them accessible remotely usually means opening ports, configuring reverse proxies, or routing traffic through a cloud relay.

Clawdaddy skips all of that.

Both sides connect briefly to a lightweight switchboard to exchange WebRTC handshake data, then establish a direct peer-to-peer tunnel. After that, the switchboard is out of the picture.

- **No Infrastructure Costs:** No API bills, no hosted servers. You run everything on hardware you already own.
- **OpenAI-Compatible by Default:** Clawdaddy exposes a local API that matches the OpenAI spec, so it drops into existing tools (like Claude Code or local agents) without modification.
- **More Than Chat:** In addition to inference, a command layer lets you trigger remote workflows and agent-style tasks on your host machine.
- **End-to-End Privacy:** Prompts and responses never pass through a central server. After the handshake, all traffic is strictly peer-to-peer.

---

## What's in the box

This repo is the **CLI client** — the piece you run on the device you want to chat from or connect your tools to.

The **serve node** runs on the machine with your GPU and is available from the same npm package:

```bash
npm install -g clawdaddy
```

---

## Quick start

**On your host machine:**

```bash
ollama pull llama3.2 # or any model you like
npm install -g clawdaddy
clawdaddy serve llama3.2
# outputs your node ID and pairing code
```

**On your laptop, phone, wherever:**

Pair to your server
```bash
npm run build
npm run pair <nodeId> <pairingCode>
```

Then start a client in API mode
```bash
npm run api #-- -node <nodeId>
```

Run commands via curl
```
curl -N -X POST http://localhost:3001/v1/messages   -H "Content-Type: application/json"   -d '{
    "model": "llama3.2",
    "messages": [{"role": "user", "content": "is there life on mars"}],
    "stream": true,
    "max_tokens": 100
  }'
```

Or run an interactive console:

```bash
npm run console #-- -node <nodeId>
```

Or host a client website:

```bash
npm build webbuild
npm run web
```

> They find each other through the switchboard, complete the handshake, and then communicate directly.

You can also connect from a browser by visiting: https://clawdaddy.goodenoughcafe.com or fork and host your own web cient from the web-cli in [github.com/Good-Enough-Cafe-LLC/clawdaddy](https://github.com/Good-Enough-Cafe-LLC/clawdaddy)

---

## How the tunnel works

```
[you]  ---- WebSocket (signal only) ---->  [switchboard]
  |                                              |
  |         <-- WebRTC offer/answer -->          |
  |                                              |
  +------------ P2P data channel ----------- [your host]
                 (HMAC-signed, chunked)
```

**Privacy by design**: The switchboard only ever sees a one-way hash derived from your pairing code. It cannot authenticate as either side, cannot read your traffic, and has no record of what models you're running.

Once the tunnel is established the switchboard is gone from the equation. Large messages (tool calls, file context, long completions) are automatically split into 12KB frames, reassembled on the other end, and verified with HMAC before processing. The serve node handles multiple simultaneous clients with per-connection generation tracking, so stale reconnects never clobber an active session.

---

## Features

- **True P2P:** inference traffic never touches a relay server
- **Zero cost:** no API fees, no subscriptions, your hardware does the work
- **OpenAI-compatible API:** drop in to Claude Code, Continue, or any OpenAI client
- **Resilient:** exponential backoff on both sides, survives flaky connections
- **Multi-client support:** concurrent connections with generation-aware session management
- **Large Payload Support:** handles large context windows cleanly, no WebRTC size limits in practice
- **Secure:** every message signed with a key derived from your pairing code

---

## Start a local client/server and skip the switchboard and webRTC protocol

```bash
clawdaddy-server start --local-only
npm run console --local
npm run api --local #--port 3001
```

## Beyond chat — the command layer

Clawdaddy isn't just an inference tunnel. Prefix any message with `/cmd` to send a control command to your serve node instead of triggering inference:

```
/ping                           check the node is alive
/get_status                     model, memory, active connections
/clear_memory                   wipe conversation history
/set_system_prompt <text>       swap personality mid-session
/get_system_prompt              Check system prompt
/echo <message>                 sanity check the tunnel
/log <message>                  write message to file command_log.jsonl
/get_memory                     Get everything at once
/get_ltm                        Get only the long term memory
/set_ltm_fact {"key":"name","value":"Alice"} Manually set a fact to test LTM
/clear_ltm                      Clear just LTM
```

**The Agent Hook:** Any log command is written to command_log.jsonl as newline-delimited JSON. You can build agents that watch this log and trigger real-world actions:

```bash
tail -f ~/.clawdaddy/serve.log | jq . | while read line; do
  # your agent logic here
done
```

Send `/cmd start_job` from your phone. The host logs it. Your script picks it up and kicks off a workflow. No webhooks, no polling, no separate message broker — the log file is the bus.

The serve node also exposes `POST /v1/command` over HTTP locally if you want to drive commands from scripts on the same machine without going through the tunnel.

---

## Configuration

First run writes `~/.clawdaddy/client-config.json` with sensible defaults. Edit it to point at your own switchboard, tune reconnect timing, or adjust inference defaults. It's just JSON.


---

## Contributing

Clawdaddy is a "Good Enough" project, but we're happy to make it better. If you find a bug or have an idea for a new command, feel free to open an issue or a Pull Request.

1. **Fork the repo** and create your branch from `main`.
2. If you've added code that should be tested, **add some tests**.
3. Ensure the **linter and build** pass.
4. Open a **Pull Request** describing your changes.

---

## Built by

[@zpollock](https://github.com/zpollock) / [Good Enough Cafe](https://github.com/Good-Enough-Cafe-LLC)

---

## License

MIT