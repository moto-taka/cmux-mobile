#!/usr/bin/env node
// cmux-mobile CLI entry point
import { createServer } from '../dist/server/index.js';

const args = process.argv.slice(2);

function parseArgs() {
  const opts = {
    port: 3456,
    host: '0.0.0.0',
    socketPath: process.env.CMUX_SOCKET_PATH || '/tmp/cmux.sock',
    ttydBasePort: 9001,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
        opts.port = parseInt(args[++i], 10);
        break;
      case '--host':
        opts.host = args[++i];
        break;
      case '--socket-path':
        opts.socketPath = args[++i];
        break;
      case '--ttyd-base-port':
        opts.ttydBasePort = parseInt(args[++i], 10);
        break;
      case '--help':
        console.log(`
cmux-mobile - Access cmux workspaces from your smartphone

Usage: npx cmux-mobile start [options]

Options:
  --port <number>          Server port (default: 3456)
  --host <string>          Server host (default: 0.0.0.0)
  --socket-path <path>     cmux socket path (default: /tmp/cmux.sock)
  --ttyd-base-port <port>  Base port for ttyd processes (default: 9001)
  --help                   Show this help

Environment Variables:
  CMUX_SOCKET_PATH         Path to cmux Unix socket
`);
        process.exit(0);
    }
  }
  return opts;
}

const command = args[0];

if (command === 'start') {
  const opts = parseArgs();
  createServer(opts).catch((err) => {
    console.error('Failed to start cmux-mobile:', err);
    process.exit(1);
  });
} else {
  console.log('Usage: npx cmux-mobile start [options]');
  console.log('Run "npx cmux-mobile start --help" for more information.');
  process.exit(1);
}
