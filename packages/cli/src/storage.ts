// src/storage.ts
//
// Manages persisted client state:
//   - Paired node credentials (~/.clawdaddy/nodes.json)
//   - Stable client ID (~/.clawdaddy/client-id.json)
//
// The client ID is a secret used to identify this client to servers so they
// can load persisted memory (system prompt, LTM) for this client.
// It is transmitted only over the already-authenticated encrypted channel.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

const CONFIG_DIR    = path.join(os.homedir(), '.clawdaddy');
const NODES_FILE    = path.join(CONFIG_DIR, 'nodes.json');
const CLIENT_ID_FILE = path.join(CONFIG_DIR, 'client-id.json');

function ensureConfigDir(): void {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

export interface StoredNode {
    id:            string;
    pairingCode:   string;
    lastConnected: string | null;
    pairedAt:      string;  // ← ADD THIS
}

export function loadNodes(): Map<string, StoredNode> {
    try {
        if (fs.existsSync(NODES_FILE)) {
            const raw: any[] = JSON.parse(fs.readFileSync(NODES_FILE, 'utf-8'));
            // Handle migration for existing nodes without pairedAt
            const migrated = raw.map(n => ({
                ...n,
                pairedAt: n.pairedAt || new Date(0).toISOString() // Old nodes get epoch time
            }));
            return new Map(migrated.map(n => [n.id, n]));
        }
    } catch (_) {}
    return new Map();
}

export function addOrUpdateNode(id: string, pairingCode: string): void {
    const nodes = loadNodes();
    const existing = nodes.get(id);
    
    if (existing) {
        // Update existing - preserve pairedAt
        nodes.set(id, { 
            ...existing,
            pairingCode,
            lastConnected: existing.lastConnected ?? null
        });
    } else {
        // New node - set pairedAt to now
        nodes.set(id, { 
            id, 
            pairingCode, 
            lastConnected: null,
            pairedAt: new Date().toISOString()  // ← SET PAIR TIME
        });
    }
    
    saveNodes(nodes);
}

function saveNodes(nodes: Map<string, StoredNode>): void {
    ensureConfigDir();
    
    // Sort by pairedAt (newest first) before saving
    const nodesArray = Array.from(nodes.values());
    nodesArray.sort((a, b) => {
        // Sort by pairedAt (most recent first)
        return new Date(b.pairedAt).getTime() - new Date(a.pairedAt).getTime();
    });
    
    fs.writeFileSync(NODES_FILE, JSON.stringify(nodesArray, null, 2));
}

export function removeNode(id: string): void {
    const nodes = loadNodes();
    nodes.delete(id);
    saveNodes(nodes);
}

export function listNodes(): StoredNode[] {
    return [...loadNodes().values()];
}

export function getNode(id: string): StoredNode | undefined {
    return loadNodes().get(id);
}

export function updateLastConnected(id: string): void {
    const nodes = loadNodes();
    const node = nodes.get(id);
    if (node) {
        node.lastConnected = new Date().toISOString();
        nodes.set(id, node);
        
        // Sort by lastConnected (most recent first) AND pairedAt as secondary
        const nodesArray = Array.from(nodes.values());
        nodesArray.sort((a, b) => {
            // Primary sort: lastConnected (most recent first)
            if (a.lastConnected && b.lastConnected) {
                return new Date(b.lastConnected).getTime() - new Date(a.lastConnected).getTime();
            }
            // Nodes that have been connected come before never-connected
            if (a.lastConnected && !b.lastConnected) return -1;
            if (!a.lastConnected && b.lastConnected) return 1;
            // Secondary sort: pairedAt for never-connected nodes
            return new Date(b.pairedAt).getTime() - new Date(a.pairedAt).getTime();
        });
        
        // Save the re-sorted array
        fs.writeFileSync(NODES_FILE, JSON.stringify(nodesArray, null, 2));
    }
}

// ─── Client ID ────────────────────────────────────────────────────────────────
// The client ID is a stable secret that identifies this client to servers.
// Servers use it to load persisted memory (system prompt, LTM) for this client.
//
// Precedence:
//   1. --client-id <value> passed on the CLI
//   2. Saved value in ~/.clawdaddy/client-id.json
//   3. Newly generated UUID (saved for future use)

interface ClientIdFile {
    clientId:  string;
    createdAt: string;
}

export function getOrCreateClientId(override?: string): string {
    // 1. Explicit override from --client-id flag
    if (override) return override;

    ensureConfigDir();

    // 2. Saved value
    if (fs.existsSync(CLIENT_ID_FILE)) {
        try {
            const data: ClientIdFile = JSON.parse(fs.readFileSync(CLIENT_ID_FILE, 'utf-8'));
            if (data.clientId && data.clientId.length >= 8) return data.clientId;
        } catch (_) {}
    }

    // 3. Generate and save a new one
    const clientId = randomUUID();
    const data: ClientIdFile = { clientId, createdAt: new Date().toISOString() };
    fs.writeFileSync(CLIENT_ID_FILE, JSON.stringify(data, null, 2));
    console.log(`🔑 Generated new client ID: ${clientId.slice(0, 8)}... (saved to ~/.clawdaddy/client-id.json)`);
    return clientId;
}

export function getClientIdPath(): string {
    return CLIENT_ID_FILE;
}