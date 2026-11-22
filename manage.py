"""零依赖 AGY Drag Graft 插件安装、状态检查、打包与卸载管理工具。"""
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import zipfile

SOURCE = Path(__file__).resolve().parent
PLUGIN_NAME = 'agy-drag-graft'
SIDECAR_KEY = 'agy-drag-graft/bridge'
RUNTIME_ITEMS = ('plugin.json', 'assets', 'src', 'sidecars')
DIST_ITEMS = (
    'plugin.json',
    'package.json',
    'LICENSE',
    'README.md',
    'README.en.md',
    'manage.py',
    'install.ps1',
    'install.sh',
    'uninstall.ps1',
    'uninstall.sh',
    'assets',
    'sidecars',
    'src',
    'tests',
)
IGNORED_PATTERNS = ('__pycache__', '*.pyc', '.data', 'data', '*.log', 'node_modules', '*.tmp', 'dist', '.git')


def is_ignored(name):
    return any(fnmatch.fnmatch(name, pattern) for pattern in IGNORED_PATTERNS)


def atomic_copy_file(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dst.with_name(f'{dst.name}.{os.getpid()}.tmp')
    try:
        shutil.copyfile(src, tmp_path)
        shutil.copystat(src, tmp_path)
        os.replace(tmp_path, dst)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def copy_runtime_tree(src, dst):
    dst.mkdir(parents=True, exist_ok=True)
    for entry in src.iterdir():
        if is_ignored(entry.name):
            continue
        target = dst / entry.name
        if entry.is_dir():
            copy_runtime_tree(entry, target)
        elif entry.is_file():
            atomic_copy_file(entry, target)


def json_read(file_path, default=None):
    if not file_path.is_file():
        return {} if default is None else default
    return json.loads(file_path.read_text(encoding='utf-8-sig'))


def atomic_json(file_path, payload):
    file_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = file_path.with_name(f'{file_path.name}.{os.getpid()}.tmp')
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp_path, file_path)


def resolve_home_paths(home_dir):
    home = Path(home_dir).expanduser().resolve()
    if sys.platform == 'win32':
        appdata = Path(os.environ.get('APPDATA') or (home / 'AppData' / 'Roaming'))
        profile_dir = Path(os.environ.get('AGY_DRAG_GRAFT_PROFILE') or (appdata / 'Antigravity'))
    elif sys.platform == 'darwin':
        profile_dir = Path(os.environ.get('AGY_DRAG_GRAFT_PROFILE') or (home / 'Library' / 'Application Support' / 'Antigravity'))
    else:
        xdg_config = Path(os.environ.get('XDG_CONFIG_HOME') or (home / '.config'))
        profile_dir = Path(os.environ.get('AGY_DRAG_GRAFT_PROFILE') or (xdg_config / 'Antigravity'))

    plugins_root = home / '.gemini' / 'config' / 'plugins'
    plugin_dir = plugins_root / PLUGIN_NAME
    config_file = home / '.gemini' / 'config' / 'config.json'
    data_dir = home / '.gemini' / 'antigravity' / 'sidecar_data' / PLUGIN_NAME / 'bridge' / 'data'
    return {
        'home': home,
        'plugins_root': plugins_root,
        'plugin_dir': plugin_dir,
        'config_file': config_file,
        'profile_dir': profile_dir,
        'data_dir': data_dir,
    }


def verify_safe_target(plugins_root, plugin_dir):
    if plugin_dir.is_symlink():
        raise RuntimeError('目标插件路径是符号链接，拒绝覆盖或删除。')
    if plugin_dir.exists():
        if plugin_dir.resolve().parent != plugins_root.resolve():
            raise RuntimeError('目标插件目录不在预期 plugins 根目录下，拒绝操作。')
        manifest = json_read(plugin_dir / 'plugin.json')
        if manifest.get('name') != PLUGIN_NAME:
            raise RuntimeError('目标目录不是 agy-drag-graft 插件安装目录，拒绝覆盖或删除。')


def build_status(home_dir):
    paths = resolve_home_paths(home_dir)
    plugin_dir = paths['plugin_dir']
    manifest = json_read(SOURCE / 'plugin.json')
    installed = (plugin_dir / 'plugin.json').is_file() and json_read(plugin_dir / 'plugin.json').get('name') == PLUGIN_NAME
    config = json_read(paths['config_file'])
    plugins_cfg = config.get('plugins', {}) if isinstance(config.get('plugins'), dict) else {}
    sidecars_cfg = config.get('sidecars', {}) if isinstance(config.get('sidecars'), dict) else {}

    runtime_status_file = paths['data_dir'] / 'status.json'
    runtime_status = json_read(runtime_status_file, default=None) if runtime_status_file.is_file() else None
    installed_sidecar = json_read(plugin_dir / 'sidecars' / 'bridge' / 'sidecar.json', default=None) if installed else None

    return {
        'installed': installed,
        'pluginDirectory': str(plugin_dir),
        'enabledInConfig': plugins_cfg.get(PLUGIN_NAME, {}).get('enabled') if isinstance(plugins_cfg.get(PLUGIN_NAME), dict) else None,
        'sidecarEnabledInConfig': sidecars_cfg.get(SIDECAR_KEY, {}).get('enabled') if isinstance(sidecars_cfg.get(SIDECAR_KEY), dict) else None,
        'debugPortFileExists': (paths['profile_dir'] / 'DevToolsActivePort').is_file(),
        'nodeExecutable': installed_sidecar.get('command') if isinstance(installed_sidecar, dict) else shutil.which('node'),
        'runtimeStatus': runtime_status,
        'sourceVersion': manifest.get('version'),
    }


def install(home_dir, register_config=False, node_path=None):
    paths = resolve_home_paths(home_dir)
    plugins_root = paths['plugins_root']
    plugin_dir = paths['plugin_dir']
    config_file = paths['config_file']

    plugins_root.mkdir(parents=True, exist_ok=True)
    verify_safe_target(plugins_root, plugin_dir)
    plugin_dir.mkdir(parents=True, exist_ok=True)

    for item in RUNTIME_ITEMS:
        src = SOURCE / item
        dst = plugin_dir / item
        if src.resolve() == dst.resolve():
            continue
        if src.is_dir():
            copy_runtime_tree(src, dst)
        else:
            atomic_copy_file(src, dst)

    if sys.platform == 'win32' or node_path:
        node_exe = node_path or shutil.which('node')
        sidecar_manifest = plugin_dir / 'sidecars' / 'bridge' / 'sidecar.json'
        if node_exe and sidecar_manifest.is_file():
            data = json_read(sidecar_manifest)
            if data.get('command') == 'node' or node_path:
                data['command'] = str(node_exe)
                atomic_json(sidecar_manifest, data)

    if register_config:
        config = json_read(config_file)
        if not isinstance(config, dict):
            raise RuntimeError('config.json 结构异常，拒绝写入。')
        plugins_map = config.setdefault('plugins', {})
        if not isinstance(plugins_map, dict):
            raise RuntimeError('config.json 中的 plugins 字段结构异常。')
        sidecars_map = config.setdefault('sidecars', {})
        if not isinstance(sidecars_map, dict):
            raise RuntimeError('config.json 中的 sidecars 字段结构异常。')
        plugins_map.setdefault(PLUGIN_NAME, {})['enabled'] = True
        sidecars_map.setdefault(SIDECAR_KEY, {})['enabled'] = True
        atomic_json(config_file, config)

    result = build_status(home_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not register_config:
        print('提示：尚未修改 config.json，请在 Antigravity 客户端 Customizations 页面启用插件，或使用 --register-config 参数自动启用。', file=sys.stderr)


def uninstall(home_dir, clean_config=False):
    paths = resolve_home_paths(home_dir)
    plugins_root = paths['plugins_root']
    plugin_dir = paths['plugin_dir']
    config_file = paths['config_file']

    verify_safe_target(plugins_root, plugin_dir)
    if plugin_dir.exists():
        shutil.rmtree(plugin_dir)

    if clean_config and config_file.is_file():
        config = json_read(config_file)
        if isinstance(config, dict):
            changed = False
            if isinstance(config.get('plugins'), dict) and PLUGIN_NAME in config['plugins']:
                del config['plugins'][PLUGIN_NAME]
                changed = True
            if isinstance(config.get('sidecars'), dict) and SIDECAR_KEY in config['sidecars']:
                del config['sidecars'][SIDECAR_KEY]
                changed = True
            if changed:
                atomic_json(config_file, config)

    print(json.dumps(build_status(home_dir), ensure_ascii=False, indent=2))


def package(output=None):
    """生成带顶层目录的离线安装 ZIP 包及其 SHA256 校验文件。"""
    manifest = json_read(SOURCE / 'plugin.json')
    version = manifest.get('version') or '0.0.0'
    output_path = Path(output) if output else (SOURCE / 'dist' / f'{PLUGIN_NAME}-{version}.zip')
    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    tmp_zip = output_path.with_name(f'{output_path.name}.{os.getpid()}.tmp')
    packed_count = 0
    try:
        with zipfile.ZipFile(tmp_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
            for item in DIST_ITEMS:
                src = SOURCE / item
                if not src.exists():
                    raise RuntimeError(f'缺少必要发行文件：{item}')
                candidates = sorted(src.rglob('*')) if src.is_dir() else [src]
                for file_path in candidates:
                    if not file_path.is_file():
                        continue
                    rel = file_path.relative_to(SOURCE)
                    if any(is_ignored(part) for part in rel.parts):
                        continue
                    arcname = (Path(PLUGIN_NAME) / rel).as_posix()
                    archive.write(file_path, arcname)
                    packed_count += 1
        os.replace(tmp_zip, output_path)
    finally:
        if tmp_zip.exists():
            try:
                tmp_zip.unlink()
            except OSError:
                pass

    digest = hashlib.sha256(output_path.read_bytes()).hexdigest()
    checksum_path = output_path.with_name(f'{output_path.name}.sha256')
    tmp_sha = checksum_path.with_name(f'{checksum_path.name}.{os.getpid()}.tmp')
    try:
        tmp_sha.write_text(f'{digest}  {output_path.name}\n', encoding='utf-8')
        os.replace(tmp_sha, checksum_path)
    finally:
        if tmp_sha.exists():
            try:
                tmp_sha.unlink()
            except OSError:
                pass

    result = {
        'package': str(output_path),
        'checksumFile': str(checksum_path),
        'sha256': digest,
        'version': version,
        'files': packed_count,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description='AGY Drag Graft 插件管理工具')
    parser.add_argument('--home', default=str(Path.home()), help='指定模拟或目标用户主目录（默认当前用户目录）')
    sub = parser.add_subparsers(dest='command', required=True)

    sub.add_parser('status', help='查看插件安装与运行状态')

    p_install = sub.add_parser('install', help='安装插件到 ~/.gemini/config/plugins/agy-drag-graft')
    p_install.add_argument('--register-config', action='store_true', help='显式在 config.json 中启用插件与 Sidecar')
    p_install.add_argument('--node', default=None, help='显式指定 node 可执行文件路径')

    p_uninstall = sub.add_parser('uninstall', help='卸载已安装的插件目录')
    p_uninstall.add_argument('--clean-config', action='store_true', help='同时从 config.json 移除 agy-drag-graft 相关键')

    p_package = sub.add_parser('package', help='打包生成离线安装 ZIP 包与 SHA256 校验文件')
    p_package.add_argument('--output', default=None, help='显式指定输出 ZIP 路径（默认写入 dist/）')

    args = parser.parse_args(argv)
    if args.command == 'status':
        print(json.dumps(build_status(args.home), ensure_ascii=False, indent=2))
    elif args.command == 'install':
        install(args.home, register_config=args.register_config, node_path=args.node)
    elif args.command == 'uninstall':
        uninstall(args.home, clean_config=args.clean_config)
    elif args.command == 'package':
        package(output=args.output)


if __name__ == '__main__':
    main()
