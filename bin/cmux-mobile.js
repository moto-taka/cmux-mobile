#!/usr/bin/env node
// cmux-mobile CLI entry point
import { createServer } from '../dist/server/index.js';

const args = process.argv.slice(2);

function parseArgs(argList) {
  const opts = {
    port: 3456,
    host: '0.0.0.0',
    socketPath: process.env.CMUX_SOCKET_PATH || '/tmp/cmux.sock',
    ttydBasePort: 9001,
  };

  for (let i = 0; i < argList.length; i++) {
    switch (argList[i]) {
      case '--port': {
        const val = argList[++i];
        if (!val || isNaN(Number(val))) {
          console.error('Error: --port requires a numeric value');
          process.exit(1);
        }
        opts.port = parseInt(val, 10);
        break;
      }
      case '--host': {
        const val = argList[++i];
        if (!val) {
          console.error('Error: --host requires a value');
          process.exit(1);
        }
        opts.host = val;
        break;
      }
      case '--socket-path': {
        const val = argList[++i];
        if (!val) {
          console.error('Error: --socket-path requires a value');
          process.exit(1);
        }
        opts.socketPath = val;
        break;
      }
      case '--ttyd-base-port': {
        const val = argList[++i];
        if (!val || isNaN(Number(val))) {
          console.error('Error: --ttyd-base-port requires a numeric value');
          process.exit(1);
        }
        opts.ttydBasePort = parseInt(val, 10);
        break;
      }
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
  const opts = parseArgs(args.slice(1));
  createServer(opts).catch((err) => {
    console.error('Failed to start cmux-mobile:', err);
    process.exit(1);
  });
} else {
  console.log('Usage: npx cmux-mobile start [options]');
  console.log('Run "npx cmux-mobile start --help" for more information.');
  process.exit(1);
}
