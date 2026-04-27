/**
 * Disease Outbreaks Panel
 * Displays a filterable list of active disease outbreak alerts.
 */

import { Panel } from '@/components/panel-base';
import { emit, on } from '@/app/app-context';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { h } from '@/utils/dom-utils';
import type { DiseaseOutbreakItem, AlertLevel } from '@/types';
import type { EscalationInfo } from '@/services/trend-calculator';
import { diseaseLabel } from '@/components/case-report-panel-data';

// Legal-safe labels: describe media coverage volume, not epidemiological severity.
// "Nhiều tin" means "many news articles reference this", not "this is a bad outbreak".
const ALERT_LABELS: Record<AlertLevel, string> = {
  alert: 'NHIỀU TIN',
  warning: 'VÀI TIN',
  watch: 'ÍT TIN',
};

const ALERT_COLORS: Record<AlertLevel, string> = {
  alert: '#e74c3c',
  warning: '#e67e22',
  watch: '#f1c40f',
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} phút trước`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} giờ trước`;
  return `${Math.floor(hrs / 24)} ngày trước`;
}

/** Local-timezone YYYY-MM-DD so it matches the timeline filter (also local). */
function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function evidenceMeta(item: DiseaseOutbreakItem): HTMLElement | null {
  const parts = [
    item.riskScore != null ? `điểm ${Math.round(item.riskScore)}` : null,
    item.confidence != null ? `${Math.round(item.confidence * 100)}% tin cậy` : null,
    item.sourceCount ? `${item.sourceCount} nguồn` : null,
    item.officialConfirmed ? 'có nguồn chính thống' : null,
    item.geoPrecision === 'district' ? 'đến huyện' : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;

  const detail = [
    ...(item.riskFactors ?? []),
    ...(item.extractionWarnings ?? []).map((warning) => `warning:${warning}`),
  ].join(' · ');

  return h('span', {
    className: 'outbreak-quality-meta',
    title: detail,
  }, parts.join(' · '));
}

type PanelState = 'loading' | 'ready' | 'error';

export class DiseaseOutbreaksPanel extends Panel {
  private _outbreaks: DiseaseOutbreakItem[] = [];
  private _escalations: Set<string> = new Set();
  private _filter: AlertLevel | null = null;
  private _search = '';
  private _showAllLocated = false;
  private _showAllUnlocated = false;
  private _provinceFilter: string | null = null;
  private _dateFilter: string | null = null; // YYYY-MM-DD
  private _filterBar: HTMLElement;
  private _provinceChip: HTMLElement;
  private _searchInput: HTMLInputElement;
  private _listEl: HTMLElement;
  private _state: PanelState = 'loading';
  private _errorMessage = '';
  private _retryAction: (() => void) | null = null;

  constructor() {
    super({ id: 'disease-outbreaks', title: 'Báo chí đưa tin', showCount: true, defaultRowSpan: 3 });

    this._filterBar   = this._buildFilterBar();
    this._provinceChip = this._buildProvinceChip();
    this._searchInput = this._buildSearchInput();
    this._listEl = h('div', { className: 'outbreak-list' });

    const toolbar = h('div', { className: 'outbreak-toolbar' },
      this._filterBar,
      this._provinceChip,
      this._searchInput,
    );

    // Insert toolbar before content scroll area
    this.content.appendChild(toolbar);
    this.content.appendChild(this._listEl);

    // Listen for map marker clicks → filter by province
    on('map-marker-clicked', (data) => {
      const item = data as DiseaseOutbreakItem;
      this.filterByProvince(item.province ?? null);
    });
  }

  /**
   * Filter the outbreak list to show only outbreaks for a province.
   * Pass null to clear the filter.
   */
  filterByProvince(province: string | null): void {
    this._provinceFilter = province;
    // Auto-expand both columns when a province is selected
    this._showAllLocated = province !== null;
    this._showAllUnlocated = province !== null;
    this._syncProvinceChip();
    this._render();
    emit('province-filter-changed', province);
  }

  /** Filter list to a specific date (YYYY-MM-DD). Pass null to show all. */
  filterByDate(date: string | null): void {
    this._dateFilter = date;
    this._showAllLocated = false;
    this._showAllUnlocated = false;
    this._render();
  }

  /** Set escalation info — outbreaks that recently increased severity. */
  setEscalations(escalations: EscalationInfo[]): void {
    this._escalations = new Set(escalations.map(e => e.outbreakId));
    this._render();
  }

  /** Called by app-init when fresh outbreak data arrives. */
  updateData(outbreaks: DiseaseOutbreakItem[]): void {
    this._state = 'ready';
    this._errorMessage = '';
    this._retryAction = null;
    // Copy the array to prevent external mutation (e.g. dedup in processOutbreaks)
    // from changing our internal state behind our back.
    this._outbreaks = [...outbreaks];
    this.setCount(this._outbreaks.length);
    this._syncControlsDisabled(false);
    // Reset expanded state so "Xem thêm" count stays consistent with new data
    this._showAllLocated = false;
    this._showAllUnlocated = false;
    // Re-mount toolbar + list (showLoading may have wiped content)
    this._remount();
    this._render();
  }

  /** Show an inline loading state without removing the panel toolbar. */
  showLoadingState(): void {
    this._state = 'loading';
    this._errorMessage = '';
    this._retryAction = null;
    this.countEl.textContent = '...';
    this.countEl.style.display = '';
    this._syncControlsDisabled(true);
    this._remount();
    this._render();
  }

  /** Show a fetch failure state with an optional inline retry action. */
  showFetchError(message: string, retry?: () => void): void {
    this._state = 'error';
    this._errorMessage = message;
    this._retryAction = retry ?? null;
    this.countEl.textContent = '!';
    this.countEl.style.display = '';
    this._syncControlsDisabled(true);
    this._remount();
    this._render();
  }

  /** Re-insert the toolbar and list container into the panel content area. */
  private _remount(): void {
    this.content.textContent = '';
    const toolbar = h('div', { className: 'outbreak-toolbar' },
      this._filterBar,
      this._provinceChip,
      this._searchInput,
    );
    this.content.appendChild(toolbar);
    this.content.appendChild(this._listEl);
  }

  // ---------------------------------------------------------------------------
  // Private — UI builders
  // ---------------------------------------------------------------------------

  private _buildFilterBar(): HTMLElement {
    const bar = h('div', { className: 'outbreak-filter-bar' });
    const levels: AlertLevel[] = ['alert', 'warning', 'watch'];

    for (const level of levels) {
      const btn = h('button', {
        className: 'outbreak-filter-btn',
        style: `--badge-color:${ALERT_COLORS[level]}`,
        dataset: { level },
      }, ALERT_LABELS[level]);

      btn.addEventListener('click', () => {
        this._filter = this._filter === level ? null : level;
        this._syncFilterButtons();
        this._render();
      });

      bar.appendChild(btn);
    }

    return bar;
  }

  /** Province filter chip — hidden by default, shown when a province is selected. */
  private _buildProvinceChip(): HTMLElement {
    const chip = h('div', { className: 'outbreak-province-chip outbreak-province-chip--hidden' });
    return chip;
  }

  /** Sync the province chip label and visibility. */
  private _syncProvinceChip(): void {
    if (this._provinceFilter) {
      this._provinceChip.textContent = '';
      const label = document.createTextNode(`📍 ${this._provinceFilter}`);
      const clearBtn = h('button', { className: 'outbreak-province-chip-clear', title: 'Xóa bộ lọc' }, '×');
      clearBtn.addEventListener('click', (e) => { e.stopPropagation(); this.filterByProvince(null); });
      this._provinceChip.appendChild(label);
      this._provinceChip.appendChild(clearBtn);
      this._provinceChip.classList.remove('outbreak-province-chip--hidden');
    } else {
      this._provinceChip.classList.add('outbreak-province-chip--hidden');
    }
  }

  private _buildSearchInput(): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search disease / country…';
    input.className = 'outbreak-search';
    input.addEventListener('input', () => {
      this._search = input.value.trim().toLowerCase();
      this._render();
    });
    return input;
  }

  private _syncFilterButtons(): void {
    for (const btn of Array.from(this._filterBar.querySelectorAll('.outbreak-filter-btn'))) {
      const level = (btn as HTMLElement).dataset['level'] as AlertLevel;
      btn.classList.toggle('outbreak-filter-btn--active', this._filter === level);
    }
  }

  private _syncControlsDisabled(disabled: boolean): void {
    this._searchInput.disabled = disabled;
    this._searchInput.setAttribute('aria-disabled', String(disabled));
    for (const btn of Array.from(this._filterBar.querySelectorAll('.outbreak-filter-btn'))) {
      (btn as HTMLButtonElement).disabled = disabled;
      btn.setAttribute('aria-disabled', String(disabled));
    }
  }

  private _hasActiveFilters(): boolean {
    return this._filter !== null
      || this._provinceFilter !== null
      || this._dateFilter !== null
      || this._search.length > 0;
  }

  private _buildStateCard(
    kind: 'loading' | 'error' | 'empty',
    title: string,
    detail: string,
    retry?: () => void,
  ): HTMLElement {
    const card = h('div', {
      className: `outbreak-state-card outbreak-state-card--${kind}`,
    });

    if (kind === 'loading') {
      card.appendChild(h('span', { className: 'panel-spinner outbreak-state-spinner' }));
    }

    card.appendChild(h('p', { className: 'outbreak-state-title' }, title));
    card.appendChild(h('p', { className: 'outbreak-state-detail' }, detail));

    if (retry) {
      const btn = h('button', { className: 'panel-retry-btn' }, 'Thử lại');
      btn.addEventListener('click', retry);
      card.appendChild(btn);
    }

    return card;
  }

  // ---------------------------------------------------------------------------
  // Private — rendering
  // ---------------------------------------------------------------------------

  private _getFiltered(): DiseaseOutbreakItem[] {
    return this._outbreaks.filter(o => {
      if (this._filter && o.alertLevel !== this._filter) return false;
      if (this._provinceFilter && o.province !== this._provinceFilter) return false;
      if (this._dateFilter) {
        if (localDay(o.publishedAt) !== this._dateFilter) return false;
      }
      if (this._search) {
        const hay = `${o.disease} ${o.country} ${o.province ?? ''}`.toLowerCase();
        if (!hay.includes(this._search)) return false;
      }
      return true;
    });
  }

  /** Provinces that represent nationwide/regional — no specific map location */
  private static readonly UNLOCATED = new Set(['Toàn quốc', 'phía Nam', 'ĐBSCL']);

  private _isUnlocated(o: DiseaseOutbreakItem): boolean {
    return DiseaseOutbreaksPanel.UNLOCATED.has(o.province ?? '') || !o.province;
  }

  private _render(): void {
    const items = this._getFiltered();

    // Remove previous children
    while (this._listEl.firstChild) this._listEl.removeChild(this._listEl.firstChild);

    if (this._state === 'loading') {
      this._listEl.appendChild(this._buildStateCard(
        'loading',
        'Đang tải dữ liệu',
        'Đang lấy danh sách bài báo và tín hiệu cảnh báo mới nhất từ API tổng hợp.',
      ));
      return;
    }

    if (this._state === 'error') {
      this._listEl.appendChild(this._buildStateCard(
        'error',
        'Không tải được dữ liệu bùng phát',
        this._errorMessage,
        this._retryAction ?? undefined,
      ));
      return;
    }

    if (!items.length) {
      if (this._hasActiveFilters()) {
        this._listEl.appendChild(this._buildStateCard(
          'empty',
          'Không có mục nào khớp bộ lọc hiện tại',
          'Thử xóa bớt bộ lọc, đổi ngày, hoặc tìm với từ khóa khác.',
        ));
      } else {
        this._listEl.appendChild(this._buildStateCard(
          'empty',
          'Chưa có dữ liệu để hiển thị',
          'Nguồn dữ liệu có thể đang tạm trống hoặc lần đồng bộ gần nhất chưa hoàn tất.',
        ));
      }
      return;
    }

    // Split: located (province-specific) vs unlocated (Toàn quốc, etc.)
    const located = items.filter(o => !this._isUnlocated(o));
    const unlocated = items.filter(o => this._isUnlocated(o));

    // Build 2-column layout: left = located, right = unlocated
    const leftCol = h('div', { className: 'outbreak-col outbreak-col--located' },
      h('div', { className: 'outbreak-col-header' }, `📍 Có vị trí (${located.length})`));
    const rightCol = h('div', { className: 'outbreak-col outbreak-col--unlocated' },
      h('div', { className: 'outbreak-col-header' }, `🌐 Toàn quốc / chưa rõ (${unlocated.length})`));

    const MAX_VISIBLE = 5;

    // Located column
    const visibleLocated = this._showAllLocated ? located : located.slice(0, MAX_VISIBLE);
    for (const item of visibleLocated) {
      leftCol.appendChild(this._buildRow(item));
    }
    if (located.length > MAX_VISIBLE) {
      const remaining = located.length - MAX_VISIBLE;
      const label = this._showAllLocated ? 'Thu gọn' : `Xem thêm (${remaining} mục)`;
      const btn = h('button', { className: 'outbreak-show-more' }, label);
      btn.addEventListener('click', () => {
        this._showAllLocated = !this._showAllLocated;
        this._render();
      });
      leftCol.appendChild(btn);
    }

    // Unlocated column
    const visibleUnlocated = this._showAllUnlocated ? unlocated : unlocated.slice(0, MAX_VISIBLE);
    for (const item of visibleUnlocated) {
      rightCol.appendChild(this._buildRow(item));
    }
    if (unlocated.length > MAX_VISIBLE) {
      const remaining = unlocated.length - MAX_VISIBLE;
      const label = this._showAllUnlocated ? 'Thu gọn' : `Xem thêm (${remaining} mục)`;
      const btn = h('button', { className: 'outbreak-show-more' }, label);
      btn.addEventListener('click', () => {
        this._showAllUnlocated = !this._showAllUnlocated;
        this._render();
      });
      rightCol.appendChild(btn);
    }

    if (located.length === 0) leftCol.appendChild(h('p', { className: 'outbreak-empty' }, 'Không có'));
    if (unlocated.length === 0) rightCol.appendChild(h('p', { className: 'outbreak-empty' }, 'Không có'));

    const grid = h('div', { className: 'outbreak-2col-grid' }, leftCol, rightCol);
    this._listEl.appendChild(grid);
  }

  private _buildRow(item: DiseaseOutbreakItem): HTMLElement {
    const badge = h('span', {
      className: 'alert-badge',
      style: `background:${ALERT_COLORS[item.alertLevel]}`,
    }, ALERT_LABELS[item.alertLevel]);

    // Escalation badge if this outbreak recently upgraded severity
    const outbreakKey = `${item.disease}|${item.countryCode}`;
    const escalated = this._escalations.has(outbreakKey);

    const title = h('span', { className: 'outbreak-row-title' }, escapeHtml(diseaseLabel(item.disease)));

    const locParts = [];
    if (item.district) locParts.push(item.district);
    if (item.province && item.province !== item.country) locParts.push(item.province);

    const locationPart: (string | HTMLElement)[] =
      locParts.length > 0
        ? [' · ', escapeHtml(locParts.join(', '))]
        : [];

    const meta = h('span', { className: 'outbreak-row-meta' },
      escapeHtml(item.country), ...locationPart, ' · ', relativeTime(item.publishedAt),
      ...(item.source ? [' · ', h('span', { className: 'outbreak-source-badge' }, item.source)] : []),
      ...(escalated ? [' ', h('span', { className: 'escalation-badge' }, '⬆')] : []),
    );

    const safeUrl = sanitizeUrl(item.url);
    const link = safeUrl
      ? h('a', { href: safeUrl, target: '_blank', rel: 'noopener noreferrer', className: 'outbreak-row-link' }, '↗')
      : null;

    const isToday = localDay(item.publishedAt) === localDay(Date.now());
    const todayClass = isToday ? ' outbreak-row--today' : '';
    const metaNode = evidenceMeta(item);
    const rowChildren = [
      h('div', { className: 'outbreak-row-header' }, badge, title, ...(link ? [link] : [])),
      meta,
    ];
    if (metaNode) rowChildren.push(metaNode);

    const row = h('div', { className: `outbreak-row outbreak-row--${item.alertLevel}${todayClass}` },
      ...rowChildren,
    );

    row.addEventListener('click', (e) => {
      // Don't intercept clicks on the external link
      if ((e.target as HTMLElement).tagName === 'A') return;
      emit('outbreak-selected', item);
    });

    return row;
  }
}
