import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DragGraftRuntime,
  SidecarOwner,
  makeRendererBundle,
  resolvePaths,
} from '../../src/cdp-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const manifestPath = join(ROOT, 'plugin.json');
const rendererPath = join(ROOT, 'src', 'renderer.cjs');

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

let configCache = {};
let configCheckedAt = -Infinity;
const isPluginEnabled = () => {
  if (Date.now() - configCheckedAt >= 2000) {
    configCheckedAt = Date.now();
    try {
      configCache = JSON.parse(readFileSync(paths.pluginConfig, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      configCache = {};
    }
  }
  const pluginDisabled = configCache?.plugins?.['agy-drag-graft']?.enabled === false;
  const sidecarDisabled = configCache?.sidecars?.['agy-drag-graft/bridge']?.enabled === false;
  return !pluginDisabled && !sidecarDisabled;
};

const claimed = await owner.claim();
if (!claimed) {
  process.exit(0);
}

const runtime = new DragGraftRuntime({
  profile: paths.profile,
  dataDir: paths.dataDir,
  source: initialBundle.code,
  version: initialBundle.version,
  enabled: async () => owner.owns() && isPluginEnabled(),
  owns: () => owner.isOwner(),
  onBeforeTick: () => {
    try {
      const nextManifestStamp = fileStamp(manifestPath);
      const nextRendererStamp = fileStamp(rendererPath);
      if (nextManifestStamp !== lastManifestStamp || nextRendererStamp !== lastRendererStamp) {
        const nextBundle = loadBundle();
        runtime.updateBundle(nextBundle);
        lastManifestStamp = nextManifestStamp;
        lastRendererStamp = nextRendererStamp;
      }
    } catch (err) {
      console.error('[agy-drag-graft] 热重载读取失败：', err?.message || err);
    }
  },
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const fallbackTimer = setTimeout(() => process.exit(0), 2000);
  fallbackTimer.unref?.();
  try {
    await runtime.stop();
  } finally {
    owner.stop();
    process.exit(0);
  }
};

owner.watch(shutdown);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void shutdown();
  });
}

runtime.start();
