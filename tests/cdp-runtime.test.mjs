import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DragGraftRuntime,
  SidecarOwner,
  makeRendererBundle,
  validTarget,
} from '../src/cdp-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

test('validTarget 仅接受匹配端口的本地回环页面目标', () => {
  assert.equal(
    validTarget({
      type: 'page',
      url: 'https://127.0.0.1:49707/c/123',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
    }, 9222),
    true,
  );
  assert.equal(
    validTarget({
      type: 'page',
      url: 'https://evil.example.com/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
    }, 9222),
    false,
  );
  assert.equal(
    validTarget({
      type: 'page',
      url: 'https://127.0.0.1:49707/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/1',
    }, 9222),
    false,
  );
  assert.equal(
    validTarget({
      type: 'background_page',
      url: 'https://127.0.0.1:49707/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
    }, 9222),
    false,
  );
});

test('makeRendererBundle 能从 renderer.cjs 生成带版本内容指纹的自执行脚本', () => {
  const src = readFileSync(join(ROOT, 'src', 'renderer.cjs'), 'utf8');
  const bundle = makeRendererBundle(src, { version: '0.1.0-test' });
  assert.match(bundle.version, /^0\.1\.0-test-[0-9a-f]{10}$/);
  assert.match(bundle.code, /installAgyDragGraft/);
  assert.match(bundle.code, /version:\s*"0\.1\.0-test-[0-9a-f]{10}"/);
});

test('DragGraftRuntime 完成首次挂载、重载自愈、停用清理与优雅停止', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-dg-rt-'));
  try {
    let enabledFlag = true;
    let probeInstalled = true;
    const calls = [];
    const fakeConnections = [];

    const connect = (url) => {
      const conn = {
        url,
        closed: false,
        async open() {
          calls.push('open');
        },
        async command(method, params = {}) {
          calls.push([method, params]);
          if (method === 'Page.addScriptToEvaluateOnNewDocument') {
            return { identifier: 'preload-1' };
          }
          if (method === 'Runtime.evaluate') {
            if (String(params.expression).includes('window.__agyDragGraft?.installed')) {
              return { result: { value: { installed: probeInstalled, version: '0.1.0' } } };
            }
            if (String(params.expression).includes('__agyDragGraftDispose')) {
              probeInstalled = false;
              return { result: { value: true } };
            }
            probeInstalled = true;
            return { result: { value: 'mounted' } };
          }
          return {};
        },
        close() {
          this.closed = true;
          calls.push('close');
        },
      };
      fakeConnections.push(conn);
      return conn;
    };

    const target = {
      type: 'page',
      url: 'https://127.0.0.1:49707/c/test',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/A',
    };

    const rt = new DragGraftRuntime({
      profile: dir,
      dataDir: dir,
      source: 'window.__agyDragGraft={installed:true,version:"0.1.0"};',
      version: '0.1.0',
      enabled: async () => enabledFlag,
      discover: async () => [target],
      connect,
    });

    // 第 1 次 tick：attach 并持久化 status.json
    await rt.tick();
    assert.equal(rt.health.state, 'mounted');
    assert.equal(rt.health.windows, 1);
    const status1 = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
    assert.equal(status1.state, 'mounted');
    assert.ok(calls.some(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument'));

    // 第 2 次 tick：模拟页面重载丢失 window 钩子 -> 心跳自愈重注
    probeInstalled = false;
    calls.length = 0;
    await rt.tick();
    assert.equal(probeInstalled, true);
    assert.ok(calls.some(([m, p]) => m === 'Runtime.evaluate' && String(p.expression).includes('if (location.origin ===')));

    // 第 2.5 次 tick：updateBundle 热替换新版脚本
    calls.length = 0;
    rt.updateBundle({
      source: 'window.__agyDragGraft={installed:true,version:"0.1.0-next"};',
      version: '0.1.0-next',
    });
    await rt.tick();
    assert.equal(rt.health.version, '0.1.0-next');
    assert.ok(calls.some(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument' && p.identifier === 'preload-1'));
    assert.ok(calls.some(([m, p]) => m === 'Page.addScriptToEvaluateOnNewDocument' && String(p.source).includes('0.1.0-next')));
    assert.ok(calls.some(([m, p]) => m === 'Runtime.evaluate' && String(p.expression).includes('0.1.0-next')));

    // 第 3 次 tick：用户停用 -> 触发 dispose 并移除 preload
    enabledFlag = false;
    calls.length = 0;
    await rt.tick();
    assert.equal(rt.health.state, 'disabled');
    assert.equal(rt.sessions.size, 0);
    assert.ok(calls.some(([m, p]) => m === 'Runtime.evaluate' && String(p.expression).includes('__agyDragGraftDispose')));
    assert.ok(calls.some(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument' && p.identifier === 'preload-1'));
    assert.equal(fakeConnections[0].closed, true);

    await rt.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SidecarOwner 支持新实例接管、旧实例触发 onLost 与僵尸锁回收', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-dg-owner-'));
  try {
    // 写入僵尸锁（不存在的 PID）
    writeFileSync(join(dir, 'active-sidecar.json.lock'), JSON.stringify({ pid: 9999999, token: 'dead' }));

    const oldOwner = new SidecarOwner(dir, {
      pid: process.pid,
      startedAt: 1000,
      token: 'old-token',
      interval: 30,
    });
    assert.equal(await oldOwner.claim(), true);

    let lostCount = 0;
    oldOwner.watch(() => { lostCount += 1; });

    const newOwner = new SidecarOwner(dir, {
      pid: process.pid,
      startedAt: 2000,
      token: 'new-token',
      interval: 30,
    });
    assert.equal(await newOwner.claim(), true);

    // 旧实例尝试以更早 startedAt 再次 claim 应被拒绝
    const staleOwner = new SidecarOwner(dir, {
      pid: process.pid,
      startedAt: 1500,
      token: 'stale-token',
    });
    assert.equal(await staleOwner.claim(), false);

    // 等待 oldOwner 轮询感知所有权被接管
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(lostCount, 1);
    assert.equal(oldOwner.owns(), false);

    oldOwner.stop();
    newOwner.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main.mjs 在托盘无渲染窗口期间持续保活，并在所有权被接管后优雅退出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-dg-main-'));
  const profileDir = join(dir, 'profile');
  const dataDir = join(dir, 'data');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  let child = null;
  let takeover = null;
  let exitPromise = null;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    writeFileSync(join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/test\n`, 'utf8');

    child = spawn(process.execPath, [join(ROOT, 'sidecars', 'bridge', 'main.mjs')], {
      env: {
        ...process.env,
        AGY_DRAG_GRAFT_PROFILE: profileDir,
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
        AGY_DRAG_GRAFT_CONFIG: join(dir, 'missing-config.json'),
      },
      stdio: 'ignore',
    });

    let exited = false;
    exitPromise = new Promise((resolve) => {
      child.once('exit', (code) => {
        exited = true;
        resolve(code);
      });
    });

    const statusPath = join(dataDir, 'status.json');
    let status = null;
    const waitDeadline = Date.now() + 3000;
    while (!exited && Date.now() < waitDeadline) {
      try {
        status = JSON.parse(readFileSync(statusPath, 'utf8'));
        break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(status, 'Sidecar 未能在超时内写出 status.json');

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(exited, false, '无渲染窗口期间 Sidecar 不应主动退出');
    assert.equal(child.exitCode, null);
    assert.equal(status.state, 'waiting');
    assert.equal(status.windows, 0);

    takeover = new SidecarOwner(dataDir, {
      pid: process.pid,
      startedAt: Date.now() + 60_000,
      token: 'takeover-token',
    });
    assert.equal(await takeover.claim(), true);

    const code = await Promise.race([
      exitPromise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Sidecar 被接管后未在 5000ms 内退出')), 5000);
        exitPromise.finally(() => clearTimeout(timer));
      }),
    ]);
    assert.equal(code, 0);
  } finally {
    takeover?.stop();
    if (child && child.exitCode === null) {
      try { child.kill(); } catch {}
      if (exitPromise) await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('DragGraftRuntime 支持窗口关闭退托盘后再重开自动重挂，且不向已消失目标发远程清理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-dg-tray-'));
  try {
    const targetA = {
      type: 'page',
      url: 'https://127.0.0.1:49707/c/a',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/A',
    };
    const targetB = {
      type: 'page',
      url: 'https://127.0.0.1:49707/c/b',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/B',
    };

    let round = 0;
    const discover = async () => {
      if (round === 0) return [targetA];
      if (round === 1) return [];
      return [targetB];
    };

    const conns = new Map();
    const connect = (url) => {
      const conn = {
        url,
        closed: false,
        commands: [],
        async open() {},
        async command(method, params = {}) {
          this.commands.push([method, params]);
          if (method === 'Page.addScriptToEvaluateOnNewDocument') {
            return { identifier: `preload-${url}` };
          }
          if (method === 'Runtime.evaluate') {
            if (String(params.expression).includes('window.__agyDragGraft?.installed')) {
              return { result: { value: { installed: true, version: '0.1.0' } } };
            }
            return { result: { value: 'mounted' } };
          }
          return {};
        },
        close() {
          this.closed = true;
        },
      };
      conns.set(url, conn);
      return conn;
    };

    const rt = new DragGraftRuntime({
      profile: dir,
      dataDir: dir,
      source: 'window.__agyDragGraft={installed:true,version:"0.1.0"};',
      version: '0.1.0',
      discover,
      connect,
    });

    // 第 1 轮：挂载 targetA
    await rt.tick();
    assert.equal(rt.health.state, 'mounted');
    assert.equal(rt.health.windows, 1);
    const connA = conns.get(targetA.webSocketDebuggerUrl);
    assert.ok(connA);

    // 第 2 轮：窗口退托盘，targetA 已从列表消失，仅本地关闭连接
    round = 1;
    connA.commands.length = 0;
    await rt.tick();
    assert.equal(rt.health.state, 'waiting');
    assert.equal(rt.health.windows, 0);
    assert.equal(connA.closed, true);
    assert.equal(
      connA.commands.some(([m]) => m === 'Runtime.evaluate' || m === 'Page.removeScriptToEvaluateOnNewDocument'),
      false,
    );

    // 第 3 轮：从托盘恢复新窗口 targetB，自动重新注入
    round = 2;
    await rt.tick();
    assert.equal(rt.health.state, 'mounted');
    assert.equal(rt.health.windows, 1);
    assert.equal(rt.sessions.size, 1);
    const connB = conns.get(targetB.webSocketDebuggerUrl);
    assert.ok(connB);
    assert.ok(connB.commands.some(([m, p]) => m === 'Runtime.evaluate' && String(p.expression).includes('if (location.origin ===')));

    await rt.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DragGraftRuntime 单目标 attach 失败时不阻塞其余合法窗口挂载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-dg-bad-target-'));
  try {
    const badTarget = {
      type: 'page',
      url: 'https://127.0.0.1:49707/c/bad',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/BAD',
    };
    const goodTarget = {
      type: 'page',
      url: 'https://127.0.0.1:49707/c/good',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/GOOD',
    };

    const connect = (url) => ({
      url,
      closed: false,
      async open() {
        if (url === badTarget.webSocketDebuggerUrl) {
          throw new Error('transient window closed');
        }
      },
      async command(method, params = {}) {
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          return { identifier: 'preload-good' };
        }
        if (method === 'Runtime.evaluate') {
          if (String(params.expression).includes('window.__agyDragGraft?.installed')) {
            return { result: { value: { installed: true, version: '0.1.0' } } };
          }
          return { result: { value: 'mounted' } };
        }
        return {};
      },
      close() {
        this.closed = true;
      },
    });

    const rt = new DragGraftRuntime({
      profile: dir,
      dataDir: dir,
      source: 'window.__agyDragGraft={installed:true,version:"0.1.0"};',
      version: '0.1.0',
      discover: async () => [badTarget, goodTarget],
      connect,
    });

    await rt.tick();
    assert.equal(rt.sessions.size, 1);
    assert.equal(rt.health.state, 'mounted');
    assert.equal(rt.health.windows, 1);
    assert.ok(rt.sessions.has(goodTarget.webSocketDebuggerUrl));

    await rt.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SidecarOwner.isOwner 对瞬态文件读取异常具备短重试容错，且对真实接管立即返回 false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-dg-ebusy-'));
  try {
    const owner = new SidecarOwner(dir, {
      pid: process.pid,
      startedAt: 1000,
      token: 'my-token',
    });
    assert.equal(await owner.claim(), true);

    const origRead = owner.read.bind(owner);
    let readAttempts = 0;
    owner.read = async () => {
      readAttempts += 1;
      if (readAttempts === 1) {
        const err = new Error('resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return origRead();
    };
    assert.equal(await owner.isOwner(), true);
    assert.equal(readAttempts, 2);

    let takeoverReads = 0;
    owner.read = async () => {
      takeoverReads += 1;
      return { pid: process.pid + 1, startedAt: Date.now() + 1000, token: 'other' };
    };
    assert.equal(await owner.isOwner(), false);
    assert.equal(takeoverReads, 1);

    owner.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DragGraftRuntime.updateBundle 直接兼容 makeRendererBundle 返回的 code 字段并完成热替换', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-dg-bundle-'));
  try {
    const calls = [];
    let rt = null;
    const connect = (url) => ({
      url,
      closed: false,
      async open() {
        calls.push(['open', {}]);
      },
      async command(method, params = {}) {
        calls.push([method, params]);
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          return { identifier: 'preload-1' };
        }
        if (method === 'Runtime.evaluate') {
          if (String(params.expression).includes('window.__agyDragGraft?.installed')) {
            return { result: { value: { installed: true, version: rt.version } } };
          }
          return { result: { value: 'mounted' } };
        }
        return {};
      },
      close() {
        this.closed = true;
      },
    });

    const target = {
      type: 'page',
      url: 'https://127.0.0.1:49707/c/bundle',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/B1',
    };

    rt = new DragGraftRuntime({
      profile: dir,
      dataDir: dir,
      source: 'window.__v=1;',
      version: '0.1.0-old',
      discover: async () => [target],
      connect,
    });

    await rt.tick();

    const nextBundle = makeRendererBundle('module.exports = function () { window.__v = 2; };', { version: '0.1.0' });
    assert.equal(rt.updateBundle({}), false);
    assert.equal(rt.version, '0.1.0-old');
    assert.equal(rt.updateBundle(nextBundle), true);

    calls.length = 0;
    await rt.tick();
    assert.equal(rt.health.version, nextBundle.version);
    assert.ok(calls.some(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument' && p.identifier === 'preload-1'));
    assert.ok(calls.some(([m, p]) => m === 'Page.addScriptToEvaluateOnNewDocument' && String(p.source).includes(nextBundle.version)));
    assert.ok(calls.some(([m, p]) => m === 'Runtime.evaluate' && String(p.expression).includes(nextBundle.version)));

    await rt.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
