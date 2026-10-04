# Security

## Threat model (summary)

IoT-OS runs compilers, uploaders and package managers, opens serial ports, edits files and sends project context to cloud LLMs. The main risks are command/argument injection, path traversal, unreviewed AI actions, secret leakage, and a compromised renderer abusing the backend.

## Controls

**Process execution** (`main/process`)
- Only allowlisted tools (`TOOL_SPECS`) can run; there is no generic shell or "run command" API, for the UI or the AI.
- `spawn(..., { shell: false })` with argument arrays — no shell parsing. On Windows `.cmd/.bat` shims are never selected (they would require a shell).
- Values passed after positional slots that could be read as options (ports, library/package names, search terms) are rejected/filtered if they start with `-` (argument injection).
- Every run has a timeout; cancellation kills the whole process group.
- Child processes do not inherit AI keys or the host token (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `IOTOS_HOST_TOKEN`, `IOTOS_*_BASE_URL`).
- Command lines and output shown in the UI/logs are redacted.

**Filesystem** (`main/fs/projectFs.ts`)
- All file APIs are project-relative; absolute paths, `..` escapes and symlinks resolving outside the project are rejected.
- Writes are atomic (temp + rename) with optional external-modification detection.
- Project model files can only be changed through validated model APIs; they cannot be deleted/renamed from the editor.
- Deleting projects/files moves them to the OS trash (Electron) or an IoT-OS trash folder — nothing is destroyed. Project deletion refuses folders that are not IoT-OS projects.

**API boundary** (`main/api.ts`)
- One router; unknown methods are rejected; every argument is validated with zod.
- `app.openExternal` only opens `https:` URLs on an allowlist of vendor/documentation hosts.

**Electron**
- `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`; the preload exposes only `call` and `onEvent`.
- IPC calls from frames other than the app are rejected; navigation away and `window.open` are blocked; all permission requests are denied; a Content-Security-Policy (`script-src 'self'`) is applied.

**Browser host** (`main/host/server.ts`)
- Binds to `127.0.0.1` only; a random per-run token (constant-time compared) is required on every API call and the event stream; `Host` must be `127.0.0.1:<port>`/`localhost:<port>` (blocks DNS rebinding); cross-origin `Origin` is rejected; CSP and `nosniff` on static files; static files confined to the build folder; 10 MB request limit. The token travels in the URL fragment (not sent to servers) and in a header; the SSE stream uses a query parameter.

**Secrets**
- Keys are stored with Electron `safeStorage` (OS keychain) when available, else a `0600` file in the user data directory; environment variables override. They are never returned to the UI (only `hasKey`), never written to `settings.json`, redacted from logs (pattern + registered values) and from diagnostics exports, and stripped from child process environments.

**AI**
- No tool use, no command execution, no direct writes. Structured outputs are schema-validated; hardware proposals pass deterministic validation; every change is a reviewable proposal with conflict detection.
- Project context sent to the provider is visible in the Copilot panel and can be reduced per section.

**Drivers**
- IoT-OS never downloads or installs drivers. It identifies the USB-serial chip, determines whether a port exists, explains OS-specific guidance and opens the vendor's official page after explicit confirmation.

**Dependencies**
- `npm audit --omit=dev`: 0 known vulnerabilities at the time of writing (DOMPurify pinned to ≥ 3.4.16 through `overrides` because Monaco 0.57 shipped 3.4.15, GHSA-p98j-92pf-mc4p, low).
- Install scripts are allowed only for `@serialport/bindings-cpp` and `esbuild`.

## Not covered / residual risk

- Firmware and libraries you build run on your hardware; IoT-OS does not sandbox compilation.
- User-supplied regular expressions (search, serial filter) run in-process.
- The browser host is meant for local development; do not expose it on a network interface.
