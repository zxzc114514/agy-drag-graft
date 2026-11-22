import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import manage  # noqa: E402


class ManageLifecycleTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._orig_profile = os.environ.get('AGY_DRAG_GRAFT_PROFILE')
        profile_dir = self.home / 'profile'
        profile_dir.mkdir(parents=True, exist_ok=True)
        os.environ['AGY_DRAG_GRAFT_PROFILE'] = str(profile_dir)

    def tearDown(self):
        if self._orig_profile is None:
            os.environ.pop('AGY_DRAG_GRAFT_PROFILE', None)
        else:
            os.environ['AGY_DRAG_GRAFT_PROFILE'] = self._orig_profile
        self._tmp.cleanup()

    def test_default_install_status_and_uninstall_preserve_config(self):
        config_file = self.home / '.gemini' / 'config' / 'config.json'
        config_file.parent.mkdir(parents=True, exist_ok=True)
        original_config = {
            'plugins': {'antigravity-pulse': {'enabled': True}},
            'sidecars': {'antigravity-pulse/panel': {'enabled': True}},
            'userSettings': {'theme': 'dark'},
        }
        config_file.write_text(json.dumps(original_config), encoding='utf-8')

        # 1) 安装（不传 --register-config）不应修改 config.json
        manage.install(self.home, register_config=False, node_path='C:\\mock\\node.exe')
        self.assertEqual(json.loads(config_file.read_text(encoding='utf-8')), original_config)

        status = manage.build_status(self.home)
        self.assertTrue(status['installed'])
        self.assertIsNone(status['enabledInConfig'])
        self.assertEqual(status['nodeExecutable'], 'C:\\mock\\node.exe')

        plugin_dir = self.home / '.gemini' / 'config' / 'plugins' / 'agy-drag-graft'
        self.assertTrue((plugin_dir / 'plugin.json').is_file())
        self.assertTrue((plugin_dir / 'src' / 'renderer.cjs').is_file())
        self.assertTrue((plugin_dir / 'sidecars' / 'bridge' / 'main.mjs').is_file())
        self.assertEqual(list(plugin_dir.rglob('*.tmp')), [])

        # 2) 卸载后目录被移除
        manage.uninstall(self.home, clean_config=False)
        self.assertFalse(plugin_dir.exists())
        self.assertFalse(manage.build_status(self.home)['installed'])

    def test_register_and_clean_config_keep_unrelated_entries(self):
        config_file = self.home / '.gemini' / 'config' / 'config.json'
        config_file.parent.mkdir(parents=True, exist_ok=True)
        config_file.write_text(
            json.dumps({
                'plugins': {'other-plugin': {'enabled': True}},
                'sidecars': {'other-plugin/side': {'enabled': True}},
            }),
            encoding='utf-8',
        )

        manage.install(self.home, register_config=True, node_path='/usr/local/bin/node')
        after_install = json.loads(config_file.read_text(encoding='utf-8'))
        self.assertEqual(after_install['plugins']['agy-drag-graft']['enabled'], True)
        self.assertEqual(after_install['sidecars']['agy-drag-graft/bridge']['enabled'], True)
        self.assertEqual(after_install['plugins']['other-plugin']['enabled'], True)

        manage.uninstall(self.home, clean_config=True)
        after_uninstall = json.loads(config_file.read_text(encoding='utf-8'))
        self.assertNotIn('agy-drag-graft', after_uninstall['plugins'])
        self.assertNotIn('agy-drag-graft/bridge', after_uninstall['sidecars'])
        self.assertEqual(after_uninstall['plugins']['other-plugin']['enabled'], True)
        self.assertEqual(after_uninstall['sidecars']['other-plugin/side']['enabled'], True)

    def test_refuses_to_overwrite_foreign_plugin_directory(self):
        foreign_dir = self.home / '.gemini' / 'config' / 'plugins' / 'agy-drag-graft'
        foreign_dir.mkdir(parents=True, exist_ok=True)
        (foreign_dir / 'plugin.json').write_text(json.dumps({'name': 'someone-else'}), encoding='utf-8')

        with self.assertRaises(RuntimeError):
            manage.install(self.home)
        with self.assertRaises(RuntimeError):
            manage.uninstall(self.home)

    def test_package_builds_verified_zip_and_sha256(self):
        out_zip = self.home / 'dist' / 'agy-drag-graft-test.zip'
        res = manage.package(output=out_zip)
        self.assertTrue(out_zip.is_file())
        sha_file = Path(res['checksumFile'])
        self.assertTrue(sha_file.is_file())

        expected_sha = hashlib.sha256(out_zip.read_bytes()).hexdigest()
        self.assertEqual(res['sha256'], expected_sha)
        self.assertEqual(sha_file.read_text(encoding='utf-8').split(), [expected_sha, out_zip.name])

        with zipfile.ZipFile(out_zip, 'r') as archive:
            names = set(archive.namelist())
            for req in (
                'agy-drag-graft/plugin.json',
                'agy-drag-graft/manage.py',
                'agy-drag-graft/install.ps1',
                'agy-drag-graft/install.sh',
                'agy-drag-graft/src/renderer.cjs',
                'agy-drag-graft/src/cdp-runtime.mjs',
                'agy-drag-graft/sidecars/bridge/main.mjs',
                'agy-drag-graft/LICENSE',
            ):
                self.assertIn(req, names)
            self.assertFalse(any('__pycache__' in name or name.endswith('.pyc') for name in names))


if __name__ == '__main__':
    unittest.main()
