// 零依赖 CDP 运行时与单实例所有权守护。
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const isPidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const validOwnerRecord = (record) => (
  Boolean(record)
  && Number.isSafeInteger(record.pid)
  && record.pid > 0
  && Number.isFinite(record.startedAt)
  && typeof record.token === 'string'
  && record.token.length > 0
);

const isNewerOwner = (a, b) => (
  a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.token > b.token)
);

/** 解析跨平台配置、Antigravity profile 与 Sidecar 数据路径。 */
export function resolvePaths({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  let config;
  if (platform === 'win32') {
    config = env.APPDATA || join(home, 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    config = join(home, 'Library', 'Application Support');
  } else if (platform === 'linux') {
    config = env.XDG_CONFIG_HOME || join(home, '.config');
  } else {
    throw new Error('仅支持 Windows、macOS 与 Linux 平台');
  }

  const profile = env.AGY_DRAG_GRAFT_PROFILE || join(config, 'Antigravity');
  const pluginConfig = env.AGY_DRAG_GRAFT_CONFIG || join(home, '.gemini', 'config', 'config.json');
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
    || join(home, '.gemini', 'antigravity', 'sidecar_data', 'agy-drag-graft', 'bridge', 'data');

  return { profile, pluginConfig, dataDir };
}

/** 校验 DevTools 目标必须位于本机回环地址且端口一致。 */
export function validTarget(target, port) {
  try {
    const page = new URL(target.url);
    const ws = new URL(target.webSocketDebuggerUrl);
    return target.type === 'page'
      && (page.protocol === 'http:' || page.protocol === 'https:')
      && LOOPBACK.has(page.hostname)
      && ws.protocol === 'ws:'
      && LOOPBACK.has(ws.hostname)
      && Number(ws.port) === Number(port);
  } catch {
    return false;
  }
}

function httpGetJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1048576) req.destroy(new Error('DevTools 发现响应体积超限'));
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`DevTools 发现接口返回 HTTP ${res.statusCode}`);
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('DevTools 发现请求超时')));
    req.end();
  });
}

/** 从 Antigravity profile 目录下读取 DevToolsActivePort 并拉取合法页面目标。 */
export async function discoverTargets(profile) {
  const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
  if (text.length > 1024) throw new Error('DevToolsActivePort 内容异常');
  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DevToolsActivePort 端口号无效');
  }
  const targets = await httpGetJson(port, '/json/list');
  if (!Array.isArray(targets)) throw new Error('DevTools 目标列表格式无效');
  return targets.filter((target) => validTarget(target, port));
}

/** 轻量 CDP WebSocket 客户端，支持消息大小保护与超时回收。 */
export class CdpConnection {
  constructor(url, { WebSocketImpl = globalThis.WebSocket, timeout = 5000, onEvent = () => {}, onClose = () => {} } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.timeout = timeout;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  async open() {
    if (!this.WebSocketImpl) throw new Error('当前 Node 运行时缺少 WebSocket 支持');
    this.ws = new this.WebSocketImpl(this.url);
    this.ws.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2097152) return;
        const message = JSON.parse(event.data);
        if (message.id) {
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id);
          clearTimeout(item.timer);
          if (message.error) item.reject(new Error(`CDP 命令失败: ${message.error.code ?? message.error.message}`));
          else item.resolve(message.result || {});
        } else if (message.method) {
          this.onEvent(message);
        }
      } catch {}
    });
    this.ws.addEventListener('close', () => this.disconnect());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error('CDP 连接超时'));
      }, this.timeout);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); this.close(); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    return this;
  }

  command(method, params = {}) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(new Error('CDP 连接已断开'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('CDP 连接已关闭'));
    }
    this.pending.clear();
    this.onClose();
  }

  close() {
    this.disconnect();
    try { this.ws?.close?.(); } catch {}
  }
}

/** 从 renderer.cjs 生成带版本内容指纹的自执行浏览器注入代码。 */
export function makeRendererBundle(rendererSource, { version = null } = {}) {
  const prefix = 'module.exports = ';
  const idx = rendererSource.indexOf(prefix);
  if (idx < 0) throw new Error('renderer.cjs 格式不符合 module.exports = ... 约定');
  const fnBody = rendererSource.slice(idx + prefix.length).trim().replace(/;$/, '');
  const hash = createHash('sha256').update(fnBody).digest('hex').slice(0, 10);
  const resolvedVersion = version ? `${version}-${hash}` : hash;
  const code = `(${fnBody})({ version: ${JSON.stringify(resolvedVersion)} });`;
  return { version: resolvedVersion, code };
}

/**
 * 基于原子锁文件与轮询的 Sidecar 单实例守护。
 * 刻意避免使用 fs.watch，防止 Windows Node 26 libuv fs-event 断言崩溃。
 */
export class SidecarOwner {
  constructor(dataDir, {
    pid = process.pid,
    startedAt = Math.floor(Date.now() - process.uptime() * 1000),
    token = randomUUID(),
    interval = 2000,
    isAlive = isPidAlive,
  } = {}) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'active-sidecar.json');
    this.pid = pid;
    this.startedAt = startedAt;
    this.token = token;
    this.interval = interval;
    this.isAlive = isAlive;
    this.running = false;
    this.owned = false;
    this.timer = null;
    this.checking = null;
    this.generation = 0;
  }

  owns() {
    return this.running === true && this.owned === true;
  }

  async read() {
    return JSON.parse(await readFile(this.file, 'utf8'));
  }

  invalidate() {
    this.generation += 1;
    this.owned = false;
    this.checking = null;
  }

  async isOwner() {
    if (!this.running) return false;
    if (this.checking) return this.checking;
    const gen = this.generation;
    const checking = (async () => {
      let owned = false;
      try {
        const current = await this.read();
        owned = Boolean(validOwnerRecord(current) && current.pid === this.pid && current.token === this.token);
      } catch {}
      if (!this.running || gen !== this.generation) return false;
      this.owned = owned;
      return owned;
    })();
    this.checking = checking;
    try {
      return await checking;
    } finally {
      if (this.checking === checking) this.checking = null;
    }
  }

  async claim() {
    this.stop();
    mkdirSync(this.dataDir, { recursive: true });
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + 5000;

    for (;;) {
      try {
        writeFileSync(lock, JSON.stringify({ pid: this.pid, token: this.token }), { flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          let lockRecord = null;
          try { lockRecord = JSON.parse(readFileSync(lock, 'utf8')); } catch {}
          const stale = lockRecord?.pid
            ? !this.isAlive(lockRecord.pid)
            : (Date.now() - statSync(lock).mtimeMs > 10000);
          if (stale) {
            unlinkSync(lock);
            continue;
          }
        } catch (inner) {
          if (inner.code === 'ENOENT') continue;
          throw inner;
        }
        if (Date.now() > deadline) throw new Error('获取 Sidecar 所有权锁超时');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    const tmp = `${this.file}.${this.token}.tmp`;
    try {
      const candidate = { pid: this.pid, startedAt: this.startedAt, token: this.token };
      try {
        const prior = JSON.parse(readFileSync(this.file, 'utf8'));
        if (validOwnerRecord(prior) && isNewerOwner(prior, candidate) && this.isAlive(prior.pid)) {
          return false;
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      writeFileSync(tmp, `${JSON.stringify(candidate)}\n`, { flag: 'wx', mode: 0o600 });
      const replaceDeadline = Date.now() + 1000;
      for (;;) {
        try {
          renameSync(tmp, this.file);
          break;
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= replaceDeadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    } finally {
      try { unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try {
        if (JSON.parse(readFileSync(lock, 'utf8')).token === this.token) unlinkSync(lock);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }

    this.running = true;
    return this.isOwner();
  }

  watch(onLost) {
    clearInterval(this.timer);
    let checking = false;
    const poll = async () => {
      if (checking || !this.running) return;
      checking = true;
      try {
        const stillOwned = await this.isOwner();
        if (this.running && !stillOwned) {
          this.stop();
          await onLost?.();
        }
      } finally {
        checking = false;
      }
    };
    this.timer = setInterval(() => { void poll().catch(() => this.stop()); }, this.interval);
    this.timer.unref?.();
    void poll().catch(() => this.stop());
  }

  stop() {
    this.running = false;
    this.invalidate();
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** 管理 Antigravity 渲染页的 CDP 附着、重载自愈与停用清理。 */
export class DragGraftRuntime {
  constructor({
    profile = resolvePaths().profile,
    dataDir = resolvePaths().dataDir,
    source,
    version = '0.1.0',
    enabled = async () => true,
    owns = async () => true,
    discover = discoverTargets,
    connect = (url, options) => new CdpConnection(url, options),
    targetOrigin = (target) => new URL(target.url).origin,
    onBeforeTick = null,
    interval = 3000,
  }) {
    if (typeof source !== 'string' || !source) throw new Error('必须提供渲染注入脚本内容');
    this.profile = profile;
    this.dataDir = dataDir;
    this.source = source;
    this.version = version;
    this.enabled = enabled;
    this.owns = owns;
    this.discover = discover;
    this.connect = connect;
    this.targetOrigin = targetOrigin;
    this.onBeforeTick = onBeforeTick;
    this.interval = interval;
    this.sessions = new Map();
    this.running = false;
    this.stopping = false;
    this.busy = false;
    this.timer = null;
    this.health = { state: 'waiting', version, windows: 0, message: '等待连接 Antigravity 渲染窗口' };
  }

  /** 更新内存中的注入脚本与内容指纹，将在下一轮 tick 自动热替换。 */
  updateBundle({ source, version }) {
    if (typeof source !== 'string' || !source) return;
    this.source = source;
    if (typeof version === 'string' && version) {
      this.version = version;
    }
  }

  async writeStatus(state, message) {
    this.health = {
      state,
      version: this.version,
      windows: this.sessions.size,
      message,
      checkedAt: new Date().toISOString(),
    };
    if (!this.dataDir) return;
    try {
      if (!await this.owns()) return;
      await mkdir(this.dataDir, { recursive: true });
      const tmp = join(this.dataDir, `status.${process.pid}.tmp`);
      await writeFile(tmp, `${JSON.stringify(this.health, null, 2)}\n`, 'utf8');
      renameSync(tmp, join(this.dataDir, 'status.json'));
    } catch {}
  }

  async attach(target) {
    const connection = this.connect(target.webSocketDebuggerUrl, {
      onEvent: (message) => {
        if (message.method === 'Page.frameNavigated' && message.params?.frame && !message.params.frame.parentId) {
          connection.mounted = false;
        }
      },
    });
    connection.origin = this.targetOrigin(target);
    connection.mounted = false;
    connection.script = null;
    const guardedSource = `if (location.origin === ${JSON.stringify(connection.origin)}) { ${this.source} }`;
    connection.guardedSource = guardedSource;

    try {
      await connection.open();
      if (this.stopping || !await this.owns()) throw new Error('Sidecar 所有权已转移');
      await connection.command('Page.enable');
      const preload = await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: guardedSource });
      connection.script = preload?.identifier ?? null;
      if (this.stopping || !await this.owns()) throw new Error('Sidecar 所有权已转移');
      const evalRes = await connection.command('Runtime.evaluate', { expression: guardedSource });
      if (evalRes?.exceptionDetails) throw new Error('主世界脚本初始化异常');
      connection.loadedVersion = this.version;
      connection.mounted = true;
      return connection;
    } catch (error) {
      try {
        if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script });
      } catch {}
      connection.close();
      throw error;
    }
  }

  async detach(connection) {
    const owned = await this.owns();
    if (owned) {
      try {
        await connection.command('Runtime.evaluate', { expression: 'window.__agyDragGraftDispose?.();' });
      } catch {}
    }
    try {
      if (connection.script) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.script });
    } catch {}
    connection.close();
  }

  async detachAll() {
    for (const connection of this.sessions.values()) {
      await this.detach(connection);
    }
    this.sessions.clear();
  }

  async tick() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      if (!await this.owns()) {
        await this.detachAll();
        return;
      }
      if (!await this.enabled()) {
        await this.detachAll();
        await this.writeStatus('disabled', '插件已停用，页面拖拽钩子已清理');
        return;
      }

      await this.onBeforeTick?.();

      const targets = await this.discover(this.profile);
      const activeUrls = new Set(targets.map((t) => t.webSocketDebuggerUrl));

      for (const [url, connection] of this.sessions.entries()) {
        if (!activeUrls.has(url) || connection.closed) {
          await this.detach(connection);
          this.sessions.delete(url);
        }
      }
      for (const target of targets) {
        const existing = this.sessions.get(target.webSocketDebuggerUrl);
        if (existing && existing.origin !== this.targetOrigin(target)) {
          await this.detach(existing);
          this.sessions.delete(target.webSocketDebuggerUrl);
        }
      }
      for (const target of targets) {
        if (!this.sessions.has(target.webSocketDebuggerUrl)) {
          this.sessions.set(target.webSocketDebuggerUrl, await this.attach(target));
        }
      }

      if (this.stopping || !await this.owns()) {
        await this.detachAll();
        return;
      }

      const probeExpr = `(() => ({ installed: Boolean(window.__agyDragGraft?.installed), version: window.__agyDragGraft?.version || null }))()`;
      for (const [url, connection] of this.sessions.entries()) {
        try {
          if (connection.loadedVersion !== this.version) {
            if (!await this.owns()) break;
            const nextGuarded = `if (location.origin === ${JSON.stringify(connection.origin)}) { ${this.source} }`;
            const oldScript = connection.script;
            connection.guardedSource = nextGuarded;
            try {
              if (oldScript) await connection.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: oldScript });
            } catch {}
            const nextPreload = await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: nextGuarded });
            connection.script = nextPreload?.identifier ?? null;
            const upgradeRes = await connection.command('Runtime.evaluate', { expression: nextGuarded });
            if (upgradeRes?.exceptionDetails) throw new Error('渲染钩子热更新失败');
            connection.loadedVersion = this.version;
            connection.mounted = true;
            continue;
          }
          const checkRes = await connection.command('Runtime.evaluate', { expression: probeExpr, returnByValue: true });
          if (checkRes?.exceptionDetails) throw new Error('渲染上下文尚未就绪');
          const status = checkRes?.result?.value;
          if (!status?.installed || status.version !== this.version) {
            if (!await this.owns()) break;
            const recoverRes = await connection.command('Runtime.evaluate', { expression: connection.guardedSource });
            if (recoverRes?.exceptionDetails) throw new Error('渲染钩子恢复失败');
          }
          connection.mounted = true;
        } catch {
          await this.detach(connection);
          this.sessions.delete(url);
        }
      }

      const mountedCount = [...this.sessions.values()].filter((c) => c.mounted).length;
      await this.writeStatus(
        mountedCount > 0 ? 'mounted' : 'waiting',
        mountedCount > 0 ? `已挂载到 ${mountedCount} 个 Antigravity 渲染窗口` : '未发现可挂载的 Antigravity 渲染窗口',
      );
    } catch (error) {
      const missingPort = error?.code === 'ENOENT';
      await this.writeStatus(
        missingPort ? 'missing-debug-port' : 'reconnecting',
        missingPort
          ? '未检测到 DevToolsActivePort（请以 --remote-debugging-port=0 --remote-debugging-address=127.0.0.1 启动 Antigravity）'
          : (error?.message || '等待重新连接 Antigravity 调试端口'),
      );
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.interval);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    await this.detachAll();
  }
}
