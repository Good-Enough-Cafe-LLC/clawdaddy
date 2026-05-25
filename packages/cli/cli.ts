#!/usr/bin/env node

import { Command } from 'commander';
import { startClient } from './src/connection.js';
import { createLocalTransport } from './src/localTransport.js';
import { startApiMode } from './src/api.js';
import { getOrCreateClientId, loadNodes, addOrUpdateNode, removeNode, listNodes } from './src/storage.js';
import { normalizeTarget, normalizeCode, isValidTarget, isValidCode } from './src/validation.js';
import { getConfig } from './src/config.js';
import { startInteractiveMode } from './src/interactive.js';
import type { PairedHost } from './src/types.js';
import { readdirSync } from 'fs';
import { tmpdir } from 'os';

const program = new Command();

// ─── Helper ───────────────────────────────────────────────────────────────────
function failWithHelp(cmd: Command, message: string): never {
    console.error(`\n❌ ${message}\n`);
    cmd.outputHelp({ error: true });
    process.exit(1);
}

// ─── Local socket discovery ───────────────────────────────────────────────────
async function resolveLocalHostId(nodeId?: string): Promise<string> {
    if (nodeId) return nodeId.trim().toUpperCase();

    const sockets = readdirSync(tmpdir())
        .filter(f => f.startsWith('clawdaddy-') && f.endsWith('.sock'))
        .map(f => f.slice('clawdaddy-'.length, -'.sock'.length));

    if (sockets.length === 0) {
        console.error('❌ No local server found.');
        console.error('   Start one with: clawdaddy-serve start');
        process.exit(1);
    }

    if (sockets.length === 1) {
        console.log(`📌 Found local server: ${sockets[0]}`);
        return sockets[0];
    }

    console.error('❌ Multiple local servers found. Specify one with --node:');
    sockets.forEach(s => console.error(`   clawdaddy console --local --node ${s}`));
    process.exit(1);
}

// ─── Local connection helper ──────────────────────────────────────────────────
async function connectLocalAndRun(
    hostId:      string,
    clientId:    string,   // ← ADD
    onConnected: () => void,
): Promise<void> {
    return new Promise((resolve) => {
        const transport = createLocalTransport({
            hostId,
            onConnect: async () => {
                // Send identify so server loads persisted memory
                try {
                    const { sendCommand } = await import('./src/transport.js');
                    const result = await sendCommand('identify', { clientId });
                    if (result?.ltmFacts > 0) {
                        console.log(`🧠 Server loaded ${result.ltmFacts} LTM facts`);
                    }
                } catch (_) {
                    // Older server without identify — safe to ignore
                }
                onConnected();
            },
            onClose: () => { console.log('\n🔌 Local server disconnected.'); resolve(); },
            log: (msg, type) => {
                const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : '📡';
                console.log(`${prefix} ${msg}`);
            },
        });
 
        process.on('SIGINT', () => { transport.disconnect(); resolve(); });
    });
}

// ─── Program ──────────────────────────────────────────────────────────────────
program
    .name('Clawdaddy')
    .description('P2P tunnel for local LLMs')
    .version('1.0.12')
    .exitOverride((err) => {
        if (err.code?.startsWith('commander.')) {
            const cmdName   = process.argv[2];
            const failedCmd = program.commands.find(c => c.name() === cmdName);
            (failedCmd || program).outputHelp({ error: true });
        }
        process.exit(err.exitCode ?? 1);
    });

if (process.argv.length === 2) {
    program.outputHelp();
    process.exit(0);
}

// ─── pair ─────────────────────────────────────────────────────────────────────
program
    .command('pair')
    .description('Pair with a serve node and save credentials')
    .argument('<nodeId>',      'Node ID (xxxx-xxxx format)')
    .argument('<pairingCode>', 'Pairing code (XXXX-XXXX format)')
    .showHelpAfterError(true)
    .action(async (nodeId: string, pairingCode: string, cmd: Command) => {
        const normalizedId   = normalizeTarget(nodeId);
        const normalizedCode = normalizeCode(pairingCode);
        if (!isValidTarget(normalizedId)) failWithHelp(cmd, 'Invalid node ID format.\n   Expected: xxxx-xxxx (hex)');
        if (!isValidCode(normalizedCode)) failWithHelp(cmd, 'Invalid pairing code format.\n   Expected: XXXX-XXXX');
        addOrUpdateNode(normalizedId, normalizedCode);
        console.log(`\n✅ Paired with node: ${normalizedId}`);
        console.log(`   Credentials saved to ~/.clawdaddy/nodes.json\n`);
    });

// ─── unpair ───────────────────────────────────────────────────────────────────
program
    .command('unpair')
    .description('Remove a paired node')
    .argument('<nodeId>', 'Node ID to remove')
    .showHelpAfterError(true)
    .action(async (nodeId: string, cmd: Command) => {
        const normalizedId = normalizeTarget(nodeId);
        if (!loadNodes().has(normalizedId)) failWithHelp(cmd, `Node not found: ${normalizedId}`);
        removeNode(normalizedId);
        console.log(`\n✅ Removed node: ${normalizedId}\n`);
    });

// ─── list ─────────────────────────────────────────────────────────────────────
program
    .command('list')
    .description('List all paired nodes')
    .action(async () => {
        const nodes = listNodes();
        if (nodes.length === 0) {
            console.log('\n📭 No paired nodes found.');
            console.log('   Use `clawdaddy pair <nodeId> <code>` to add one.\n');
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
    .description('Start interactive REPL mode')
    .option('-n, --node <nodeId>', 'Node ID to connect to (uses first paired node if not specified)')
    .option('-l, --local',         'Connect to a server on this machine (no pairing needed)')
    .option('--client-id <clientId>',  'Use a specific client ID (default: auto from ~/.clawdaddy/client-id.json)')
    .showHelpAfterError(true)
    .action(async (options, cmd: Command) => {

         const clientId = getOrCreateClientId(options.clientId);

        // ── Local mode — no pairing required ──────────────────────────────────
        if (options.local) {
            const hostId = await resolveLocalHostId(options.node);
            console.log(`⚙️  Mode: Interactive (local)`);
            console.log(`🎯 Target: ${hostId}\n`);
            console.log(`🔑 Client: ${clientId.slice(0, 8)}...\n`);
            await connectLocalAndRun(hostId, clientId, startInteractiveMode);
            return;
        }

        // ── Remote mode — paired node required ────────────────────────────────
        const nodes = listNodes();
        if (nodes.length === 0) {
            failWithHelp(cmd, 'No paired nodes found.\n   Use `clawdaddy pair <nodeId> <code>` to pair first.\n   Or use --local to connect to a server on this machine.');
        }

        // In cli.ts, the console command - this will now work correctly
        let targetNode = options.node
            ? nodes.find(n => n.id === normalizeTarget(options.node))
            : nodes[0];  // ← Now gets most recently paired node!

        if (!targetNode) {
            console.error(`\n❌ Node not found: ${options.node}`);
            console.log('\nAvailable nodes:');
            nodes.forEach(n => console.log(`   ${n.id}`));
            process.exit(1);
        }

        console.log(`⚙️  Mode: Interactive`);
        console.log(`🎯 Target: ${targetNode.id}\n`);

        const pairedHosts: Map<string, PairedHost> = new Map([
            [targetNode.id, {
                id: targetNode.id, pairingCode: targetNode.pairingCode,
                connected: false, lastConnected: targetNode.lastConnected || null, connectedAt: null,
            }],
        ]);

        await startClient(
            targetNode.id, targetNode.pairingCode, pairedHosts,
            'interactive', startInteractiveMode,
            getConfig().signalServer, clientId,clientId
        );
    });

// ─── api ──────────────────────────────────────────────────────────────────────
program
    .command('api')
    .description('Start local API server (OpenAI/Anthropic compatible)')
    .option('-n, --node <nodeId>', 'Node ID to connect to (uses first paired node if not specified)')
    .option('-p, --port <port>',   'Port to listen on (default: 3001)', '3001')
    .option('-l, --local',         'Connect to a server on this machine (no pairing needed)')
    .option('--client-id <clientId>', 'Use a specific client ID')
    .showHelpAfterError(true)
    .action(async (options, cmd: Command) => {
        const port = parseInt(options.port, 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
            failWithHelp(cmd, 'Invalid port. Must be 1024–65535.');
        }

         const clientId = getOrCreateClientId(options.clientId);

        // ── Local mode — no pairing required ──────────────────────────────────
        if (options.local) {
            const hostId = await resolveLocalHostId(options.node);
            console.log(`⚙️  Mode: API (local)`);
            console.log(`🎯 Target: ${hostId}`);
            console.log(`🌐 Port:   ${port}\n`);
            await connectLocalAndRun(hostId, clientId, () => {
                startApiMode(new Map(), 'api', () => {}, getOrCreateClientId(), getConfig().signalServer, port);
            });
            return;
        }

        // ── Remote mode — paired node required ────────────────────────────────
        const nodes = listNodes();
        if (nodes.length === 0) {
            failWithHelp(cmd, 'No paired nodes found.\n   Use `clawdaddy pair <nodeId> <code>` to pair first.\n   Or use --local to connect to a server on this machine.');
        }

        let targetNode = options.node
            ? nodes.find(n => n.id === normalizeTarget(options.node))
            : nodes[0];

        if (!targetNode) {
            console.error(`\n❌ Node not found: ${options.node}`);
            nodes.forEach(n => console.log(`   ${n.id}`));
            process.exit(1);
        }

        //const clientId         = getOrCreateClientId();
        const { signalServer } = getConfig();
        const pairedHosts: Map<string, PairedHost> = new Map([
            [targetNode.id, {
                id: targetNode.id, pairingCode: targetNode.pairingCode,
                connected: false, lastConnected: targetNode.lastConnected || null, connectedAt: null,
            }],
        ]);

        console.log(`⚙️  Mode: API`);
        console.log(`🎯 Target: ${targetNode.id}`);
        console.log(`🌐 Port:   ${port}\n`);

        startApiMode(pairedHosts, 'api', () => {}, clientId, signalServer, port);
        await startClient(
            targetNode.id, targetNode.pairingCode, pairedHosts,
            'api', () => {}, signalServer, clientId, clientId
        );
    });

// ─── Global error handlers ────────────────────────────────────────────────────
process.on('unhandledRejection', (reason: any) => {
    console.error('\n❌ Unhandled error:', reason?.message || reason);
    process.exit(1);
});
process.on('uncaughtException', (err) => {
    console.error('\n❌ Uncaught exception:', err.message);
    process.exit(1);
});

// ─── Parse ────────────────────────────────────────────────────────────────────
program.parse(process.argv);