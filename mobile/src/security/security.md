# 🔐 Clawdaddy Network Security

This project uses a **lightweight pairing-based security model** to protect communication between a client and a personal AI node (phone).

The design avoids accounts, databases, and complex auth systems, while still providing strong protection against unauthorized access.

---

## 🧠 Overview

Each node (phone) is protected by a **pairing code**.

To connect:

1. The user provides:

   * `phoneId`
   * `pairingCode`
2. Both client and phone independently derive a shared secret
3. The switchboard verifies access
4. A secure peer-to-peer (WebRTC) tunnel is established

---

## 🔑 Key Concepts

### 1. Pairing Code (Human Secret)

A short code like:

```
AB12-CD34
```

* Shown on the phone
* Entered by the client
* Can be regenerated at any time

---

### 2. Shared Key (Derived Secret)

Both sides compute:

```
sharedKey = PBKDF2(pairingCode, phoneId)
```

* Never transmitted
* Used for cryptographic operations
* Unique per device + pairing code

---

### 3. Auth Hash (Switchboard Gate)

```
authHash = sha256(sharedKey)
```

* Sent to the switchboard
* Used to verify access before allowing connection
* Prevents unauthorized clients from initiating WebRTC

---

## 🌐 Connection Flow

### Step 1 — Phone Registers

Phone connects to switchboard:

```
register({
  deviceId: phoneId,
  authHash
})
```

---

### Step 2 — Client Requests Connection

Client sends signaling messages:

```
signal({
  targetId: phoneId,
  signalData,
  authHash
})
```

---

### Step 3 — Switchboard Validates

Switchboard checks:

```
client.authHash === stored.authHash
```

If valid:

* forwards WebRTC signaling
* otherwise drops request silently

---

### Step 4 — WebRTC Tunnel Established

Once signaling succeeds:

* a direct P2P connection is created
* switchboard is no longer involved

---

## 🔐 Data Channel Security (Next Layer)

After connection, all packets will be secured using the shared key:

```
signature = HMAC(sharedKey, payload)
```

Each message:

```
{
  payload,
  signature
}
```

This ensures:

* ✅ authenticity (sender is trusted)
* ✅ integrity (data not modified)
* ✅ replay protection (when combined with timestamps/counters)

---

## 🛡️ Security Properties

### ✅ What This Protects Against

* Unauthorized connection attempts
* Random scanning / brute-force access
* Switchboard abuse
* Message tampering (with HMAC layer)

---

### ⚠️ What It Does NOT Do

* No user accounts or identity system
* No end-to-end encryption beyond WebRTC (relies on WebRTC’s DTLS)
* No protection if pairing code is shared or compromised

---

## 🔄 Key Rotation

Regenerating the pairing code:

* Generates a new `sharedKey`
* Changes `authHash`
* Immediately invalidates all existing clients

---

## 🧠 Design Philosophy

* **Local-first**: your phone is the authority
* **No accounts**: no login, no cloud identity
* **Simple mental model**: pairing code = access
* **Composable**: stronger crypto layers can be added without redesign

---

## 🚀 Summary

```
pairingCode + phoneId
        ↓
   sharedKey
        ↓
    authHash  → switchboard gate
        ↓
   WebRTC tunnel
        ↓
   HMAC-secured messages
```

---

This system provides a **practical balance of simplicity and security** for personal, peer-to-peer AI nodes without introducing heavy infrastructure.




┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Phone     │     │ Switchboard │     │   Client    │
│  (Host)     │     │  (Server)   │     │ (Laptop)    │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │                    │
      │  register(phoneId,authHash)           │
      │──────────────────>│                   │
      │                   │  register(laptop-initiator,authHash)
      │                   │<──────────────────│
      │                   │                   │
      │                   │    WebRTC Offer   │
      │                   │<──────────────────│
      │    WebRTC Offer   │                   │
      │<──────────────────│                   │
      │                   │                   │
      │    WebRTC Answer  │                   │
      │──────────────────>│                   │
      │                   │    WebRTC Answer  │
      │                   │──────────────────>│
      │                   │                   │
      │         ICE Candidates (P2P)          │
      │<═════════════════════════════════════>│
      │                   │                   │
      │     🔒 HMAC-SHA256 Encrypted P2P Channel 🔒    │
      │<═════════════════════════════════════════════>│


Security layers now active:
PBKDF2 — Derives shared key from pairing code (100k iterations)

Auth hash — Switchboard verification without exposing shared key

WebRTC DTLS — Transport layer encryption

HMAC-SHA256 — Message authentication on every packet

The full stack:
Phone: React Native + WebRTC + local LLM inference

Switchboard: Node.js + Socket.io (stateless, only signaling)

Client: Node.js CLI + API server (OpenAI/Anthropic compatible)

Web UI: HTML/JS client that talks to the CLI API server      
