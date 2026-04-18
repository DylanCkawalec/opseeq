import { spawn, ChildProcess } from 'node:child_process';
import { createInterface, Interface } from 'node:readline';
import path from 'node:path';

type RpcCallback = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class KernelClient {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, RpcCallback>();
  private ready = false;
  private binPath: string | null = null;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private static MAX_RESTARTS = 5;
  private static RESTART_BACKOFF_BASE_MS = 2_000;

  async start(): Promise<void> {
    const candidates = [
      path.resolve(process.cwd(), 'opseeq-core'),
      path.resolve(process.cwd(), '..', 'engine', 'target', 'release', 'opseeq-core'),
      '/app/opseeq-core',
    ];

    for (const p of candidates) {
      try {
        await import('node:fs').then(fs => fs.promises.access(p, 1));
        this.binPath = p;
        break;
      } catch { /* try next */ }
    }

    if (!this.binPath) {
      console.log('[kernel] opseeq-core binary not found, running without kernel');
      return;
    }

    this.spawnProcess();
  }

  private spawnProcess(): void {
    if (!this.binPath || this.stopped) return;

    this.proc = spawn(this.binPath, ['serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.log(`[kernel] ${msg}`);
    });

    this.proc.on('exit', (code) => {
      console.log(`[kernel] opseeq-core exited with code ${code}`);
      this.ready = false;
      for (const [, cb] of this.pending) {
        clearTimeout(cb.timer);
        cb.reject(new Error('kernel process exited'));
      }
      this.pending.clear();

      // Auto-restart with exponential backoff
      if (!this.stopped && this.restartCount < KernelClient.MAX_RESTARTS) {
        const delay = KernelClient.RESTART_BACKOFF_BASE_MS * Math.pow(2, this.restartCount);
        this.restartCount++;
        console.log(`[kernel] Restarting in ${delay}ms (attempt ${this.restartCount}/${KernelClient.MAX_RESTARTS})`);
        this.restartTimer = setTimeout(() => {
          this.spawnProcess();
        }, delay);
      } else if (this.restartCount >= KernelClient.MAX_RESTARTS) {
        console.log('[kernel] Max restarts exceeded, running without kernel');
      }
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line);
        const cb = this.pending.get(msg.id);
        if (cb) {
          clearTimeout(cb.timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            cb.resolve(msg.result);
          }
        }
      } catch { /* ignore malformed lines */ }
    });

    console.log(`[kernel] opseeq-core spawned (pid ${this.proc.pid}) from ${this.binPath}, waiting for ping...`);
    this.handshake();
  }

  private handshake(): void {
    const PING_TIMEOUT_MS = 5_000;
    const id = this.nextId++;
    const req = JSON.stringify({ id, method: 'kernel.ping', params: {} }) + '\n';

    const timer = setTimeout(() => {
      this.pending.delete(id);
      console.log('[kernel] ping timeout — marking ready anyway (degraded)');
      this.ready = true;
      setTimeout(() => { if (this.ready) this.restartCount = 0; }, 30_000);
    }, PING_TIMEOUT_MS);

    this.pending.set(id, {
      resolve: (result: unknown) => {
        clearTimeout(timer);
        const info = result as { version?: string; uptime_ms?: number; providers?: number } | null;
        this.ready = true;
        console.log(`[kernel] opseeq-core ready — v${info?.version ?? '?'}, ${info?.providers ?? '?'} providers`);
        setTimeout(() => { if (this.ready) this.restartCount = 0; }, 30_000);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        console.log(`[kernel] ping failed: ${err.message} — marking ready anyway`);
        this.ready = true;
        setTimeout(() => { if (this.ready) this.restartCount = 0; }, 30_000);
      },
      timer,
    });
    this.proc!.stdin!.write(req);
  }

  isReady(): boolean {
    return this.ready && this.proc !== null && !this.proc.killed;
  }

  async call(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<unknown> {
    if (!this.isReady()) {
      throw new Error('kernel not ready');
    }

    const id = this.nextId++;
    const req = JSON.stringify({ id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`kernel RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(req);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill('SIGTERM');
      this.proc = null;
      this.ready = false;
    }
  }
}
