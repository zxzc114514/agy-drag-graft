// 零依赖 AGY Drag Graft 插件安装、状态检查、打包与卸载管理工具（Node.js >= 22）。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import {
  assertSupportedNode,
  CdpConnection,
  discoverTargets,
  isPidAlive,
  PLUGIN_NAME,
  resolveConfigBase,
  SIDECAR_KEY,
} from './src/cdp-runtime.mjs';

export const SOURCE = dirname(fileURLToPath(import.meta.url));
export { PLUGIN_NAME, SIDECAR_KEY };
export const RUNTIME_ITEMS = ['plugin.json', 'assets', 'src', 'sidecars'];
export const DIST_ITEMS = [
  'plugin.json',
  'package.json',
  'LICENSE',
  'README.md',
  'README.en.md',
  'manage.mjs',
  'install.cmd',
  'install.sh',
  'uninstall.cmd',
  'uninstall.sh',
  'assets',
  'sidecars',
  'src',
];
const IGNORED_NAMES = new Set(['.data', 'data', 'node_modules', 'dist', '.git']);
const IGNORED_EXTS = ['.log', '.tmp'];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isIgnored(name) {
  return IGNORED_NAMES.has(name) || IGNORED_EXTS.some((ext) => name.endsWith(ext));
}

const LOCK_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** 在 Windows 瞬态文件锁冲突时带短退避重试原子替换。 */
export function renameSyncWithRetry(tmpPath, dstPath, { retries = 8, delayMs = 15, renameFn = renameSync } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameFn(tmpPath, dstPath);
      return;
    } catch (err) {
      if (!LOCK_RETRY_CODES.has(err?.code) || attempt >= retries) throw err;
      Atomics.wait(SLEEP_CELL, 0, 0, delayMs);
    }
  }
}

function withAtomicTarget(dst, writeFn) {
  mkdirSync(dirname(dst), { recursive: true });
  const tmpPath = `${dst}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFn(tmpPath);
    renameSyncWithRetry(tmpPath, dst);
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {}
    }
  }
}

function atomicCopyFile(src, dst) {
  const st = statSync(src);
  withAtomicTarget(dst, (tmpPath) => {
    copyFileSync(src, tmpPath);
    try {
      chmodSync(tmpPath, st.mode);
      utimesSync(tmpPath, st.atime, st.mtime);
    } catch {}
  });
}

function copyRuntimeTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (isIgnored(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyRuntimeTree(srcPath, dstPath);
    } else if (entry.isFile()) {
      atomicCopyFile(srcPath, dstPath);
    }
  }
}

function jsonRead(filePath, defaultValue = {}) {
  try {
    if (!statSync(filePath).isFile()) return defaultValue;
  } catch {
    return defaultValue;
  }
  const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function atomicJson(filePath, payload) {
  withAtomicTarget(filePath, (tmpPath) => {
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  });
}

function expandHome(homeDir) {
  if (homeDir == null || homeDir === '') return resolve(homedir());
  const raw = String(homeDir);
  if (raw === '~') return resolve(homedir());
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return resolve(join(homedir(), raw.slice(2)));
  }
  return resolve(raw);
}

/** 解析跨平台配置、Antigravity profile、插件目录与 Sidecar 数据目录。 */
export function resolveHomePaths(homeDir, { platform = process.platform, env = process.env } = {}) {
  const home = expandHome(homeDir);
  const configBase = resolveConfigBase({ platform, home, env });

  const profileDir = resolve(env.AGY_DRAG_GRAFT_PROFILE || join(configBase, 'Antigravity'));
  const pluginsRoot = join(home, '.gemini', 'config', 'plugins');
  const pluginDir = join(pluginsRoot, PLUGIN_NAME);
  const configFile = join(home, '.gemini', 'config', 'config.json');
  const dataDir = join(home, '.gemini', 'antigravity', 'sidecar_data', PLUGIN_NAME, 'bridge', 'data');
  return { home, pluginsRoot, pluginDir, configFile, profileDir, dataDir };
}

/** 校验目标插件目录不是符号链接、位于预期 plugins 根目录且属于本插件。 */
export function verifySafeTarget(pluginsRoot, pluginDir) {
  let stat = null;
  try {
    stat = lstatSync(pluginDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error('目标插件路径是符号链接，拒绝覆盖或删除。');
  }
  if (dirname(realpathSync(pluginDir)) !== realpathSync(pluginsRoot)) {
    throw new Error('目标插件目录不在预期 plugins 根目录下，拒绝操作。');
  }
  const manifestPath = join(pluginDir, 'plugin.json');
  if (existsSync(manifestPath)) {
    const manifest = jsonRead(manifestPath);
    if (manifest?.name !== PLUGIN_NAME) {
      throw new Error('目标目录不是 agy-drag-graft 插件安装目录，拒绝覆盖或删除。');
    }
  } else {
    const allowedRemnants = new Set(RUNTIME_ITEMS);
    const entries = readdirSync(pluginDir);
    if (entries.some((name) => !allowedRemnants.has(name) && !isIgnored(name))) {
      throw new Error('目标目录缺少 plugin.json 且包含未知文件，拒绝覆盖或删除。');
    }
  }
}

/** 汇总本机安装状态、配置启用开关与 Sidecar 运行时状态。 */
export function buildStatus(homeDir) {
  const paths = resolveHomePaths(homeDir);
  const pluginDir = paths.pluginDir;
  const manifest = jsonRead(join(SOURCE, 'plugin.json'));
  const installedManifest = jsonRead(join(pluginDir, 'plugin.json'), null);
  const installed = Boolean(installedManifest && installedManifest.name === PLUGIN_NAME);

  const config = jsonRead(paths.configFile);
  const pluginsCfg = isPlainObject(config.plugins) ? config.plugins : {};
  const sidecarsCfg = isPlainObject(config.sidecars) ? config.sidecars : {};

  const runtimeStatus = jsonRead(join(paths.dataDir, 'status.json'), null);
  const installedSidecar = installed
    ? jsonRead(join(pluginDir, 'sidecars', 'bridge', 'sidecar.json'), null)
    : null;

  return {
    installed,
    pluginDirectory: pluginDir,
    enabledInConfig: isPlainObject(pluginsCfg[PLUGIN_NAME]) ? (pluginsCfg[PLUGIN_NAME].enabled ?? null) : null,
    sidecarEnabledInConfig: isPlainObject(sidecarsCfg[SIDECAR_KEY]) ? (sidecarsCfg[SIDECAR_KEY].enabled ?? null) : null,
    debugPortFileExists: existsSync(join(paths.profileDir, 'DevToolsActivePort')),
    nodeExecutable: isPlainObject(installedSidecar) ? (installedSidecar.command ?? null) : process.execPath,
    runtimeStatus,
    sourceVersion: manifest?.version ?? null,
  };
}

/** 安装或热更新插件运行时文件至 ~/.gemini/config/plugins/agy-drag-graft，默认自动在 config.json 中启用。 */
export function install(homeDir, {
  registerConfig = true,
  nodePath = null,
  bootstrapSidecar = !nodePath,
  silent = false,
} = {}) {
  const paths = resolveHomePaths(homeDir);
  mkdirSync(paths.pluginsRoot, { recursive: true });
  verifySafeTarget(paths.pluginsRoot, paths.pluginDir);
  mkdirSync(paths.pluginDir, { recursive: true });

  for (const item of RUNTIME_ITEMS) {
    const src = join(SOURCE, item);
    const dst = join(paths.pluginDir, item);
    if (existsSync(dst) && realpathSync(src) === realpathSync(dst)) {
      continue;
    }
    if (statSync(src).isDirectory()) {
      copyRuntimeTree(src, dst);
    } else {
      atomicCopyFile(src, dst);
    }
  }

  if (process.platform === 'win32' || nodePath) {
    const nodeExe = nodePath || process.execPath;
    const sidecarManifest = join(paths.pluginDir, 'sidecars', 'bridge', 'sidecar.json');
    if (nodeExe && existsSync(sidecarManifest) && statSync(sidecarManifest).isFile()) {
      const data = jsonRead(sidecarManifest);
      if (isPlainObject(data) && (data.command === 'node' || nodePath)) {
        data.command = String(nodeExe);
        atomicJson(sidecarManifest, data);
      }
    }
  }

  if (registerConfig) {
    const config = jsonRead(paths.configFile);
    if (!isPlainObject(config)) {
      throw new Error('config.json 结构异常，拒绝写入。');
    }
    if (config.plugins !== undefined && !isPlainObject(config.plugins)) {
      throw new Error('config.json 中的 plugins 字段结构异常。');
    }
    if (config.sidecars !== undefined && !isPlainObject(config.sidecars)) {
      throw new Error('config.json 中的 sidecars 字段结构异常。');
    }
    config.plugins = isPlainObject(config.plugins) ? config.plugins : {};
    config.sidecars = isPlainObject(config.sidecars) ? config.sidecars : {};
    if (!isPlainObject(config.plugins[PLUGIN_NAME])) config.plugins[PLUGIN_NAME] = {};
    if (!isPlainObject(config.sidecars[SIDECAR_KEY])) config.sidecars[SIDECAR_KEY] = {};
    config.plugins[PLUGIN_NAME].enabled = true;
    config.sidecars[SIDECAR_KEY].enabled = true;
    atomicJson(paths.configFile, config);
  }

  if (registerConfig && bootstrapSidecar && existsSync(join(paths.profileDir, 'DevToolsActivePort'))) {
    const ownerRecord = jsonRead(join(paths.dataDir, 'active-sidecar.json'), null);
    if (!isPidAlive(ownerRecord?.pid)) {
      const bridgeDir = join(paths.pluginDir, 'sidecars', 'bridge');
      const mainScript = join(bridgeDir, 'main.mjs');
      if (existsSync(mainScript)) {
        try {
          const child = spawn(process.execPath, ['--max-old-space-size=96', mainScript], {
            cwd: bridgeDir,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();
        } catch {}
      }
    }
  }

  const result = buildStatus(homeDir);
  if (!silent) {
    console.log(JSON.stringify(result, null, 2));
    if (!registerConfig) {
      console.error('提示：已按 --no-register-config 跳过修改 config.json，请在 Antigravity 客户端 Customizations 页面手动启用插件。');
    }
  }
  return result;
}

async function disposeLiveWindowsAndSidecar(paths) {
  const ownerRecord = jsonRead(join(paths.dataDir, 'active-sidecar.json'), null);
  const sidecarPid = ownerRecord?.pid;
  if (Number.isSafeInteger(sidecarPid) && sidecarPid > 0 && sidecarPid !== process.pid) {
    try {
      process.kill(sidecarPid);
    } catch {}
  }
  for (const staleFile of ['active-sidecar.json', 'active-sidecar.json.lock', 'status.json']) {
    const p = join(paths.dataDir, staleFile);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }

  try {
    const targets = await discoverTargets(paths.profileDir);
    await Promise.allSettled(targets.map(async (target) => {
      const conn = new CdpConnection(target.webSocketDebuggerUrl, { timeout: 1500 });
      try {
        await conn.open();
        await conn.command('Runtime.evaluate', { expression: 'window.__agyDragGraftDispose?.();' });
      } finally {
        conn.close();
      }
    }));
  } catch {}
}

/** 安全卸载已安装的插件目录、清理运行窗口钩子，并默认移除 config.json 中的本插件键。 */
export async function uninstall(homeDir, { cleanConfig = true, silent = false } = {}) {
  const paths = resolveHomePaths(homeDir);
  verifySafeTarget(paths.pluginsRoot, paths.pluginDir);

  if (cleanConfig && existsSync(paths.configFile) && statSync(paths.configFile).isFile()) {
    const config = jsonRead(paths.configFile);
    if (isPlainObject(config)) {
      let changed = false;
      if (isPlainObject(config.plugins) && Object.hasOwn(config.plugins, PLUGIN_NAME)) {
        delete config.plugins[PLUGIN_NAME];
        changed = true;
      }
      if (isPlainObject(config.sidecars) && Object.hasOwn(config.sidecars, SIDECAR_KEY)) {
        delete config.sidecars[SIDECAR_KEY];
        changed = true;
      }
      if (changed) {
        atomicJson(paths.configFile, config);
      }
    }
  }

  // 先移除 Sidecar 启动入口阻止宿主 restart_policy 重新拉起进程，再终止占用目录工作路径的 Sidecar 并清理窗口钩子
  for (const entryFile of [
    join(paths.pluginDir, 'sidecars', 'bridge', 'sidecar.json'),
    join(paths.pluginDir, 'sidecars', 'bridge', 'main.mjs'),
  ]) {
    if (existsSync(entryFile)) {
      try {
        unlinkSync(entryFile);
      } catch {}
    }
  }

  await disposeLiveWindowsAndSidecar(paths);

  if (existsSync(paths.pluginDir)) {
    rmSync(paths.pluginDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 50 });
  }

  const result = buildStatus(homeDir);
  if (!silent) {
    console.log(JSON.stringify(result, null, 2));
  }
  return result;
}

function collectFilesSorted(dirPath) {
  const out = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFilesSorted(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.arcname, 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const method = useDeflate ? 8 : 0;
    const compressed = useDeflate ? deflated : raw;
    const crc = crc32(raw);
    const { dosTime, dosDate } = toDosDateTime(entry.mtime);

    const localHeader = Buffer.allocUnsafe(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc >>> 0, 14);
    localHeader.writeUInt32LE(compressed.length >>> 0, 18);
    localHeader.writeUInt32LE(raw.length >>> 0, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, compressed);

    const cdHeader = Buffer.allocUnsafe(46);
    const mode = entry.arcname.endsWith('.sh') ? 0o100755 : 0o100644;
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE((3 << 8) | 20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0x0800, 8);
    cdHeader.writeUInt16LE(method, 10);
    cdHeader.writeUInt16LE(dosTime, 12);
    cdHeader.writeUInt16LE(dosDate, 14);
    cdHeader.writeUInt32LE(crc >>> 0, 16);
    cdHeader.writeUInt32LE(compressed.length >>> 0, 20);
    cdHeader.writeUInt32LE(raw.length >>> 0, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE((mode << 16) >>> 0, 38);
    cdHeader.writeUInt32LE(offset >>> 0, 42);
    cdParts.push(cdHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const cdOffset = offset;
  const cdBuffer = Buffer.concat(cdParts);
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuffer.length >>> 0, 12);
  eocd.writeUInt32LE(cdOffset >>> 0, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuffer, eocd]);
}

/** 生成带顶层目录的离线安装 ZIP 包及其 SHA256 校验文件（零依赖标准 Deflate）。 */
export function packageArchive({ sourceDir = SOURCE, output = null, silent = false } = {}) {
  const rootDir = resolve(sourceDir);
  const manifest = jsonRead(join(rootDir, 'plugin.json'));
  const version = manifest?.version || '0.0.0';
  const outputPath = output
    ? expandHome(output)
    : resolve(join(rootDir, 'dist', `${PLUGIN_NAME}-${version}.zip`));

  const entries = [];
  for (const item of DIST_ITEMS) {
    const src = join(rootDir, item);
    if (!existsSync(src)) {
      throw new Error(`缺少必要发行文件：${item}`);
    }
    const candidates = statSync(src).isDirectory() ? collectFilesSorted(src) : [src];
    for (const filePath of candidates) {
      const rel = relative(rootDir, filePath);
      const parts = rel.split(/[\\/]+/);
      if (parts.some((part) => isIgnored(part))) continue;
      const arcname = [PLUGIN_NAME, ...parts].join('/');
      const st = statSync(filePath);
      let data = readFileSync(filePath);
      if (arcname.endsWith('.sh')) {
        data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
      }
      entries.push({
        arcname,
        data,
        mtime: st.mtime,
      });
    }
  }

  const zipBuffer = buildZipBuffer(entries);
  withAtomicTarget(outputPath, (tmpPath) => {
    writeFileSync(tmpPath, zipBuffer);
  });

  const digest = createHash('sha256').update(zipBuffer).digest('hex');
  const checksumPath = join(dirname(outputPath), `${basename(outputPath)}.sha256`);
  withAtomicTarget(checksumPath, (tmpPath) => {
    writeFileSync(tmpPath, `${digest}  ${basename(outputPath)}\n`, 'utf8');
  });

  const result = {
    package: outputPath,
    checksumFile: checksumPath,
    sha256: digest,
    version,
    files: entries.length,
  };
  if (!silent) {
    console.log(JSON.stringify(result, null, 2));
  }
  return result;
}

function parseCliArgs(argv) {
  let home = homedir();
  let command = null;
  let registerConfig = true;
  let cleanConfig = true;
  let nodePath = null;
  let output = null;
  let help = false;

  const takeValue = (flag, index) => {
    const eq = flag.indexOf('=');
    if (eq >= 0) return { val: flag.slice(eq + 1), nextIndex: index };
    if (index + 1 >= argv.length) throw new Error(`参数 ${flag} 缺少值`);
    return { val: argv[index + 1], nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--home' || arg.startsWith('--home=')) {
      const { val, nextIndex } = takeValue(arg, i);
      home = val;
      i = nextIndex;
    } else if (arg === '--no-register-config') {
      registerConfig = false;
    } else if (arg === '--keep-config') {
      cleanConfig = false;
    } else if (arg === '--node' || arg.startsWith('--node=')) {
      const { val, nextIndex } = takeValue(arg, i);
      nodePath = val;
      i = nextIndex;
    } else if (arg === '--output' || arg.startsWith('--output=')) {
      const { val, nextIndex } = takeValue(arg, i);
      output = val;
      i = nextIndex;
    } else if (arg.startsWith('-')) {
      throw new Error(`未知选项：${arg}`);
    } else if (!command) {
      command = arg;
    } else {
      throw new Error(`多余的参数：${arg}`);
    }
  }

  return { help, home, command, registerConfig, cleanConfig, nodePath, output };
}

function printHelp() {
  console.log([
    'AGY Drag Graft 插件管理工具（零依赖 Node.js >= 22）',
    '',
    '用法:',
    '  node manage.mjs [--home <dir>] <command> [options]',
    '',
    '命令:',
    '  status                             查看插件安装与运行状态',
    '  install [--no-register-config] [--node <path>]',
    '                                     安装插件到 ~/.gemini/config/plugins/agy-drag-graft 并默认在 config.json 中启用',
    '  uninstall [--keep-config]          卸载插件目录、清理窗口钩子并默认移除 config.json 条目',
    '  package [--output <path>]          打包生成离线安装 ZIP 包与 SHA256 校验文件',
  ].join('\n'));
}

/** CLI 入口，解析参数并分派至对应子命令。 */
export async function main(argv = process.argv.slice(2), { nodeVersion = process.versions.node } = {}) {
  assertSupportedNode(nodeVersion);
  const opts = parseCliArgs(argv);
  if (opts.help || !opts.command) {
    printHelp();
    if (!opts.help && !opts.command) {
      throw new Error('必须指定子命令：status | install | uninstall | package');
    }
    return null;
  }

  if (opts.command === 'status') {
    const result = buildStatus(opts.home);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (opts.command === 'install') {
    return install(opts.home, { registerConfig: opts.registerConfig, nodePath: opts.nodePath });
  }
  if (opts.command === 'uninstall') {
    return await uninstall(opts.home, { cleanConfig: opts.cleanConfig });
  }
  if (opts.command === 'package') {
    return packageArchive({ output: opts.output });
  }
  throw new Error(`未知子命令：${opts.command}`);
}

const isDirectEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isDirectEntry) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
