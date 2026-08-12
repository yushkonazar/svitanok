"""Витягти функції/константи верхнього рівня з web/worker.js у новий модуль.

Утиліта РЕФАКТОРА (Фаза 5): переносить блок «doc-коментар + оголошення» дослівно,
не змінюючи ані рядка тіла. Межі шукає за структурою файлу (оголошення на нульовому
відступі, закриття — рядок рівно `}` чи `});`), а не за номерами рядків, які
зсуваються після кожного вирізу.

Використання:
  python scripts/extract-fn.py <target.mjs> <name1> <name2> ...
Друкує витягнутий текст у <target.mjs>.part і залишок у worker.js НЕ чіпає —
вирізання окремим кроком (--cut), щоб можна було спершу переглянути.
"""

import io
import re
import sys

SRC = 'web/worker.js'


def find_block(lines, name):
    """-> (start, end) 0-based включно; start враховує doc-коментар над оголошенням."""
    pat = re.compile(
        r'^(?:export )?(?:async )?function %s\b|^(?:export )?const %s\b' % (name, name)
    )
    idx = next((i for i, l in enumerate(lines) if pat.match(l)), None)
    if idx is None:
        raise SystemExit('не знайдено оголошення: %s' % name)

    start = idx
    # підняти межу на doc-коментар (/** ... */ або суцільний блок //-рядків)
    j = idx - 1
    if j >= 0 and lines[j].rstrip().endswith('*/'):
        while j >= 0 and not lines[j].lstrip().startswith('/*'):
            j -= 1
        start = j
    else:
        while j >= 0 and lines[j].lstrip().startswith('//'):
            j -= 1
        start = j + 1

    # кінець: перший рядок рівно '}' або '});' на нульовому відступі
    end = None
    for k in range(idx, len(lines)):
        if lines[k] in ('}', '});'):
            end = k
            break
        # однорядкові const-стрілки/значення
        if k == idx and lines[k].rstrip().endswith(';') and not lines[k].rstrip().endswith('{'):
            end = k
            break
    if end is None:
        raise SystemExit('не знайдено кінця: %s' % name)
    return start, end


def main():
    target, names = sys.argv[1], sys.argv[2:]
    cut = '--cut' in names
    names = [n for n in names if n != '--cut']
    lines = io.open(SRC, encoding='utf-8').read().split('\n')

    blocks = []
    for n in names:
        s, e = find_block(lines, n)
        blocks.append((s, e, n))
    blocks.sort()

    part = '\n\n'.join('\n'.join(lines[s : e + 1]) for s, e, _ in blocks)
    io.open(target + '.part', 'w', encoding='utf-8').write(part + '\n')
    print('витягнуто %d блоків -> %s.part' % (len(blocks), target))
    for s, e, n in blocks:
        print('  %-28s рядки %d..%d' % (n, s + 1, e + 1))

    if cut:
        for s, e, _ in reversed(blocks):
            del lines[s : e + 1]
        io.open(SRC, 'w', encoding='utf-8').write('\n'.join(lines))
        print('вирізано з %s' % SRC)


main()
