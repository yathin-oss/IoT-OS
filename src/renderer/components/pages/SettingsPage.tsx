import { useState } from 'react';
import { AI_PROVIDER_IDS, PROVIDER_LABELS, type AIProviderId } from '../../../core/ai/types';
import { call, errorMessage } from '../../api/client';
import { runCommand } from '../../commands';
import { useAi, useApp } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { ToolchainSection } from '../views/DevicesView';

const TOOL_IDS = ['arduino-cli', 'esptool', 'mpremote', 'avrdude', 'mpy-cross', 'python3', 'git'];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={`settings-${id}`} style={{ marginBottom: 28 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 10px', paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>{title}</h3>
      <div className="col" style={{ gap: 12 }}>
        {children}
      </div>
    </section>
  );
}

export function SettingsPage() {
  const { settings, info, updateSettings } = useApp();
  const [keyDraft, setKeyDraft] = useState('');
  const [keyProvider, setKeyProvider] = useState<AIProviderId>(settings?.ai.provider ?? 'anthropic');
  const [test, setTest] = useState<string | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>(settings?.toolPaths ?? {});
  if (!settings) return <div className="empty">Loading settings…</div>;
  const ui = useUi.getState();

  const saveKey = async (key: string | null) => {
    try {
      useApp.setState({ settings: await call('settings.setApiKey', { provider: keyProvider, key }) });
      setKeyDraft('');
      await useAi.getState().load();
      ui.toast('success', key ? `${PROVIDER_LABELS[keyProvider]} key saved (${settings.secretStorage === 'os-keychain' ? 'OS keychain' : 'local file, 0600'})` : 'Key removed');
    } catch (err) {
      ui.toast('error', errorMessage(err));
    }
  };

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 820 }}>
        <Section id="ai" title="AI provider">
          <div className="field">
            <label>Active provider</label>
            <select
              className="select"
              value={settings.ai.provider}
              onChange={(e) => void updateSettings({ ai: { provider: e.target.value as AIProviderId } }).then(() => useAi.getState().load())}
            >
              {AI_PROVIDER_IDS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]} {settings.ai.hasKey[p] ? '✓ key set' : '— no key'}
                </option>
              ))}
            </select>
          </div>
          {AI_PROVIDER_IDS.map((p) => (
            <div key={p} className="field">
              <label>{PROVIDER_LABELS[p]} model</label>
              <input className="input mono" defaultValue={settings.ai.models[p]} onBlur={(e) => e.target.value.trim() && e.target.value !== settings.ai.models[p] && void updateSettings({ ai: { models: { [p]: e.target.value.trim() } } })} />
            </div>
          ))}
          <div className="field">
            <label>API key (stored {settings.secretStorage === 'os-keychain' ? 'encrypted in the OS keychain' : 'in a private local file'}; never shown again or sent to the UI)</label>
            <div className="row">
              <select className="select" value={keyProvider} onChange={(e) => setKeyProvider(e.target.value as AIProviderId)} style={{ width: 150 }}>
                {AI_PROVIDER_IDS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
              <input className="input grow mono" type="password" autoComplete="off" placeholder={settings.ai.hasKey[keyProvider] ? '•••••••• (set) — enter a new key to replace' : 'Paste API key'} value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} data-testid="api-key-input" />
              <button className="btn primary" disabled={!keyDraft.trim()} onClick={() => void saveKey(keyDraft)}>
                Save key
              </button>
              {settings.ai.hasKey[keyProvider] && (
                <button className="btn danger" onClick={() => void saveKey(null)}>
                  Remove
                </button>
              )}
            </div>
            <span className="faint">Environment variables ANTHROPIC_API_KEY, OPENAI_API_KEY and GEMINI_API_KEY override stored keys.</span>
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={() => {
                setTest('Testing…');
                void call('ai.test').then((r) => setTest(`${r.ok ? '✓' : '✗'} ${r.message}${r.latencyMs ? ` (${r.latencyMs} ms)` : ''}`));
              }}
            >
              Test connection
            </button>
            {test && <span className="selectable">{test}</span>}
          </div>
          <div className="field">
            <label>Context budget (tokens sent per request)</label>
            <input className="input" type="number" min={2000} max={200000} step={1000} defaultValue={settings.ai.contextBudgetTokens} onBlur={(e) => void updateSettings({ ai: { contextBudgetTokens: Number(e.target.value) } })} style={{ width: 160 }} />
          </div>
        </Section>

        <Section id="toolchains" title="Toolchains">
          <div className="faint">Leave empty to auto-detect on PATH and common install locations.</div>
          {TOOL_IDS.map((t) => (
            <div key={t} className="row">
              <span style={{ width: 110 }} className="mono">
                {t}
              </span>
              <input className="input grow mono" placeholder="auto-detect" value={paths[t] ?? ''} onChange={(e) => setPaths({ ...paths, [t]: e.target.value })} />
            </div>
          ))}
          <div>
            <button className="btn" onClick={() => void updateSettings({ toolPaths: Object.fromEntries(TOOL_IDS.map((t) => [t, paths[t] ?? ''])) }).then(() => ui.toast('success', 'Tool paths saved'))}>
              Save tool paths
            </button>
          </div>
          <div className="card">
            <ToolchainSection />
          </div>
        </Section>

        <Section id="serial" title="Serial">
          <div className="row">
            <span style={{ width: 140 }}>Default baud</span>
            <select className="select" value={settings.serial.defaultBaud} onChange={(e) => void updateSettings({ serial: { defaultBaud: Number(e.target.value) } })}>
              {[9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600].map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className="row">
            <span style={{ width: 140 }}>Line ending</span>
            <select className="select" value={settings.serial.lineEnding} onChange={(e) => void updateSettings({ serial: { lineEnding: e.target.value as 'lf' } })}>
              <option value="none">None</option>
              <option value="lf">LF (\n)</option>
              <option value="cr">CR (\r)</option>
              <option value="crlf">CR+LF</option>
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={settings.serial.timestamps} onChange={(e) => void updateSettings({ serial: { timestamps: e.target.checked } })} /> Show timestamps by default
          </label>
        </Section>

        <Section id="editor" title="Editor">
          <div className="row">
            <span style={{ width: 140 }}>Font size</span>
            <input className="input" type="number" min={9} max={28} defaultValue={settings.editor.fontSize} onBlur={(e) => void updateSettings({ editor: { fontSize: Number(e.target.value) } })} style={{ width: 80 }} />
          </div>
          <label className="check">
            <input type="checkbox" checked={settings.editor.wordWrap} onChange={(e) => void updateSettings({ editor: { wordWrap: e.target.checked } })} /> Word wrap
          </label>
        </Section>

        <Section id="general" title="General">
          <div className="field">
            <label>Projects folder</label>
            <input className="input mono" defaultValue={settings.workspaceDir} onBlur={(e) => e.target.value.trim() && e.target.value !== settings.workspaceDir && void updateSettings({ workspaceDir: e.target.value.trim() })} />
          </div>
        </Section>

        <Section id="about" title="About & diagnostics">
          <div className="kv" style={{ padding: 0 }}>
            <span className="k">Version</span>
            <span>{info?.version}</span>
            <span className="k">Runtime</span>
            <span>
              {info?.runtime === 'electron' ? `Electron ${info.electronVersion}` : 'Browser host (Node.js)'} · Node {info?.nodeVersion} · {info?.platform}/{info?.arch}
            </span>
            <span className="k">Log file</span>
            <span className="mono selectable">{info?.logFile}</span>
          </div>
          <div className="row">
            <button className="btn" onClick={() => runCommand('help.diagnostics')}>
              Export diagnostics bundle
            </button>
            <button className="btn" onClick={() => runCommand('setup.open')}>
              Run setup check
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}
