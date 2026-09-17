# Terminal interaction and history regression — 2026-09-17

Continuous rendering while reading history:

- Removed the follow-state gates that parked live writes while scrolled up.
  Active terminals now keep parsing/rendering output; follow state controls
  only whether to scroll to the live edge. The new-output indicator reports
  unseen output, not a paused renderer.
- Normal-buffer wheel gestures without application mouse tracking now update
  xterm's logical viewport synchronously through scrollLines. The old native
  DOM scroll event could lose the race against a live write and pull the user
  straight back to the bottom. Fractional wheel movement is accumulated, and
  delta modes, sensitivity and Alt fast scrolling remain supported.
- Browser check with a continuous 200-line producer: buffer length advanced
  from 3,062 to 3,246 while viewportY stayed at 2,986. Six samples over 10.8 s
  had identical visible rows. Jumping to latest immediately displayed the
  completion marker. Scrolling down to the bottom also resumed following as
  further output arrived.
- At 4× CPU slowdown, 1,301 upward gestures during output traversed both pages
  of the 15,000-record fixture, with no stuck load or viewport mismatch.
- A headless regression verifies that live writes advance the terminal while
  retaining visible content, including after the scrollback cap evicts earlier
  rows. All 182 related unit tests passed; the isolated browser build passed.
  This supersedes earlier descriptions of intentionally parking all output
  while reading. History reconstruction still temporarily queues live bytes
  until the replacement buffer and scroll position are ready.

Continuous-scroll freeze follow-up:

- Unlike the earlier one-gesture-per-page runs, dispatching upward wheel
  gestures every 60 ms DURING replay at 4× CPU slowdown reproduced another
  stuck boundary. Loading completed, but native scrollTop remained 0 while
  xterm viewportY was 67 (a second run stuck at 407). Hundreds of subsequent
  upward gestures produced no further request. This was a persistent viewport
  desynchronization, not a network timeout or a blocked main thread.
- xterm restores its logical viewport synchronously and updates native
  scrollTop on an animation frame, suppressing the resulting scroll event.
  An intervening wheel can replace that scrollTop update before the suppressed
  event is consumed. Guarding only the parsing phase still reproduced the bug.
- Wheel/touch movement and touch inertia are now excluded from the temporary
  replay buffer. Replay finishes only after two animation frames allow xterm's
  native viewport update/event to settle. Output received during those frames
  remains captured and is drained on completion; keyboard-requested return to
  live is retained.
- Four successful reruns completed 60 page loads total: 313 gestures at 60 ms
  (4× CPU); 1,048 gestures at 16 ms with concurrent output and two real server
  resyncs (4×); 1,089 realistic -600 px gestures at 16 ms (4×); and 658 gestures
  at 16 ms (normal CPU). Every run completed all 15 pages, reached the retained
  boundary, cleared Loading, and reported no browser errors. Final two runs
  measured zero persistent DOM/logical viewport mismatch.
- Longest load was about 1.26 s at 4× slowdown and 258 ms at normal speed.
  Slowdown runs still had brief main-thread stalls (up to 110 ms); no >=50 ms
  task was recorded in the normal-speed rerun. This establishes the tested
  race fix, not a guarantee against every possible freeze.
- `fixtures/history-scroll-regression.js` preserves the browser regression
  procedure. The relevant 30 unit regressions and isolated build passed.
  Port 3200 remained PID 3131; only the :33219 preview was rebuilt.

Content-integrity follow-up:

- Compared each fetched cache range byte-for-byte with a separate server
  snapshot, then compared every rendered row against a fresh terminal rendering
  the same bytes at the same 86×32 geometry. Test-only inspectors stayed in the
  isolated app and are not part of the source changes.
- `--integrity` emits 15,000 numbered Unicode rows with ANSI colors, wrapping,
  and overwritten transient text. All 15,000 IDs appeared exactly once, in
  order; the 20,003 screen rows matched the reference, and no transient text
  remained. Every page's cached bytes matched the source.
- The real combined capture exposed a genuine chunk-dependent character
  difference on page 8. xterm 5.5's UTF-8 decoder tests an interim continuation
  byte after masking with 0x3f; a valid 0x80 byte looks like an empty slot.
  Splitting `e2 80 a2` (•) can therefore delete it and shift subsequent cursor
  updates. The browser's one-write reference also splits large writes
  internally, so it was affected too. A native streaming TextDecoder now
  decodes raw bytes before xterm receives Unicode strings. Replay/resync reset
  its carry; live and history writes use the same decoder. All 15 real history
  pages now match both the raw source and every reference row.
- A concurrent-history/live-output run also exposed a cache rollback and
  duplicated recent rows. `writeResyncToTerminal` previously replaced the
  entire cache and replayed the server's whole recent tail even when its byte
  range overlapped the cache. Overlapping resyncs now retain loaded history
  and pass only unseen bytes through normal deduplication; stale resyncs are
  ignored. Genuinely disjoint ranges still use the existing resync path.
- The browser regression exercised ongoing output during paging and injected
  an overlapping type-2 resync frame through the actual WebSocket handler.
  Result: 15,000 numbered rows plus three complete 200-row live runs, no missing
  or duplicate IDs, 20,612 screen rows identical to the reference, and a
  contiguous cache starting at byte 0.
- Reading-position check during a further live run retained visible rows 2–6
  exactly. The first row gained its previously unloaded `CHECK[13337]` prefix:
  repairing the truncated first line at a page boundary is expected, not a
  duplicated record.
- Regression coverage includes every split of Unicode text, one-byte xterm
  writes, the 16 KB replay boundary, decoder reset, and overlapping/stale
  resyncs. These checks do not claim to reconstruct original layouts across
  historical terminal-width changes or bytes already evicted by the server.

Root-cause follow-up (supersedes the initial inconclusive stress test below):

- Read-only captures from the two reported sessions contained 16,080,980 bytes
  (Quant) and 7,854,394 bytes (current Swarmie session). No input was sent to
  those sessions. The current session contained `ESC[3J` at byte offsets
  635,959 and 7,688,414. These commands erase terminal scrollback.
- Replaying the current capture into the disposable test terminal reproduced
  the stuck boundary with the original `TerminalView`: after the first load,
  the buffer stayed at 1,211 lines and viewport row 0. Twenty upward wheel
  gestures produced only one history response. There were no browser errors
  or >=50 ms long tasks in that run: this was a paging/content bug, not a
  permanently blocked JavaScript thread.
- Two causes compound: rebuilding the entire raw cache executes old ED(3)
  commands and deletes the newly fetched rows; once the viewport remains at
  row 0, further upward gestures do not change scrollTop, so the native scroll
  event that previously triggered loading never fires again.
- The fix ignores ED(3) only during history rebuild, through xterm's parser
  (including sequences split across writes). Live clear-scrollback still
  works. Upward wheel/touch gestures now also check for older history directly,
  retaining the loading guard and cooldown. Focus reports generated by replayed
  DECSET 1004 are ignored during rebuilding so they do not trigger a jump live.
- The same combined test buffer (Quant capture followed by current capture)
  then loaded 15 pages and grew from 1,211 to 5,582 lines. Each intermediate
  page retained a position above the live edge; no spurious input was sent.
- A public deterministic fixture, `--redraw`, independently reproduces both
  causes: original code stays at 103 lines after repeated upward gestures;
  even manually fetching the second page leaves 103 lines because ED(3)
  erases the fetched prefix. Fixed code reaches 1,073 lines using the wheel
  alone and displays `UX_OLDER_BOUNDARY`. No cancellation button is involved.
- A headless xterm regression verifies split ED(3), preservation of older
  scrollback, normal screen clearing, and live ED(3) after replay ends.

Tested through a separate Chrome tab at `http://127.0.0.1:33219/`, backed by a
copy of the app in `/private/tmp/swarmie-ux-20260917/app`. The user's port 3200
process (PID 3131) was not stopped or restarted. Root-cause comparison builds
used the isolated copy. One diagnostic build was accidentally run from the
main repository and updated its web assets; the final root-cause fixes were
built and verified in the isolated copy.

An actual `cxh` conversation returned a Chinese greeting and Markdown table.
A second shell session generated 75,000 numbered, colored lines (~10 MB),
then a 200-line live tail. Reloading the browser retained only the initial
recent tail, so scrolling up exercised real WebSocket history requests and
buffer rebuilds, not just scrolling already loaded text.

| Scenario | Observation before changes | Result after changes |
| --- | --- | --- |
| Repeatedly scroll to the top, 10 history pages | Completed; roughly 60–176 ms per load on this machine | Still reaches earliest retained content |
| Same test with Chrome 4× CPU slowdown | Numerous 50–82 ms main-thread long tasks; loads roughly 222–690 ms | No >=50 ms long tasks in the measured 10-page run; loads roughly 183–862 ms |
| Drop incoming `history:snapshot` responses | Full terminal overlay, keyboard input swallowed; four attempts over ~24 s before recovery | Small cancellable notice; input forwarded immediately; cancellation restores controls |
| Drop first response, allow retry | — | Retry completes at ~6 s; typed input remains present and view returns to live output |
| Cancel while viewing old output | No cancellation control | Reading position remains unchanged; retry remains available; terminal retains focus |
| Output continues while history response is delayed | — | Visible rows remain identical while reading; Back to latest cancels the wait and displays the live tail through `UXLIVE 0199` and `UXLIVE COMPLETE` |
| Search old output, switch tabs, switch back | Search did not clear follow mode and could snap back to bottom | Exact visible text and viewport position preserved (tested at `UXH 070000`) |
| Search for absent text | No feedback | `No matches` appears |
| Close Settings with Escape | Focus returned to the Settings button after a pointer click | Focus returns to the terminal; keyboard navigation still returns to its trigger |
| Resize 1335×844 → 960×700 → 1335×844 | — | Terminal reflows, no page horizontal overflow, no stuck history overlay |

The smaller replay writes trade some total replay time for responsiveness:
16 KB slices replace potentially megabyte-sized atomic xterm writes. The
timings above are a local sample, not a guarantee for all devices or servers.
This initial synthetic run did not reproduce the reported stuck boundary.
Artificial response loss and swallowed keystrokes were separate findings;
they did not establish the user's root cause. The real-stream and deterministic
reproductions above establish the history erasure and missing-gesture causes.

Additional fixes and regression coverage:

- Keep Codex synchronized redraw frames together across arbitrary PTY splits;
  release unfinished frames after one second or a bounded byte limit.
- Ordinary typing/navigation in a waiting prompt no longer emits repeated
  waiting → running → waiting transitions.
- Reject cancelled or duplicate history responses before they mutate loaded
  offsets or the "reached earliest" flag.
- Always offer Back to latest when viewing scrollback, even without new output.
- Show replay progress and avoid treating reset/replay movement as a user scroll.

Validation: 175 tests across activity detection, adapters, sessions, detection,
terminal frames/queries/bus/anchors and focus policy passed. Isolated Vite
production builds passed; the last browser pass had no console errors or
warnings. Both captured live Codex streams retained all bytes when passed
through the frame buffer, with no incomplete synchronized frame exposed.

To reproduce the long-history case, run
`python3 fixtures/terminal-history-stress.py` in a disposable terminal, switch
to another tab during output, then reload and repeatedly scroll to the top.
Use `--live` to add ongoing output while loading. DevTools CPU throttling at
4× makes main-thread stalls easier to see. For failure injection, intercept
only `history:snapshot` messages in the test page before its application
message handler; do not drop normal input/output or mutate the server.

`__swarmieTerm()` reports geometry without terminal text.
`__swarmieTerm(true)` additionally returns visible rows for explicit local
anchor comparisons.
