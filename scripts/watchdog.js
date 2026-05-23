const { spawn } = require('node:child_process');

let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, ['index.js'], {
    stdio: 'inherit',
    shell: false
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(code || 0);
    if (code === 42) {
      setTimeout(start, 1000);
      return;
    }
    process.exit(code || (signal ? 1 : 0));
  });
}

function stop(signal) {
  stopping = true;
  if (child) child.kill(signal);
  else process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

start();
