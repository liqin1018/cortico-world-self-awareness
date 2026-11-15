/**
 * 她的时间线：一个只读的本地页面。
 *
 * 只绑 127.0.0.1，不对外。没有写操作，没有令牌——它只把 thoughts.jsonl
 * 和 reflections.jsonl 摊开给人看。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE_FILE = fileURLToPath(new URL('../webui/index.html', import.meta.url));
const HOST = '127.0.0.1';
/** 端口被占就往后找几个，别让插件因为端口冲突起不来。 */
const PORT_TRIES = 12;

export interface SiteHooks {
  data(): unknown;
}

export class ThoughtSite {
  private server: Server | null = null;
  private listening = 0;
  private readonly hooks: SiteHooks;

  constructor(hooks: SiteHooks) {
    this.hooks = hooks;
  }

  get port(): number {
    return this.listening;
  }

  get origin(): string | null {
    return this.listening ? `http://${HOST}:${this.listening}` : null;
  }

  async start(preferred: number): Promise<string | null> {
    if (this.server) return this.origin;
    const base = Math.max(1024, Math.min(65_535, Number(preferred) || 7802));
    for (let i = 0; i < PORT_TRIES; i += 1) {
      const port = base + i;
      const ok = await this.tryListen(port);
      if (ok) {
        this.listening = port;
        return this.origin;
      }
    }
    return null;
  }

  private tryListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer((req, rsp) => this.handle(req, rsp));
      const onError = () => {
        server.removeListener('listening', onListening);
        server.close();
        resolve(false);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        this.server = server;
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(port, HOST);
      } catch {
        resolve(false);
      }
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = 0;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, rsp: ServerResponse): void {
    // 只许本机访问：Host 头不是 127.0.0.1/localhost 的一律拒掉（防 DNS rebinding）
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== HOST && host !== 'localhost') {
      rsp.writeHead(403).end('forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.pathname === '/api/data') {
      let body = '';
      try {
        body = JSON.stringify(this.hooks.data());
      } catch (error) {
        body = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      rsp.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      rsp.end(body);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      let html = '';
      try {
        html = readFileSync(PAGE_FILE, 'utf8');
      } catch {
        rsp.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        rsp.end('页面文件丢了，重装一下插件。');
        return;
      }
      rsp.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      rsp.end(html);
      return;
    }
    rsp.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    rsp.end('not found');
  }
}
