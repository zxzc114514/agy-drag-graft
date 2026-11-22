import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
