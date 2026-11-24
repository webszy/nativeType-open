export interface SparklesLoaderOptions {
  /** Packaged URL resolved by the extension entrypoint, never a website-relative path. */
  src?: string;
  size?: number;
  visible?: boolean;
  text?: string;
  className?: string;
}

/** Native DOM component; its styles stay with the element inside the caller's Shadow DOM. */
export function createSparklesLoader({ src, size = 40, visible = true, text = '', className = '' }: SparklesLoaderOptions = {}) {
  const element = document.createElement('div');
  element.className = ['nt-sparkles-loader', className].filter(Boolean).join(' ');
  element.setAttribute('data-part', 'sparkles-loader');
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.setAttribute('aria-atomic', 'true');
  element.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;min-width:0;background:transparent;';
  element.style.minHeight = `${size}px`;
  if (!text) element.setAttribute('aria-label', 'Loading');

  if (src) {
    const image = document.createElement('img');
    image.src = src;
    image.alt = '';
    image.width = size;
    image.height = size;
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    image.style.cssText = 'display:block;flex:none;object-fit:contain;background:transparent;';
    image.style.width = `${size}px`;
    image.style.height = `${size}px`;
    // The unchanged SVG owns its animation and prefers-reduced-motion media query.
    element.append(image);
  }
  if (text) {
    const label = document.createElement('span');
    label.textContent = text;
    label.style.cssText = 'min-width:0;overflow-wrap:anywhere;';
    element.append(label);
  }

  function setVisible(next: boolean) {
    element.hidden = !next;
    // Also work in consumers without a [hidden] stylesheet rule.
    element.style.display = next ? 'flex' : 'none';
  }
  setVisible(visible);
  return { element, setVisible };
}
