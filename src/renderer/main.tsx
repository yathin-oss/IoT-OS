import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setupMonaco } from './components/editor/monacoSetup';
import { initState } from './state/events';
import './styles/app.css';

setupMonaco();

const root = createRoot(document.getElementById('root')!);
initState()
  .catch((err: unknown) => {
    console.error('IoT-OS failed to initialise', err);
  })
  .finally(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
