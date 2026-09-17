"""Print bounded, numbered ANSI history for manual browser regression tests.

Run in a disposable Swarmie session: python3 fixtures/terminal-history-stress.py
Switch away during output, then reload and repeatedly scroll up to load pages.
Use --live for a ten-second tail while testing delayed/cancelled history loads.
Use --redraw for pages of cursor redraws followed by a clear-scrollback command:
after reloading, upward scrolling alone must reach UX_OLDER_BOUNDARY.
Use --integrity for numbered Unicode rows, wrapping and in-place replacements.
"""

import sys
import time

if '--integrity' in sys.argv:
    for start in range(0, 15000, 100):
        batch = []
        for i in range(start, start + 100):
            batch.append(
                f'\r\x1b[2Ktransient {i}\r\x1b[2K'
                f'CHECK[{i:05d}] \x1b[32m中文🙂边界\x1b[0m '
                f'{"abcdefghij" * (3 if i % 3 else 12)} END[{i:05d}]\r\n'
            )
        sys.stdout.write(''.join(batch))
        sys.stdout.flush()
        time.sleep(0.005)
    print('UX_INTEGRITY_COMPLETE', flush=True)
elif '--redraw' in sys.argv:
    print('UX_OLDER_BOUNDARY', flush=True)
    for i in range(1000):
        print(f'UX_OLDER {i:04d}')
    # >2 history pages of animation, without adding scrollback lines.
    frame = '\x1b[?2026h\r\x1b[2K' + 'working... ' * 5 + '\x1b[?2026l'
    for _ in range(300):
        sys.stdout.write(frame * 100)
        sys.stdout.flush()
        time.sleep(0.003)
    sys.stdout.write('\x1b[2J\x1b[3J\x1b[H')
    for i in range(100):
        print(f'UX_RECENT {i:04d}')
    print('UX_REDRAW_COMPLETE', flush=True)
elif '--live' in sys.argv:
    for i in range(200):
        print(f'UXLIVE {i:04d} — output during history loading', flush=True)
        time.sleep(0.05)
    print('UXLIVE COMPLETE', flush=True)
else:
    time.sleep(1)
    for start in range(0, 75000, 250):
        lines = []
        for i in range(start, start + 250):
            lines.append(
                f'\x1b[38;2;110;130;140mUXH {i:06d}\x1b[0m | '
                '\x1b[38;2;80;150;120mhistory scroll regression\x1b[0m | '
                '\x1b[38;2;140;120;100m0123456789 abcdefghij\x1b[0m\r\n'
            )
        sys.stdout.write(''.join(lines))
        sys.stdout.flush()
        time.sleep(0.01)
    print('UXH COMPLETE — 75000 rows', flush=True)
