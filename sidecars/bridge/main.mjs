import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DragGraftRuntime,
  PLUGIN_NAME,
  SIDECAR_KEY,
  SidecarOwner,
  assertSupportedNode,
  makeRendererBundle,
  resolvePaths,
} from '../../src/cdp-runtime.mjs';

assertSupportedNode();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const manifestPath = join(ROOT, 'plugin.json');
const rendererPath = join(ROOT, 'src', 'renderer.cjs');

const isInstalledOnDisk = () => existsSync(manifestPath) && existsSync(rendererPath);
if (!isInstalledOnDisk()) {
  process.exit(0);
}

const loadBundle = () => {
  const pluginManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rendererSource = readFileSync(rendererPath, 'utf8');
  return makeRendererBundle(rendererSource, { version: pluginManifest.version });
};

const fileStamp = (filePath) => {
  const st = statSync(filePath);
  return `${st.mtimeMs}:${st.size}`;
};

let lastManifestStamp = fileStamp(manifestPath);
let lastRendererStamp = fileStamp(rendererPath);
const initialBundle = loadBundle();

const paths = resolvePaths();
const owner = new SidecarOwner(paths.dataDir);

const isConfigEnabled = (cfg) => (
  cfg === null
  || (cfg?.plugins?.[PLUGIN_NAME]?.enabled === true
    && cfg?.sidecars?.[SIDECAR_KEY]?.enabled !== false)
);

let configCache = null;
let lastConfigStamp;
const isPluginEnabled = () => {
  let nextStamp = null;
  try {
    nextStamp = fileStamp(paths.pluginConfig);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return isConfigEnabled(configCache);
    }
  }
  if (nextStamp !== lastConfigStamp) {
    if (nextStamp === null) {
      lastConfigStamp = null;
      configCache = null;
    } else {
      try {
        configCache = JSON.parse(readFileSync(paths.pluginConfig, 'utf8').replace(/^\uFEFF/, ''));
        lastConfigStamp = nextStamp;
      } catch {
        // 忽略瞬态写入竞争，保留上一轮有效配置
      }
    }
  }
  return isConfigEnabled(configCache);
};

const claimed = await owner.claim();
if (!claimed) {
  process.exit(0);
}

let runtime = null;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const fallbackTimer = setTimeout(() => process.exit(0), 2000);
  fallbackTimer.unref?.();
  try {
    await runtime?.stop();
  } finally {
    owner.stop();
    process.exit(0);
  }
};

const pollInterval = Math.max(100, Number(process.env.AGY_DRAG_GRAFT_INTERVAL) || 3000);

runtime = new DragGraftRuntime({
  profile: paths.profile,
  dataDir: paths.dataDir,
  source: initialBundle.code,
  version: initialBundle.version,
  interval: pollInterval,
  enabled: () => {
    if (!owner.owns()) return false;
    if (!isInstalledOnDisk()) {
      setImmediate(() => { void shutdown(); });
      return false;
    }
    return isPluginEnabled();
  },
  owns: () => owner.isOwner(),
  onBeforeTick: () => {
    if (!isInstalledOnDisk()) return;
    try {
      const nextManifestStamp = fileStamp(manifestPath);
      const nextRendererStamp = fileStamp(rendererPath);
      if (nextManifestStamp !== lastManifestStamp || nextRendererStamp !== lastRendererStamp) {
        const nextBundle = loadBundle();
        if (runtime.updateBundle(nextBundle)) {
          lastManifestStamp = nextManifestStamp;
          lastRendererStamp = nextRendererStamp;
        }
      }
    } catch (err) {
      console.error('[agy-drag-graft] 热重载读取失败：', err?.message || err);
    }
  },
});

owner.watch(shutdown);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void shutdown();
  });
}

runtime.start();
