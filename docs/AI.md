# AI architecture

```
UI (Copilot, Problems, Simulator, Home)          — never sees API keys
   │ ai.* methods
AiService (main)  — assembles context from live services, keeps chat history, creates proposals
   │
core/ai/tasks.ts  — chat · explain · editCode · analyze(build|serial) · planCircuit · planProject
   │  (pure; provider injected; structured outputs validated + bounded repair loop)
AIProvider interface ── AnthropicProvider · OpenAIProvider · GeminiProvider (official SDKs)
```

## Providers

Selected in Settings → AI; each has a configurable model. Defaults: Anthropic `claude-opus-5-5`, OpenAI `gpt-5`, Gemini `gemini-2.5-pro` (the OpenAI/Gemini defaults could not be verified against live model lists during development — confirm them for your account). Keys come from Settings (OS keychain / 0600 file) or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`. `IOTOS_<PROVIDER>_BASE_URL` overrides the endpoint (proxies/gateways; also used by the E2E tests).

Anthropic specifics: requests send no sampling parameters (current Claude models reject them), thinking blocks are filtered from the answer, `stop_reason: "refusal"` is surfaced as an error, and server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) are enabled for models that support them.

## Context engine (`core/ai/context.ts`)

Sections: PROJECT, HARDWARE, CIRCUIT (components, wires, derived pin map), DIAGNOSTICS, ACTIVE FILE (line-numbered; unsaved editor content), SOURCE FILES (windows of ±15 lines around error lines), DEPENDENCIES, TOOLCHAIN, DEVICE, BUILD OUTPUT, SERIAL OUTPUT (tail + detected runtime signatures), SIMULATOR.

Per intent (chat, explain-code, edit-code, fix-build, debug-serial, generate-firmware, hardware) sections have priorities. A token budget (default 16 000, configurable) is filled in priority order; build/serial output is truncated keeping the tail, files keeping the head; non-truncatable sections are dropped when they don't fit. The output is deterministic. The Copilot panel shows a live preview of included sections and token estimate; users can exclude sections per request.

## Tasks

| Task | Output | Safeguards |
|---|---|---|
| Chat / explain | Markdown text | system prompt requires separating observed facts, likely causes and assumptions |
| Edit code / generate firmware | `{summary, edits[{path, content}], notes}` | zod schema; paths must be project-relative under `src/ include/ docs/ lib/`; the generated pin config and `.iotos/` are never editable; disallowed edits are rejected and the model is asked to repair; result becomes a **proposal** |
| Fix build / debug serial | `{summary, observations, likelyCauses[{cause, confidence, evidence}], assumptions, suggestedFixes, edits}` | confidence is explicit; edits become a proposal |
| Circuit change | `{summary, components, connections, remove, wifi?, notes}` | registry check (types, props, pins) → applied to the circuit → hardware validation → ERROR/BLOCKING fed back (≤ 3 calls) → proposal with circuit.json, hardware.json (if changed) and the regenerated pin config |
| Project builder | requirements, board, components, connections, firmware, dependencies, overview, assumptions | registry + language checks → `buildProject` → validation → firmware symbols checked against the generated config → repair loop → preview; the project is created only when the user clicks **Create project** |

## What the AI cannot do

Run commands, install anything, flash devices, write files directly, or see API keys. Every change is a proposal reviewed as a diff (accept all, reject, or select individual change blocks); applying checks that files did not change since the proposal and re-validates project model files.
