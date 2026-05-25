import readline from 'readline';
import { sendCommand, sendInference } from './transport.js';
import { randomUUID } from 'crypto';

export function startInteractiveMode(): void {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n🦞 Clawdaddy Interactive Mode');
  console.log('Type /help for available commands\n');

  const ask = () => {
    rl.question('\n💬 > ', async (input) => {
      if (!input.trim()) return ask();

      const trimmed = input.trim();

      // ─── COMMAND DETECTION ───────────────────────────────────────────────────

      if (trimmed.startsWith('/')) {
        const withoutSlash = trimmed.substring(1);

        // /cmd <command_name> [payload] — send arbitrary command to host
        if (withoutSlash.startsWith('cmd ')) {
          const parts = withoutSlash.substring(4).trim().split(/\s+/);
          const commandName = parts[0];
          let payload: any = parts.slice(1).join(' ');

          if (payload && (payload.startsWith('{') || payload.startsWith('['))) {
            try { payload = JSON.parse(payload); } catch (_) { /* keep as string */ }
          }

          console.log(`\n🔧 Executing command: ${commandName}`);
          try {
            const result = await sendCommand(commandName, payload);
            console.log(`\n✅ Result:\n${JSON.stringify(result, null, 2)}\n`);
          } catch (e: any) {
            console.error(`\n❌ Command failed: ${e.message}\n`);
          }
          return ask();
        }

        // Direct commands — /ping, /get_status, /clear_memory, etc.
        const parts = withoutSlash.split(/\s+/);
        const commandName = parts[0].toLowerCase();
        let payload: any = parts.slice(1).join(' ');

        if (payload && (payload.startsWith('{') || payload.startsWith('['))) {
          try { payload = JSON.parse(payload); } catch (_) { /* keep as string */ }
        }

        if (commandName === 'help') {
          console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    Available Commands                          ║
╠════════════════════════════════════════════════════════════════╣
║ /ping                    - Check if host is responsive        ║
║ /get_status              - Get host status and stats          ║
║ /get_memory_stats        - Show conversation memory usage     ║
║ /clear_memory            - Clear conversation history         ║
║ /set_system_prompt <text> - Change system prompt/personality  ║
║ /echo <message>          - Echo back your message             ║
║ /cmd <cmd> [payload]     - Send any command to the host       ║
║ /help                    - Show this help message             ║
╚════════════════════════════════════════════════════════════════╝

💬 Or just type your message to chat normally.
`);
          return ask();
        }

        console.log(`\n🔧 Executing command: ${commandName}`);
        try {
          const result = await sendCommand(commandName, payload);
          console.log(`\n✅ Result:\n${JSON.stringify(result, null, 2)}\n`);
        } catch (e: any) {
          console.error(`\n❌ Command failed: ${e.message}\n`);
        }
        return ask();
      }

      // ─── NORMAL INFERENCE ────────────────────────────────────────────────────

      try {
        const requestId = randomUUID();
        // await sendInference([{ role: 'user', content: trimmed }], requestId);
        await sendInference([{ role: 'user', content: trimmed }]);
      } catch (e: any) {
        console.error('❌ Request failed:', e.message);
      }
      ask();
    });
  };

  ask();
}