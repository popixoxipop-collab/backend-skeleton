import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';

// Test-support host bindings for lib/trust-next/enforcement-gate.mjs. The gate holds no file, socket or
// process capability (static-purity.test.mjs), so the real effects used by the gate tests live here.
// createRecordingHost is in-memory and records every call; createRealHost touches the real file system,
// loopback sockets and child processes. Neither one ever connects to a non-loopback address.

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function missing(what) {
  return Object.assign(new Error(`ENOENT: ${what}`), { code: 'ENOENT' });
}

function relativeInside(realRoot, target) {
  const rel = path.relative(realRoot, target);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function nextAnswer(table, counters, name) {
  const sequence = table[name];
  if (!Array.isArray(sequence) || sequence.length === 0) throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
  const index = counters.get(name) ?? 0;
  counters.set(name, index + 1);
  return sequence[Math.min(index, sequence.length - 1)];
}

export function makeScratch(prefix = 'bskel-gate-') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  return { root: fs.realpathSync(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// dns maps a name to a list of answers; the n-th lookup returns the n-th answer and the last one repeats,
// which models a name that is rebound between two lookups.
export function createRecordingHost({ files = {}, canonical = {}, dns = {}, executables = { node: '/pinned/bin/node' }, secrets = {}, spawnImpl } = {}) {
  const calls = [];
  const counters = new Map();
  return {
    calls,
    files,
    count: (method) => calls.filter((call) => call.method === method).length,
    async realpath(rel, options) {
      calls.push({ method: 'realpath', rel, forWrite: options.forWrite });
      return Object.hasOwn(canonical, rel) ? canonical[rel] : rel;
    },
    async readFile(rel) {
      calls.push({ method: 'readFile', rel });
      if (!Object.hasOwn(files, rel)) throw missing(rel);
      return Buffer.from(files[rel]);
    },
    async writeFile(rel, bytes) {
      calls.push({ method: 'writeFile', rel, text: Buffer.from(bytes).toString('utf8') });
      files[rel] = Buffer.from(bytes).toString('utf8');
    },
    async resolve(name) {
      calls.push({ method: 'resolve', name });
      return nextAnswer(dns, counters, name);
    },
    async connect(request) {
      calls.push({ method: 'connect', ...request });
      return { connected: true };
    },
    async listen(request) {
      calls.push({ method: 'listen', ...request });
      return { listening: true };
    },
    async resolveExecutable(basename) {
      calls.push({ method: 'resolveExecutable', basename });
      if (!Object.hasOwn(executables, basename)) throw missing(basename);
      return executables[basename];
    },
    spawn(request) {
      calls.push({ method: 'spawn', file: request.file, executable: request.executable, args: request.args, env: request.env });
      if (spawnImpl) return spawnImpl(request);
      return { pid: 4242, kill() {}, done: Promise.resolve({ exit_code: 0, signal: null }) };
    },
    async resolveSecret(ref) {
      calls.push({ method: 'resolveSecret', ref });
      if (!Object.hasOwn(secrets, ref)) throw missing(ref);
      return secrets[ref];
    },
    async openDevice(deviceClass) {
      calls.push({ method: 'openDevice', deviceClass });
      return { opened: deviceClass };
    },
  };
}

export function createRealHost({ root, executables = {}, dns = {}, secrets = {} } = {}) {
  const realRoot = fs.realpathSync(root);
  const calls = [];
  const counters = new Map();
  return {
    root: realRoot,
    calls,
    count: (method) => calls.filter((call) => call.method === method).length,
    async realpath(rel, { forWrite }) {
      calls.push({ method: 'realpath', rel, forWrite });
      const full = path.resolve(realRoot, rel);
      if (!forWrite) return relativeInside(realRoot, await fs.promises.realpath(full));
      // The file may not exist yet: canonicalise the parent directory and keep the final name.
      const joined = path.join(await fs.promises.realpath(path.dirname(full)), path.basename(full));
      const stat = await fs.promises.lstat(joined).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat?.isSymbolicLink()) return relativeInside(realRoot, joined);
      // A symbolic link as the final component: its destination decides, and a dangling link has none we can vouch for.
      try {
        return relativeInside(realRoot, await fs.promises.realpath(joined));
      } catch {
        return null;
      }
    },
    async readFile(rel) {
      calls.push({ method: 'readFile', rel });
      const handle = await fs.promises.open(path.join(realRoot, rel), fs.constants.O_RDONLY | NO_FOLLOW);
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },
    async writeFile(rel, bytes) {
      calls.push({ method: 'writeFile', rel });
      const handle = await fs.promises.open(path.join(realRoot, rel), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW, 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    },
    async resolve(name) {
      calls.push({ method: 'resolve', name });
      return nextAnswer(dns, counters, name);
    },
    async connect({ host, address, port }) {
      calls.push({ method: 'connect', host, address, port });
      if (address !== '127.0.0.1' && address !== '::1') return { connected: false, address, port };
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: address, port });
        let established = false;
        // End the connection gracefully and read what the peer sends, so that unread data never turns the close into a reset.
        socket.once('connect', () => { established = true; socket.end(); });
        // Before the handshake an error is the answer. After it, a reset only means that the peer closed first.
        socket.on('error', (error) => { if (!established) reject(error); });
        socket.once('close', () => (established ? resolve() : reject(new Error('closed before the connection was established'))));
        socket.resume();
      });
      return { connected: true, address, port };
    },
    async listen({ host, port }) {
      calls.push({ method: 'listen', host, port });
      const sockets = new Set();
      const server = net.createServer((socket) => {
        // Every accepted socket has an error listener: a peer that closes first can reset the connection.
        sockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => sockets.delete(socket));
        socket.end('bskel');
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host, port }, resolve); });
      return {
        port: server.address().port,
        close: () => new Promise((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        }),
      };
    },
    async resolveExecutable(basename) {
      calls.push({ method: 'resolveExecutable', basename });
      if (!Object.hasOwn(executables, basename)) throw missing(basename);
      return executables[basename];
    },
    spawn({ file, executable, args, env, onStdout, onStderr }) {
      calls.push({ method: 'spawn', file, executable, args, env });
      const child = spawnChild(file, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true, cwd: realRoot });
      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ exit_code: code, signal }));
      });
      const kill = (signal) => {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      };
      return { pid: child.pid, kill, done };
    },
    async resolveSecret(ref) {
      calls.push({ method: 'resolveSecret', ref });
      if (!Object.hasOwn(secrets, ref)) throw missing(ref);
      return secrets[ref];
    },
    async openDevice(deviceClass) {
      calls.push({ method: 'openDevice', deviceClass });
      return { opened: deviceClass };
    },
  };
}
