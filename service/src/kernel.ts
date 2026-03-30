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

  async start(): Promise<void> {
    const candidates = [
      path.resolve(process.cwd(), 'opseeq-core'),
      path.resolve(process.cwd(), '..', 'engine', 'target', 'release', 'opseeq-core'),
      '/app/opseeq-core',
    ];

    let binPath: string | null = null;
    for (const p of candidates) {
      try {
        await import('node:fs').then(fs => fs.promises.access(p, 1));
        binPath = p;
        break;
      } catch { /* try next */ }
    }

    if (!binPath) {
      console.log('[kernel] opseeq-core binary not found, running without kernel');
      return;
    }

    this.proc = spawn(binPath, ['serve'], {
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

    this.ready = true;
    console.log(`[kernel] opseeq-core started (pid ${this.proc.pid}) from ${binPath}`);
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
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill('SIGTERM');
      this.proc = null;
      this.ready = false;
    }
  }
}
