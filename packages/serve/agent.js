const fs = require('fs');
const path = require('path');

const COMMAND_LOG_FILE = path.join(process.cwd(), 'command_log.jsonl');
let lastPosition = 0;

// Watch for new commands
function watchCommands() {
    const stat = fs.statSync(COMMAND_LOG_FILE, { throwIfNoEntry: false });
    if (!stat) return;
    
    const stream = fs.createReadStream(COMMAND_LOG_FILE, {
        start: lastPosition,
        encoding: 'utf-8'
    });
    
    stream.on('data', (chunk) => {
        const lines = chunk.split('\n').filter(l => l.trim());
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                
                // Process unknown commands
                if (entry.type === 'unknown_command') {
                    console.log(`[AGENT] New unknown command: ${entry.command}`);
                    console.log(`[AGENT] Payload:`, entry.payload);
                    
                    // Do something intelligent here!
                    // - Send to ChatGPT for processing
                    // - Execute a local script
                    // - Send a webhook notification
                    // - Update a database
                    
                    // You could even write a response back to a response file
                    const response = {
                        requestId: entry.requestId,
                        result: {
                            processed: true,
                            action: 'custom_logic',
                            output: `Processed command: ${entry.command}`
                        }
                    };
                    
                    // This would need a way to send back to the host
                    // Could use a separate WebRTC connection or API call
                }
            } catch(e) {}
        }
        lastPosition += chunk.length;
    });
}

// Watch the file for changes
fs.watch(COMMAND_LOG_FILE, (eventType) => {
    if (eventType === 'change') {
        watchCommands();
    }
});

console.log('Agent watching for commands...');
watchCommands();
