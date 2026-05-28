#!/usr/bin/env node

import { Command } from 'commander';
import { startHost } from './host';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfig } from './config';

const CONFIG_DIR  = path.join(os.homedir(), '.clawdaddy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'serve-config.json');

let currentHost: any = null;

interface ServeConfig {
    nodeId:      string;
    pairingCode: string;
    model:       string;
}

function failWithHelp(cmd: Command, message: string): never {
    console.error(`\n❌ ${message}\n`);
    cmd.outputHelp({ error: true });
    process.exit(1);
}

function loadConfig(): ServeConfig | null {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        }
    } catch (e) {
        console.error('Failed to load config:', e);
    }
    return null;
}

function saveConfig(config: ServeConfig): void {
    try {
        if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Failed to save config:', e);
    }
}

function generateNodeId(): string {
    const hex = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0').toUpperCase();
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

function generatePairingCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const part1 = Array(4).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
    const part2 = Array(4).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${part1}-${part2}`;
}

function normalizeHostId(id: string): string {
    const cleaned = id.replace(/-/g, '').toUpperCase();
    if (cleaned.length === 8) return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
    if (/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(id)) return id.toUpperCase();
    return generateNodeId();
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();

program
    .name('clawdaddy-serve')
    .description('Serve any Ollama model from your machine, accessible from anywhere')
    .version('1.0.13')
    .usage('[options] [command]')
    .exitOverride((err) => {
        if (err.code?.startsWith('commander.')) {
            const cmdName   = process.argv[2];
            const failedCmd = program.commands.find(c => c.name() === cmdName);
            (failedCmd || program).outputHelp({ error: true });
        } else {
            console.error('\n❌ Unexpected error:', err.message);
            program.outputHelp({ error: true });
        }
        process.exit(err.exitCode ?? 1);
    });

if (process.argv.length === 1) {
    program.outputHelp();
    process.exit(0);
}

// ─── start ────────────────────────────────────────────────────────────────────

program
    .command('start')
    .description('Start the serve node')
    .option('-i, --id <id>',                  'Node ID (default: saved or auto-generated)')
    .option('-c, --code <code>',              'Pairing code (default: saved or auto-generated)')
    .option('-m, --model <model>',            'Ollama model name', 'llama3.2')
    .option('-s, --switchboard <url>',        'Switchboard URL', 'https://clawdaddyswitch01.goodenoughcafe.com')
    .option('--max-connections <number>',     'Maximum concurrent connections', '3')
    .option('--allow-multiple',               'Allow multiple connections (default: true)', true)
    .option('--reset-id',                     'Reset node ID to a new random value')
    .option('--reset-code',                   'Reset pairing code to a new random value')
    .option('--local-only',                   'Accept local connections only — do not connect to the switchboard')
    .showHelpAfterError(true)
    .action(async (options: any, cmd: Command) => {
        let config = loadConfig();

        if (options.resetId) {
            if (config) config.nodeId = generateNodeId();
            else config = { nodeId: generateNodeId(), pairingCode: generatePairingCode(), model: options.model };
        }

        if (options.resetCode) {
            if (config) config.pairingCode = generatePairingCode();
            else config = { nodeId: generateNodeId(), pairingCode: generatePairingCode(), model: options.model };
        }

        const hostId       = options.id   || config?.nodeId      || generateNodeId();
        const pairingCode  = options.code || config?.pairingCode || generatePairingCode();
        const normalizedId = normalizeHostId(hostId);
        const localOnly    = !!options.localOnly;

        const maxConnections = parseInt(options.maxConnections, 10);
        if (isNaN(maxConnections) || maxConnections < 1 || maxConnections > 100) {
            failWithHelp(cmd, 'Invalid --max-connections. Must be between 1 and 100.');
        }

        const contextWindow = parseInt(options.contextWindow ?? '8192', 10);
        if (isNaN(contextWindow) || contextWindow < 1024) {
            failWithHelp(cmd, 'Invalid --context-window. Must be at least 1024.');
        }

        saveConfig({ nodeId: normalizedId, pairingCode, model: options.model });

        const config_file_display = '~/.clawdaddy/serve-config.json';

        console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🦞  Clawdaddy Serve -- Cooked up by Good Enough Cafe        ║
║                                                               ║
║   Node ID:    ${normalizedId.padEnd(48)}║
║   Pairing:    ${pairingCode.padEnd(48)}║
║   Model:      ${options.model.padEnd(48)}║
║   Max Conn:   ${maxConnections.toString().padEnd(48)}║
║   Ctx Window: ${contextWindow.toString().padEnd(48)}║
║   Config:     ${config_file_display.padEnd(48)}║
║   Mode:       ${(localOnly ? 'Local only (no switchboard)' : 'Network + local socket').padEnd(48)}║
║                                                               ║
${localOnly ? `║   ⚠️  Running in local-only mode.                             ║
║   Remote clients cannot connect.                              ║
║   Local clients connect via Unix socket automatically.        ║` :
`║   Share this code with anyone you want to grant access:       ║
║                                                               ║
║           🔐  ${pairingCode}  🔐                                   ║
║                                                               ║
║   To access this server from any machine:                     ║
║   Install: npm install -g clawdaddy                           ║
║   Pairing: clawdaddy pair ${normalizedId} ${pairingCode.padEnd(26)}║
║   API mode: clawdaddy api ${normalizedId.padEnd(36)}║
║   Console mode: clawdaddy console ${normalizedId.padEnd(28)}║`}
║                                                               ║
║   Commands while running:                                     ║
║   - View status: clawdaddy serve status                       ║
║   - Disconnect: clawdaddy serve disconnect <peerId>           ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
        `);

        const log = (msg: string, type: string = 'info') => {
            const prefix    = type === 'error' ? '❌' : type === 'success' ? '✅' : '📡';
            const timestamp = new Date().toISOString().slice(11, 19);
            console.log(`${timestamp} ${prefix} ${msg}`);
        };

        currentHost = await startHost({
            switchboardUrl: options.switchboard,
            hostId:         normalizedId,
            pairingCode,
            ollamaModel:    options.model,
            maxConnections,
            contextWindow,
            allowMultiple:  options.allowMultiple !== false,
            localOnly,      // ← always opens Unix socket; if true, skips switchboard
            log,
            onReady: (info) => {
                console.log(`\n✨ Server ready! Waiting for connections...`);
                if (info.socketPath) {
                    console.log(`🔌 Local socket: ${info.socketPath}\n`);
                } else {
                    console.log('');
                }
            },
            onConnection: (peerId: string, total: number) => {
                console.log(`\n🎉 Client connected: ${peerId} (${total}/${maxConnections})\n`);
            },
            onDisconnection: (peerId: string, total: number) => {
                console.log(`\n👋 Client disconnected: ${peerId} (${total}/${maxConnections})\n`);
            },
        });

        process.on('SIGINT', () => {
            console.log('\n\n👋 Shutting down...');
            if (currentHost) currentHost.disconnect();
            process.exit(0);
        });
    });

// ─── status ───────────────────────────────────────────────────────────────────

program
    .command('status')
    .description('Show current configuration and connections')
    .showHelpAfterError(true)
    .action(() => {
        const config = getConfig();
        console.log('\n📋 Clawdaddy Configuration:');
        console.log(`   Node ID:         ${config.nodeId || 'not set'}`);
        console.log(`   Pairing Code:    ${config.pairingCode || 'not set'}`);
        console.log(`   Model:           ${config.model}`);
        console.log(`   Max Connections: ${config.maxConnections}`);
        console.log(`   Allow Multiple:  ${config.allowMultiple}`);
        console.log(`   Config file:     ~/.clawdaddy/serve-config.json`);

        if (currentHost) {
            const peerCount      = currentHost.getPeerCount?.() || 0;
            const maxConnections = config.maxConnections || 3;
            console.log(`\n📊 Current Connections: ${peerCount}/${maxConnections}`);
            (currentHost.getPeers?.() || []).forEach((peer: string, i: number) => {
                console.log(`   ${i + 1}. ${peer}`);
            });
        } else {
            console.log('\n⚠️  Serve node is not currently running');
            console.log('   Start it with: clawdaddy-serve start');
        }
    });

// ─── disconnect ───────────────────────────────────────────────────────────────

program
    .command('disconnect <peerId>')
    .description('Disconnect a specific client')
    .showHelpAfterError(true)
    .action((peerId: string, cmd: Command) => {
        if (!currentHost) failWithHelp(cmd, 'No serve node running.\n   Start it with: clawdaddy-serve start');
        if (typeof currentHost.disconnectPeer !== 'function') {
            console.error('❌ disconnectPeer not implemented on host instance');
            process.exit(1);
        }
        currentHost.disconnectPeer(peerId);
        console.log(`✅ Disconnected peer: ${peerId}`);
    });

// ─── reset ────────────────────────────────────────────────────────────────────

program
    .command('reset')
    .description('Reset node ID and/or pairing code')
    .option('--id',   'Reset node ID')
    .option('--code', 'Reset pairing code')
    .option('--all',  'Reset both')
    .showHelpAfterError(true)
    .action((options: any, cmd: Command) => {
        const config = loadConfig();
        if (!config) failWithHelp(cmd, 'No configuration found.\n   Run `clawdaddy-serve start` first.');

        let changed = false;
        if (options.id || options.all)   { config.nodeId      = generateNodeId();      console.log(`✅ Node ID reset to: ${config.nodeId}`);          changed = true; }
        if (options.code || options.all) { config.pairingCode = generatePairingCode(); console.log(`✅ Pairing code reset to: ${config.pairingCode}`); changed = true; }
        if (!changed) failWithHelp(cmd, 'No reset option specified.\n   Use --id, --code, or --all');

        saveConfig(config);
        console.log(`\n💡 Restart clawdaddy-serve for changes to take effect.`);
    });

// ─── Error handlers ───────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason: any) => {
    console.error('\n❌ Unhandled error:', reason?.message || reason);
    console.log('\n💡 Run `clawdaddy-serve --help` for usage.\n');
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error('\n❌ Uncaught exception:', err.message);
    console.log('\n💡 Run `clawdaddy-serve --help` for usage.\n');
    process.exit(1);
});

// ─── Parse ────────────────────────────────────────────────────────────────────

if (require.main === module) {
    program.parse(process.argv);
}

export function runServe(args: string[]) {
    program.parse(args, { from: 'user' });
}