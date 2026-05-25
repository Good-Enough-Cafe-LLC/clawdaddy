#!/usr/bin/env node
import { Command } from 'commander';
import { startClient } from './cli/src/connection';
import { createLocalTransport } from './cli/src/localTransport';
import { startApiMode } from './cli/src/api';
import { getOrCreateClientId, addOrUpdateNode, removeNode, listNodes, getNode } from './cli/src/storage';
import { normalizeTarget, normalizeCode, isValidTarget, isValidCode } from './cli/src/validation';
import { getConfig } from './cli/src/config';
import { runServe } from './serve/src/index';
import type { PairedHost } from './cli/src/types';

import { exec } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const program = new Command();

program
  .name('clawdaddy')
  .description('P2P tunnel for local LLMs')
  .version('1.0.12');

function printHelp(): void {
  console.log(`
🦞 Clawdaddy CLI

Usage:
  clawdaddy <command> [options]

Commands:
  pair <nodeId> <code>     Pair with a serve node
  unpair <nodeId>          Remove a paired node
  list                     List all paired nodes
  console [options]        Start interactive REPL mode
  api [options]            Start local API server
  serve <model> [options]  Start a serve node (runs Ollama model)

Options:
  -h, --help               Show this help message

Interactive Mode Commands (when running 'console'):
  /ping                    Check if host is responsive
  /get_status              Get host status and stats
  /get_memory_stats        Show conversation memory usage
  /clear_memory            Clear conversation history
  /set_system_prompt <text> Change system prompt/personality
  /help                    Show help message

Examples:
  clawdaddy pair ab12-34cd AB12-CD34
  clawdaddy list
  clawdaddy console                              # remote, uses first paired node
  clawdaddy console --node ab12-34cd            # remote, specific node
  clawdaddy console --local                     # local, auto-discovers server
  clawdaddy console --local --node ab12-34cd    # local, specific server
  clawdaddy api --port 3002
  clawdaddy api --local --port 3001
  clawdaddy serve llama3.2
  clawdaddy serve llama3.2 --local-only
`);
}

if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length === 2) {
  printHelp();
  process.exit(0);
}

// ─── Local socket discovery ───────────────────────────────────────────────────
// In local mode we don't need a paired node — we look for running server
// sockets in the system temp directory. If there's exactly one, use it.
// If there are multiple, require --node to disambiguate.

async function resolveLocalHostId(nodeId?: string): Promise<string> {
  if (nodeId) {
    // Caller specified a node ID — normalize it and trust it
    return nodeId.trim().toUpperCase();
  }

  // Auto-discover by scanning for clawdaddy-*.sock files in tmpdir
  const tmpDir  = os.tmpdir();
  const sockets = fs.readdirSync(tmpDir)
    .filter(f => f.startsWith('clawdaddy-') && f.endsWith('.sock'))
    .map(f => f.slice('clawdaddy-'.length, -'.sock'.length));

  if (sockets.length === 0) {
    console.error('❌ No local server found.');
    console.error('   Start one with: clawdaddy serve <model>');
    console.error('   Or:             clawdaddy-serve start');
    process.exit(1);
  }

  if (sockets.length === 1) {
    console.log(`📌 Found local server: ${sockets[0]}`);
    return sockets[0];
  }

  // More than one — list them and ask the user to be explicit
  console.error('❌ Multiple local servers found. Specify one with --node:');
  sockets.forEach(s => console.error(`   clawdaddy console --local --node ${s}`));
  process.exit(1);
}

// ─── Local connection helper ──────────────────────────────────────────────────
// Connects to the server Unix socket. The transport singleton takes care of
// routing so startInteractiveMode / startApiMode don't change at all.

// ─── Local connection helper ──────────────────────────────────────────────────
async function connectLocalAndRun(
  hostId:      string,
  clientId:    string, // 👈 Added parameter
  onConnected: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    const transport = createLocalTransport({
      hostId,
      onConnect: async () => { // 👈 Added async to try loading memory
        try {
          const { sendCommand } = await import('./cli/src/transport');
          const result = await sendCommand('identify', { clientId });
          if (result?.ltmFacts > 0) {
            console.log(`🧠 Server loaded ${result.ltmFacts} LTM facts`);
          }
        } catch (_) {
          // Fallback for older servers
        }
        onConnected();
      },
      onClose: () => {
        console.log('\n🔌 Local server disconnected.');
        resolve();
      },
      log: (msg, type) => {
        const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : '📡';
        console.log(`${prefix} ${msg}`);
      },
    });

    process.on('SIGINT', () => {
      transport.disconnect();
      resolve();
    });
  });
}

// ─── pair ─────────────────────────────────────────────────────────────────────

program
  .command('pair')
  .description('Pair with a serve node and save credentials')
  .argument('<nodeId>', 'Node ID (xxxx-xxxx format)')
  .argument('<pairingCode>', 'Pairing code (XXXX-XXXX format)')
  .action(async (nodeId: string, pairingCode: string) => {
    const normalizedId   = normalizeTarget(nodeId);
    const normalizedCode = normalizeCode(pairingCode);

    if (!isValidTarget(normalizedId) || !isValidCode(normalizedCode)) {
      console.error('❌ Invalid node ID or pairing code format');
      console.error('   Node ID format: xxxx-xxxx (hex, e.g. ab12-34cd)');
      console.error('   Pairing code format: XXXX-XXXX (e.g. AB12-CD34)');
      process.exit(1);
    }

    addOrUpdateNode(normalizedId, normalizedCode);
    console.log(`✅ Paired with node: ${normalizedId}`);
    console.log(`   Credentials saved to ~/.clawdaddy/nodes.json`);
  });

// ─── unpair ───────────────────────────────────────────────────────────────────

program
  .command('unpair')
  .description('Remove a paired node')
  .argument('<nodeId>', 'Node ID to remove')
  .action(async (nodeId: string) => {
    const normalizedId = normalizeTarget(nodeId);
    const node = getNode(normalizedId);
    if (!node) { console.error(`❌ Node not found: ${normalizedId}`); process.exit(1); }
    removeNode(normalizedId);
    console.log(`✅ Removed node: ${normalizedId}`);
  });

// ─── list ─────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List all paired nodes')
  .action(async () => {
    const nodes = listNodes();
    if (nodes.length === 0) {
      console.log('📭 No paired nodes found.');
      console.log('   Use `clawdaddy pair <nodeId> <code>` to add one.');
      return;
    }
    console.log('\n📱 Paired nodes:\n');
    for (const node of nodes) {
      console.log(`   ${node.id}`);
      console.log(`     Code: ${node.pairingCode}`);
      console.log(`     Last connected: ${node.lastConnected ? new Date(node.lastConnected).toLocaleString() : 'Never'}`);
      console.log('');
    }
  });

// ─── console ──────────────────────────────────────────────────────────────────

program
  .command('console')
  .description('Start terminal chat mode')
  .option('-n, --node <nodeId>', 'Node ID to connect to')
  .option('-l, --local',         'Connect to a server on this machine (no pairing needed)')
  .option('--client-id <clientId>', 'Use a specific client ID') // 👈 Added option
  .action(async (options) => {

    const clientId = getOrCreateClientId(options.clientId); // 👈 Pass options.clientId

    // ── Local mode — no pairing required ────────────────────────────────────
    if (options.local) {
      const hostId = await resolveLocalHostId(options.node);
      console.log(`⚙️  Mode: Interactive (local)`);
      console.log(`🎯 Target: ${hostId}\n`);
      console.log(`🔑 Client: ${clientId.slice(0, 8)}...\n`); // 👈 Optional log parity

      await connectLocalAndRun(hostId, clientId, async () => { // 👈 Pass clientId here
        const { startInteractiveMode } = await import('./cli/src/interactive');
        startInteractiveMode();
      });
      return;
    }

    // ── Remote mode — paired node required ───────────────────────────────────
    const nodes = listNodes();
    if (nodes.length === 0) {
      console.error('❌ No paired nodes found.');
      console.error('   Use `clawdaddy pair <nodeId> <code>` to pair a node first.');
      console.error('   Or use --local to connect to a server on this machine.');
      process.exit(1);
    }

    let targetNode = options.node ? getNode(normalizeTarget(options.node)) : null;
    if (!targetNode && nodes.length > 0) {
      targetNode = nodes[0];
      console.log(`📌 Using default node: ${targetNode.id}`);
    } else if (!targetNode) {
      console.error(`❌ Node not found: ${options.node}`);
      nodes.forEach(n => console.log(`   ${n.id}`));
      process.exit(1);
    }

    const { startInteractiveMode } = await import('./cli/src/interactive');
    const { signalServer } = getConfig();
    const pairedHosts: Map<string, PairedHost> = new Map();
    pairedHosts.set(targetNode.id, {
      id: targetNode.id, pairingCode: targetNode.pairingCode,
      connected: false, lastConnected: targetNode.lastConnected || null, connectedAt: null,
    });

    console.log(`⚙️  Mode: Interactive`);
    console.log(`🎯 Target: ${targetNode.id}`);

    await startClient(
      targetNode.id, targetNode.pairingCode, pairedHosts,
      'interactive', startInteractiveMode, signalServer, clientId, clientId
    );

    process.on('SIGINT', () => { console.log('\n👋 Shutting down...'); process.exit(0); });
  });
// ─── api ──────────────────────────────────────────────────────────────────────

program
  .command('api')
  .description('Start local API server (OpenAI/Anthropic compatible)')
  .option('-n, --node <nodeId>', 'Node ID to connect to')
  .option('-p, --port <port>',   'Port to listen on (default: 3001)', '3001')
  .option('-l, --local',         'Connect to a server on this machine (no pairing needed)')
  .option('--client-id <clientId>', 'Use a specific client ID') // 👈 Added option
  .action(async (options) => {
    const port = parseInt(options.port, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      console.error('❌ Invalid port. Must be between 1024 and 65535');
      process.exit(1);
    }

    const clientId = getOrCreateClientId(options.clientId); // 👈 Pass options.clientId

    // ── Local mode — no pairing required ────────────────────────────────────
    if (options.local) {
      const hostId = await resolveLocalHostId(options.node);
      console.log(`⚙️  Mode: API (local)`);
      console.log(`🎯 Target: ${hostId}`);
      console.log(`🌐 Port:   ${port}\n`);

      await connectLocalAndRun(hostId, clientId, () => { // 👈 Pass clientId here
        startApiMode(new Map(), 'api', () => {}, clientId, getConfig().signalServer, port); // 👈 Use extracted clientId
      });
      return;
    }

    // ── Remote mode — paired node required ───────────────────────────────────
    const nodes = listNodes();
    if (nodes.length === 0) {
      console.error('❌ No paired nodes found.');
      console.error('   Use `clawdaddy pair <nodeId> <code>` to pair a node first.');
      console.error('   Or use --local to connect to a server on this machine.');
      process.exit(1);
    }

    let targetNode = options.node ? getNode(normalizeTarget(options.node)) : null;
    if (!targetNode && nodes.length > 0) {
      targetNode = nodes[0];
      console.log(`📌 Using default node: ${targetNode.id}`);
    } else if (!targetNode) {
      console.error(`❌ Node not found: ${options.node}`);
      nodes.forEach(n => console.log(`   ${n.id}`));
      process.exit(1);
    }

    const { signalServer } = getConfig();
    const pairedHosts: Map<string, PairedHost> = new Map();
    pairedHosts.set(targetNode.id, {
      id: targetNode.id, pairingCode: targetNode.pairingCode,
      connected: false, lastConnected: targetNode.lastConnected || null, connectedAt: null,
    });

    console.log(`⚙️  Mode: API`);
    console.log(`🎯 Target: ${targetNode.id}`);
    console.log(`🌐 Port:   ${port}`);

    startApiMode(pairedHosts, 'api', () => {}, clientId, signalServer, port);
    await startClient(
      targetNode.id, targetNode.pairingCode, pairedHosts,
      'api', () => {}, signalServer, clientId, clientId
    );

    process.on('SIGINT', () => { console.log('\n👋 Shutting down...'); process.exit(0); });
  });

// ─── serve ────────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start a serve node (runs local Ollama model, accepts P2P connections)')
  .argument('<model>', 'Ollama model name (e.g., llama3.2, mistral, codellama)')
  .option('-h, --host <host>', 'Ollama host URL', 'http://localhost:11434')
  .option('-p, --port <port>', 'Signal server port', '443')
  .option('--local-only',      'Accept local connections only — do not connect to switchboard')
  .action(async (model: string, options) => {
    const ollamaHost = options.host;
    const signalPort = parseInt(options.port, 10);

    console.log(`🔍 Checking if model '${model}' exists in Ollama...`);

    try {
      const listResponse = await fetch(`${ollamaHost}/api/tags`);
      if (!listResponse.ok) {
        console.error(`❌ Cannot connect to Ollama at ${ollamaHost}`);
        console.error('   Make sure Ollama is running: `ollama serve`');
        process.exit(1);
      }

      const data = await listResponse.json() as { models: Array<{ name: string }> };
      const models = data.models || [];
      const modelExists = models.some((m: { name: string }) =>
        m.name === model || m.name.startsWith(`${model}:`)
      );

      if (!modelExists) {
        console.error(`❌ Model '${model}' not found in Ollama`);
        if (models.length > 0) {
          console.error('\n   Available models:');
          for (const m of models) console.error(`     - ${m.name}`);
        }
        console.error(`\n   Pull the model first: ollama pull ${model}`);
        process.exit(1);
      }

      console.log(`✅ Model '${model}' found\n`);

      console.log(`🧪 Testing model with a small prompt...`);
      const testResponse = await fetch(`${ollamaHost}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'Say "OK"', stream: false, options: { num_predict: 5 } }),
      });

      if (!testResponse.ok) {
        console.warn(`⚠️  Model test failed, but continuing anyway...`);
      } else {
        const result = await testResponse.json() as { response: string };
        console.log(`✅ Model test successful: "${result.response.trim()}"\n`);
      }
    } catch (err) {
      console.error(`❌ Failed to validate model: ${(err as Error).message}`);
      console.error('   Make sure Ollama is running: `ollama serve`');
      process.exit(1);
    }

    process.env.CLAWDADDY_OLLAMA_MODEL = model;
    process.env.CLAWDADDY_OLLAMA_HOST  = ollamaHost;
    process.env.CLAWDADDY_SIGNAL_PORT  = signalPort.toString();

    console.log(`🚀 Starting serve node with model: ${model}`);
    if (options.localOnly) console.log(`   Mode: local-only (no switchboard)`);
    console.log(`   Ollama host: ${ollamaHost}\n`);

    const serveArgs = ['start', '--model', model];
    if (options.localOnly) serveArgs.push('--local-only');
    runServe(serveArgs);
  });

// ─── web ──────────────────────────────────────────────────────────────────────

program
  .command('web')
  .description('Launch the local Clawdaddy Web UI')
  .action(() => {
    const port   = 4242;
    const uiDir  = path.join(__dirname, 'cli', 'web-ui');
    const server = http.createServer((req, res) => {
      const urlPath  = req.url === '/' ? 'index.html' : req.url!;
      const filePath = path.join(uiDir, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
          '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });

    server.listen(port, () => {
      const url     = `http://localhost:${port}`;
      const openCmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open';
      console.log(`\n  🦞 Clawdaddy Web UI active!\n  🌐 Access at: ${url}\n\n  Press Ctrl+C to stop.\n`);
      exec(`${openCmd} ${url}`);
    });
  });

// ─── Error handlers ───────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason: any) => {
  console.error('\n❌ Unhandled error:', reason?.message || reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('\n❌ Uncaught exception:', err.message);
  process.exit(1);
});

program.parse();