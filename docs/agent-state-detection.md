# Agent state detection

Swarmie classifies supported interactive agents into four internal lifecycle
states:

- `working`: the agent is actively processing or running a tool.
- `idle`: the input prompt is visibly ready for a new task.
- `blocked`: a visible confirmation or selection requires user input.
- `unknown`: the screen does not provide enough evidence.

The classifier reads the rendered headless terminal, not raw PTY fragments.
Rules are kept separately for Claude Code, Codex, and Gemini CLI under
`src/detection/manifests/`.

## Detection modes

Set `SWARMIE_DETECTION_MODE` before starting Swarmie:

| Mode | Behavior |
|:-----|:---------|
| `active` | Default. Publish strong visible `working`, `idle`, and `blocked` results; fall back to established heuristics for weak or unknown screens. |
| `shadow` | Evaluate and explain rules while the established classifier continues to publish status. |
| `legacy` | Record explanations but never publish the new classifier's result. |

Set `shadow` temporarily when comparing a new rule set against established
behavior without changing the dashboard status.

## Explain API

For a running session:

```text
GET /api/sessions/:id/detection
```

The response includes the selected manifest and version, matched rule,
priority, screen region, stable state, raw state, stabilization decision, and a
comparison with the established classifier.

Terminal text is excluded by default. An authenticated diagnostic request can
include a short region preview:

```text
GET /api/sessions/:id/detection?includeText=1
```

Treat that response as sensitive because an agent prompt may contain commands,
paths, or credentials.

## Wait API

Automation can wait for either a published session status or an internal
lifecycle state:

```text
GET /api/sessions/:id/wait?state=done,blocked,error&afterSeq=42&timeoutMs=30000
```

Supported lifecycle aliases are `working`, `idle`, `blocked`, and `unknown`.
Published statuses such as `thinking`, `tool_executing`, `waiting_input`, and
`done` are also accepted. `afterSeq` requires a transition newer than the
caller's last `stateChangeSeq`, preventing an old idle state from satisfying a
wait for the next task. The maximum timeout is 24 hours. A timeout
returns HTTP 200 with `reached: false` so callers can distinguish it from a
bad request or missing session.

After a real work cycle, the published status becomes `done` and remains there
until the active browser acknowledges it. Session summaries expose `seen` and
`stateChangeSeq`; a client can acknowledge explicitly with:

```text
POST /api/sessions/:id/seen
```

State rule transitions are emitted as `agent:state` events. The payload only
contains state evidence and rule identifiers, never terminal text.

## Automatic approval

Automatic approval requires all of the following:

1. A blocker is visibly present in the current rendered screen.
2. A built-in rule explicitly marks the prompt safe for automation.
3. The selection cursor is currently on the first affirmative option.
4. The prompt fingerprint remains stable for the configured dwell period.

A waiting status, an unselected Yes/No list, a cursor on `No`, a model picker,
or an arbitrary numbered menu can still produce `blocked`, but cannot send a
key. Each automatic Enter is recorded as an `automation:action` event with the
rule ID, CR/LF encoding, and attempt number; prompt text is not recorded.

## Rule safety

A visible blocker is stronger than a question or an isolated keyword. Rules
should require stable UI structure such as a numbered selection, confirmation
key hint, input prompt, or persistent working affordance.

When adding a rule:

1. Put it in the matching agent manifest.
2. Prefer a small bottom or prompt region over `whole_recent`.
3. Add a positive fixture and at least one prose/source-code false-positive fixture.
4. Give narrow structural rules higher priority than broad fallback rules.
5. Use `skipStateUpdate` for viewers or modals that temporarily cover the live UI.
6. Only set `automationSafe` when the rule proves that Enter accepts the visible affirmative selection.

The rule engine validates duplicate IDs, regex syntax, matcher size, nesting
depth, region bounds, and invalid combinations before accepting a manifest.
