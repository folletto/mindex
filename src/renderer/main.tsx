import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { UiProvider } from './components/ui/index.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('The root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <UiProvider>
      <App />
    </UiProvider>
  </StrictMode>,
);
