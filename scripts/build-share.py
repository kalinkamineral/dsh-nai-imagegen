#!/usr/bin/env python3
"""Build the friend-share bundle.

Produces `dist/dsh-nai-imagegen-friend-<version>.zip`:

    dsh-nai-imagegen-friend/
      README-friend.md
      plugin/dsh-nai-imagegen/   (the plugin itself)

No personal data is included: config.json, logs, _in and dist are skipped, and
.git / node_modules are skipped because the package needs none of them.
The release workflow runs this on every tag; it can also be run locally:

    python3 scripts/build-share.py
"""

import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = 'dsh-nai-imagegen-friend'
SKIP_DIRS = {'.git', '.github', 'node_modules', '_in', 'logs', 'dist', '__pycache__'}
# Generated previews and save-ready copies are the user's art, not code.
SKIP_PREFIXES = ('assets/thumbs/', 'assets/full/')
SKIP_FILES = {'.gitignore', '.gitattributes'}


def main():
    with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as handle:
        version = json.load(handle)['version']
    out_dir = os.path.join(ROOT, 'dist')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f'{NAME}-v{version}.zip')

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        # The share README sits at the package root.
        archive.write(
            os.path.join(ROOT, 'share', 'README-friend.md'),
            f'{NAME}/README-friend.md',
        )
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            rel_dir = os.path.relpath(dirpath, ROOT)
            for name in sorted(filenames):
                if name in SKIP_FILES or name.endswith('.orig'):
                    continue
                rel = os.path.normpath(os.path.join(rel_dir, name)) if rel_dir != '.' else name
                rel_path = rel.replace(os.sep, '/')
                if any(rel_path.startswith(prefix) for prefix in SKIP_PREFIXES):
                    continue
                arc = f'{NAME}/plugin/dsh-nai-imagegen/{rel_path}'
                archive.write(os.path.join(dirpath, name), arc)
    print(f'{out} ({os.path.getsize(out)} bytes)')


if __name__ == '__main__':
    main()
