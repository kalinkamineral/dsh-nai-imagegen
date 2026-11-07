"""Remove the entries the offline test suite wrote into the real render log.

Before tests/run.mjs existed, `npm run verify` ran with the user's DSH_HOME, so
each run appended five deliberately failing cases to today's log. This filters
exactly those entries (by their fixed summaries), keeps a `.bak` copy next to
each file, and prints how many lines were removed.

Usage: python scripts/clean-test-log.py
"""

import io
import os
import shutil

LOG_DIR = os.path.join(os.path.expanduser('~'), '.dsh', 'nai-imagegen', 'logs')

# The summaries the offline suite produces, verbatim.
TEST_SUMMARIES = [
    '接口出错：GET /source-file · file name must not contain a path',
    '出图失败：底图不存在：__definitely_missing__.png',
    '请求被拒：mask 必须是 PNG（用 alpha 通道标记重绘区）',
    '出图失败：蒙版尺寸 32×32 必须与输出尺寸 64×64 一致',
    '导演工具失败（bg-removal）：不支持的导演工具：bg-removal',
    '导演工具失败（lineart）：ENOENT: no such file or directory, open',
    '__definitely_missing__.png',
]


def is_test_entry(line):
    return any(marker in line for marker in TEST_SUMMARIES)


def main():
    if not os.path.isdir(LOG_DIR):
        print('no log directory:', LOG_DIR)
        return
    total_removed = 0
    for name in sorted(os.listdir(LOG_DIR)):
        if not name.endswith('.jsonl'):
            continue
        path = os.path.join(LOG_DIR, name)
        with io.open(path, encoding='utf-8', errors='replace') as handle:
            lines = handle.readlines()
        kept = [line for line in lines if line.strip() and not is_test_entry(line)]
        removed = len(lines) - len(kept)
        if removed == 0:
            continue
        shutil.copyfile(path, path + '.bak')
        with io.open(path, 'w', encoding='utf-8', newline='') as handle:
            handle.writelines(kept)
        total_removed += removed
        print(f'{name}: removed {removed}, kept {len(kept)} (backup: {name}.bak)')
    print(f'total removed: {total_removed}')


if __name__ == '__main__':
    main()
