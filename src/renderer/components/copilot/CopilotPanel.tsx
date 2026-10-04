import { Bot, CircuitBoard, Code2, GitCompare, Hammer, Radio, Send, Square, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BuiltContext, ContextSectionId } from '../../../core/ai/context';
import type { ChatTurn } from '../../../core/ipc/contract';
import { call } from '../../api/client';
import { activeFilePath, contextOptions, runCommand } from '../../commands';
import { useProject } from '../../state/project';
import { useAi, useBuild, useSerial } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { Markdown } from './Markdown';

type Mode = 'ask' | 'edit' | 'circuit';

const SECTION_LABELS: Record<ContextSectionId, string> = {
  project: 'Project',
  hardware: 'Hardware',
  circuit: 'Circuit',
  diagnostics: 'Diagnostics',
  'active-file': 'Active file',
  source: 'Source',
  dependencies: 'Libraries',
  toolchain: 'Toolchain',
  device: 'Device',
  build: 'Build output',
  serial: 'Serial',
  simulator: 'Simulator',
};

function Turn({ t }: { t: ChatTurn }) {
  const ui = useUi();
  return (
    <div className={`msg ${t.role}${t.error ? ' error' : ''}`}>
      <div className="who">
        {t.role === 'user' ? 'You' : 'Copilot'}
        <span className="faint" style={{ fontWeight: 400 }}>
          {new Date(t.t).toLocaleTimeString()}
        </span>
      </div>
      <div className="body">
        <Markdown text={t.content} />
        {t.error?.hint && <p className="muted">{t.error.hint}</p>}
      </div>
      {t.analysis && (
        <div className="analysis" style={{ marginTop: 6 }}>
          {t.analysis.observations.length > 0 && (
            <>
              <h5>Observed</h5>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {t.analysis.observations.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </>
          )}
          {t.analysis.likelyCauses.length > 0 && (
            <>
              <h5>Likely causes</h5>
              {t.analysis.likelyCauses.map((c) => (
                <div key={c.cause}>
                  <span className={`badge ${c.confidence === 'high' ? 'err' : c.confidence === 'medium' ? 'warn' : ''}`}>{c.confidence}</span> {c.cause}
                  {c.evidence && <div className="faint">Evidence: {c.evidence}</div>}
                </div>
              ))}
            </>
          )}
          {t.analysis.assumptions.length > 0 && (
            <>
              <h5>Assumptions</h5>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {t.analysis.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {t.analysis.suggestedFixes.length > 0 && (
            <>
              <h5>Suggested fixes</h5>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {t.analysis.suggestedFixes.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {t.proposalId && (
        <button className="btn sm" style={{ marginTop: 6 }} onClick={() => ui.openTab({ id: `proposal:${t.proposalId}`, kind: 'proposal', title: 'Review changes', proposalId: t.proposalId! })}>
          <GitCompare size={12} /> Review proposed changes
        </button>
      )}
      {t.context && t.role === 'assistant' && (
        <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
          Context: {t.context.filter((s) => s.included).map((s) => `${SECTION_LABELS[s.id]}${s.truncated ? '*' : ''}`).join(', ')}
        </div>
      )}
    </div>
  );
}

export function CopilotPanel() {
  const { status, history, busy, exclude, toggleExclude, run } = useAi();
  const snapshot = useProject((s) => s.snapshot);
  const lastBuild = useBuild((s) => s.last);
  const serialLines = useSerial((s) => s.version);
  const activeTabId = useUi((s) => s.activeTabId);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('ask');
  const [ctx, setCtx] = useState<BuiltContext | null>(null);
  const chat = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chat.current) chat.current.scrollTop = chat.current.scrollHeight;
  }, [history.length, busy]);

  // Live preview of exactly what context the next chat message will include.
  useEffect(() => {
    if (!snapshot) {
      setCtx(null);
      return;
    }
    const t = setTimeout(() => {
      call('ai.previewContext', { intent: 'chat', options: contextOptions() })
        .then(setCtx)
        .catch(() => setCtx(null));
    }, 300);
    return () => clearTimeout(t);
  }, [snapshot, exclude, activeTabId, lastBuild, serialLines > 0]);

  const send = () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setText('');
    if (mode === 'ask') void run('Thinking', () => call('ai.chat', { message: msg, options: contextOptions() }));
    else if (mode === 'edit') void run('Writing code', () => call('ai.editCode', { instruction: msg, options: contextOptions() }));
    else void run('Designing circuit', () => call('ai.planCircuit', { request: msg }));
  };

  return (
    <>
      <div className="sidebar-head" style={{ borderBottom: '1px solid var(--border)' }}>
        <Bot size={14} style={{ marginRight: 6 }} />
        <span className="grow">Copilot</span>
        <span className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          {status?.configured ? status.model : 'not configured'}
        </span>
        <button className="icon-btn" title="Clear conversation" onClick={() => void call('ai.clearHistory').then(() => useAi.setState({ history: [] }))}>
          <Trash2 size={13} />
        </button>
      </div>
      {!status?.configured && (
        <div className="empty" style={{ borderBottom: '1px solid var(--border)' }}>
          {status?.message ?? 'AI is not configured.'}
          <div style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => runCommand('settings.open')}>
              Open Settings → AI
            </button>
          </div>
        </div>
      )}
      {snapshot && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
          <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>
            Context sent with your next message {ctx ? `(~${ctx.tokens} tokens)` : ''} — click to include/exclude:
          </div>
          <div className="ctx-chips">
            {(ctx?.sections ?? []).map((s) => (
              <span key={s.id} className={`chip ${exclude.includes(s.id) ? 'off' : s.included ? 'on' : 'off'}`} title={`${s.title}: ${s.tokens} tokens${s.truncated ? ' (truncated to fit)' : ''}${s.included ? '' : ' — omitted (budget)'}`} onClick={() => toggleExclude(s.id)}>
                {SECTION_LABELS[s.id]}
                {s.truncated ? '*' : ''}
              </span>
            ))}
            {exclude
              .filter((id) => !ctx?.sections.some((s) => s.id === id))
              .map((id) => (
                <span key={id} className="chip off" onClick={() => toggleExclude(id)}>
                  {SECTION_LABELS[id as ContextSectionId] ?? id}
                </span>
              ))}
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
            <button className="btn sm" disabled={!!busy || !status?.configured} onClick={() => runCommand('ai.generateFirmware')} title="Generate firmware from the circuit">
              <Wand2 size={12} /> Firmware
            </button>
            <button className="btn sm" disabled={!!busy || !status?.configured || !lastBuild || lastBuild.status === 'succeeded'} onClick={() => runCommand('ai.fixError')} title="Explain and fix the last build failure">
              <Hammer size={12} /> Fix build
            </button>
            <button className="btn sm" disabled={!!busy || !status?.configured || serialLines === 0} onClick={() => runCommand('ai.debugSerial')} title="Analyse recent serial output">
              <Radio size={12} /> Debug serial
            </button>
            <button className="btn sm" disabled={!!busy || !status?.configured || !activeFilePath()} onClick={() => runCommand('ai.explainFile')}>
              <Code2 size={12} /> Explain file
            </button>
          </div>
        </div>
      )}
      <div className="chat" ref={chat} data-testid="copilot-chat">
        {history.length === 0 && (
          <div className="faint" style={{ lineHeight: 1.6 }}>
            Ask about your firmware, wiring, pins, libraries, build errors or serial output. The Copilot sees the project context shown above. Code and circuit changes come back as proposals you review before anything is written. It cannot run commands or flash devices.
          </div>
        )}
        {history.map((t, i) => (
          <Turn key={i} t={t} />
        ))}
        {busy && (
          <div className="msg">
            <div className="who">Copilot</div>
            <div className="body muted">{busy}…</div>
          </div>
        )}
      </div>
      <div className="composer">
        <div className="row" style={{ gap: 4 }}>
          {(
            [
              ['ask', 'Ask', <Bot key="a" size={12} />],
              ['edit', 'Edit code', <Code2 key="e" size={12} />],
              ['circuit', 'Change circuit', <CircuitBoard key="c" size={12} />],
            ] as const
          ).map(([m, label, icon]) => (
            <button key={m} className={`btn sm ${mode === m ? '' : 'ghost'}`} onClick={() => setMode(m)} disabled={!snapshot && m !== 'ask'}>
              {icon} {label}
            </button>
          ))}
        </div>
        <textarea
          id="copilot-input"
          placeholder={!snapshot ? 'Open a project to chat with project context' : mode === 'ask' ? 'Ask the Copilot… (Enter to send, Shift+Enter for newline)' : mode === 'edit' ? 'Describe the code change (returns a reviewable diff)' : 'Describe the circuit change (validated, reviewable)'}
          value={text}
          disabled={!status?.configured || !snapshot}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          data-testid="copilot-input"
        />
        <div className="row">
          <span className="faint grow" style={{ fontSize: 11 }}>
            AI output is a proposal; deterministic checks validate hardware.
          </span>
          {busy ? (
            <button className="btn sm" onClick={() => void call('ai.cancel')}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button className="btn sm primary" disabled={!text.trim() || !status?.configured || !snapshot} onClick={send}>
              <Send size={12} /> Send
            </button>
          )}
        </div>
      </div>
    </>
  );
}
