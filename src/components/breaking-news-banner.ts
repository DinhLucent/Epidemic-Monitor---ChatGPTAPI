/**
 * Breaking News Banner component.
 * Fixed bar at top of page for urgent health alerts.
 * Auto-dismisses after 30 seconds; manual dismiss via ✕ button.
 */
import '@/styles/breaking-news.css';

const AUTO_DISMISS_MS = 30_000;
const DISMISS_TTL_MS = 6 * 60 * 60 * 1000;
const STORAGE_KEY = 'epidemic-monitor.dismissedBreakingNews';

interface DismissedAlert {
  key: string;
  expiresAt: number;
}

export class BreakingNewsBanner {
  private _el: HTMLElement;
  private _textEl: HTMLSpanElement;
  private _dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private _activeKey: string | null = null;

  constructor() {
    // Icon span
    const icon = document.createElement('span');
    icon.className = 'breaking-news-banner__icon';
    icon.textContent = '⚠';
    icon.setAttribute('aria-hidden', 'true');

    // Label span
    const label = document.createElement('span');
    label.className = 'breaking-news-banner__label';
    label.textContent = 'CẢNH BÁO';

    // Message text span
    this._textEl = document.createElement('span');
    this._textEl.className = 'breaking-news-banner__text';

    // Dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'breaking-news-banner__dismiss';
    dismissBtn.textContent = '✕';
    dismissBtn.title = 'Đóng thông báo';
    dismissBtn.setAttribute('aria-label', 'Dismiss alert');
    dismissBtn.addEventListener('click', () => this.dismiss(true));

    // Root banner element — hidden by default via CSS transform
    this._el = document.createElement('div');
    this._el.className = 'breaking-news-banner';
    this._el.setAttribute('role', 'status');
    this._el.setAttribute('aria-live', 'polite');
    this._el.appendChild(icon);
    this._el.appendChild(label);
    this._el.appendChild(this._textEl);
    this._el.appendChild(dismissBtn);

    // Prepend to #app if present, fallback to body
    const root = document.getElementById('app') ?? document.body;
    root.insertBefore(this._el, root.firstChild);
  }

  /**
   * Show a breaking news alert.
   * @param message - Alert text to display
   * @param level   - 'alert' (red) or 'warning' (orange)
   */
  show(message: string, level: 'alert' | 'warning' = 'alert', key = message): void {
    if (this._isDismissed(key)) return;
    if (this._activeKey === key && this._el.classList.contains('breaking-news-banner--visible')) return;

    // Clear any existing auto-dismiss timer
    this._clearTimer();
    this._activeKey = key;

    // Update level modifier classes
    this._el.classList.remove('breaking-news-banner--alert', 'breaking-news-banner--warning');
    this._el.classList.add(`breaking-news-banner--${level}`);

    // Set message text (safe — textContent only, no innerHTML)
    this._textEl.textContent = message;

    // Slide down
    this._el.classList.add('breaking-news-banner--visible');

    // Auto-dismiss after 30 seconds
    this._dismissTimer = setTimeout(() => this.dismiss(true), AUTO_DISMISS_MS);
  }

  /** Hide the banner and clear the auto-dismiss timer. */
  dismiss(persist = false): void {
    if (persist && this._activeKey) this._rememberDismissed(this._activeKey);
    this._clearTimer();
    this._el.classList.remove('breaking-news-banner--visible');
  }

  /** Remove from DOM entirely (call when app is torn down). */
  destroy(): void {
    this._clearTimer();
    this._el.remove();
  }

  private _clearTimer(): void {
    if (this._dismissTimer !== null) {
      clearTimeout(this._dismissTimer);
      this._dismissTimer = null;
    }
  }

  private _isDismissed(key: string): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const records = JSON.parse(raw) as DismissedAlert[];
      const now = Date.now();
      const fresh = records.filter((record) => record.expiresAt > now);
      if (fresh.length !== records.length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
      }
      return fresh.some((record) => record.key === key);
    } catch {
      return false;
    }
  }

  private _rememberDismissed(key: string): void {
    try {
      const now = Date.now();
      const raw = localStorage.getItem(STORAGE_KEY);
      const records = raw ? JSON.parse(raw) as DismissedAlert[] : [];
      const fresh = records.filter((record) => record.expiresAt > now && record.key !== key);
      fresh.push({ key, expiresAt: now + DISMISS_TTL_MS });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh.slice(-20)));
    } catch {
      // localStorage may be unavailable in privacy modes.
    }
  }
}
