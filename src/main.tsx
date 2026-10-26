import { createRoot } from 'react-dom/client';
import './index.css';

const BOOT_FALLBACK_MESSAGE = 'حصلت مشكلة في تحميل التطبيق، حدّث الصفحة';

function renderBootFallback(rootEl: HTMLElement) {
  rootEl.innerHTML = '';
  const container = document.createElement('div');
  container.setAttribute('dir', 'rtl');
  container.setAttribute('lang', 'ar');
  container.setAttribute('role', 'alert');
  container.className = 'min-h-screen flex items-center justify-center p-6 text-center';
  container.style.backgroundColor = 'var(--bg, #FAF5EC)';
  container.style.color = 'var(--ink, #231C16)';
  container.style.fontFamily = 'var(--font, system-ui, sans-serif)';

  const card = document.createElement('div');
  card.className = 'max-w-md w-full p-6 border font-bold text-lg';
  card.style.backgroundColor = 'var(--surface, #FFFFFF)';
  card.style.borderColor = 'var(--border-strong, #8C7F6F)';
  card.style.borderRadius = 'var(--r-md, 12px)';
  card.textContent = BOOT_FALLBACK_MESSAGE;

  container.appendChild(card);
  rootEl.appendChild(container);
}

export async function bootApp() {
  const rootEl = document.getElementById('root');
  if (!rootEl) return;

  try {
    const mod = await import('./App.tsx');
    const App = mod.default;
    createRoot(rootEl).render(<App />);
  } catch {
    renderBootFallback(rootEl);
  }
}

void bootApp();
