/**
 * Application bootstrap
 * - Builds DOM layout
 * - Mounts MapShell
 * - Creates all disease panels and mounts them into the panels grid
 * - Mounts map layer controls
 * - Fetches outbreak data and propagates to panels + map layers
 * - Wires event bus: outbreak-selected → flyTo + popup; country-selected → CountryHealthPanel
 */

import { createLayout } from '@/app/app-layout';
import { h } from '@/utils/dom-utils';
import { MapShell } from '@/components/map-shell';
import { ctx, on, emit } from '@/app/app-context';

import { DiseaseOutbreaksPanel } from '@/components/disease-outbreaks-panel';
import { TopDiseasesPanel } from '@/components/top-diseases-panel';
import { MapPopup } from '@/components/map-popup';
import { ensureDisclaimerAcknowledged, showDisclaimerReview } from '@/components/first-visit-disclaimer';
import { createMobileTabBar, syncMobileModeClass, isMobileViewport } from '@/components/mobile-tab-bar';
import { updateMapLayers } from '@/components/map-layers/index';

import { fetchDiseaseOutbreaks } from '@/services/disease-outbreak-service';
import { fetchHealthNews } from '@/services/news-feed-service';
import { invalidateCache } from '@/services/fetch-cache';
import { fetchBulkData, invalidateBulkCache } from '@/services/bulk-data-service';
import { ClimateAlertsPanel } from '@/components/climate-alerts-panel';
import { RegionalSignalsPanel } from '@/components/regional-signals-panel';
import { PipelineOpsPanel } from '@/components/pipeline-ops-panel';
import { diseaseLabel } from '@/components/case-report-panel-data';
import { fetchClimateForecasts } from '@/services/climate-service';
import { fetchPipelineStatus } from '@/services/pipeline-status-service';
import type { ClimateForecast } from '@/services/climate-service';
import { canonicalProvinceName } from '@/services/province-normalizer';
import { initSnapshotDB, saveSnapshot, getRecentSnapshots, pruneOldSnapshots } from '@/services/snapshot-store';
import { detectEscalations, detectEarlyWarnings } from '@/services/trend-calculator';
import { setEarlyWarnings, setHighlightedProvince, setSelectedDate } from '@/components/map-layers/index';
import { BreakingNewsBanner } from '@/components/breaking-news-banner';
import type { DataFreshness, DiseaseOutbreakItem, EpidemicStats, NewsItem } from '@/types';

const CLIMATE_BOOTSTRAP_DELAY_MS = 5000;
const PIPELINE_STATUS_POLL_MS = 60_000;

type IdleScheduler = (callback: () => void, options?: { timeout: number }) => number;

function scheduleDeferredClimateLoad(callback: () => void): void {
  window.setTimeout(() => {
    const requestIdle = (window as Window & { requestIdleCallback?: IdleScheduler }).requestIdleCallback;
    if (requestIdle) {
      requestIdle(callback, { timeout: 10000 });
      return;
    }
    callback();
  }, CLIMATE_BOOTSTRAP_DELAY_MS);
}

export async function initApp(): Promise<void> {
  try {
    // 0. First-visit disclaimer — blocks app bootstrap until user acks once
    //    per 30 days. Legal shield: documents that every user has been
    //    informed about the tool's non-official nature.
    await ensureDisclaimerAcknowledged();

    // 1. Build CSS grid layout
    const { appHeader, appShell, mapContainer, panelsGrid } = createLayout();

    // Sync initial mobile-mode class — CSS uses it to collapse header
    syncMobileModeClass();

    // Global header — consolidated brand + disclaimer + author + legal links.
    // Light theme, spans full width above map + dashboard. The ⓘ button is
    // hidden on desktop (disclaimer card is inline) and visible on mobile
    // where the card is collapsed to save vertical space.
    const headerInfoBtn = h('button', {
      className: 'app-header-info-btn',
      type: 'button',
      title: 'Xem điều khoản và disclaimer',
      'aria-label': 'Điều khoản và disclaimer',
    }, 'ⓘ');
    headerInfoBtn.addEventListener('click', () => { void showDisclaimerReview(); });

    const headerBrand = h('div', { className: 'app-header-brand' },
      h('img', { className: 'app-header-logo', src: '/logo.svg', alt: 'Epidemic Monitor' }),
      h('div', { className: 'app-header-title-group' },
        h('div', { className: 'app-header-title' }, 'Epidemic Monitor'),
        h('div', { className: 'app-header-subtitle' }, 'Bản đồ cảnh báo nguy cơ sức khoẻ · Việt Nam'),
      ),
      headerInfoBtn,
    );

    // One-line condensed disclaimer — full text lives in the ⓘ modal.
    // KISS: short enough to fit on desktop header single row; still carries
    // the essential "not official" framing required by Nghị định 15/2020.
    const headerDisclaimer = h('div', { className: 'app-header-disclaimer' },
      h('span', { className: 'app-header-disclaimer-icon' }, '⚠️'),
      h('div', { className: 'app-header-disclaimer-main' },
        h('strong', {}, 'Không phải nguồn chính thống'),
        ' — AI tổng hợp từ báo chí VN, có thể sai sót. Đối chiếu Bộ Y tế / CDC trước khi ra quyết định.',
      ),
      h('div', { className: 'app-header-disclaimer-actions' },
        h('a', {
          className: 'app-header-disclaimer-terms',
          href: '/terms.html',
          target: '_blank',
          rel: 'noopener noreferrer',
        }, '📄 Điều khoản'),
        h('a', {
          className: 'app-header-disclaimer-report',
          href: 'https://github.com/DinhLucent/my-epidemic-monitor/issues',
          target: '_blank',
          rel: 'noopener noreferrer',
        }, '🐛 Báo lỗi'),
      ),
    );

    const headerAuthor = h('div', { className: 'app-header-author', title: 'DinhLucent — GitHub' },
      h('div', { className: 'app-header-author-avatar' }, 'DL'),
      h('div', { className: 'app-header-author-info' },
        h('span', { className: 'app-header-author-name' }, 'DinhLucent'),
        h('div', { className: 'app-header-author-links' },
          h('a', { href: 'https://github.com/DinhLucent', target: '_blank', rel: 'noopener noreferrer', title: 'GitHub' }, 'GH'),
        ),
      ),
    );

    appHeader.appendChild(headerBrand);
    appHeader.appendChild(headerDisclaimer);
    appHeader.appendChild(headerAuthor);

    // 2. Mount MapShell
    const mapShell = new MapShell('map');
    ctx.map = mapShell;

    // 3. Instantiate panels
    const outbreaksPanel = new DiseaseOutbreaksPanel();
    const topDiseasesPanel = new TopDiseasesPanel();
    const climatePanel = new ClimateAlertsPanel(false);
    const regionalSignalsPanel = new RegionalSignalsPanel();
    const pipelineOpsPanel = new PipelineOpsPanel();
    const banner = new BreakingNewsBanner();

    // 4. Flat panel list — climate forecast panel hidden (kept off for now,
    //    still computed for early-warning markers on the map).
    const panels: HTMLElement[] = [outbreaksPanel.el, topDiseasesPanel.el, regionalSignalsPanel.el, pipelineOpsPanel.el];

    // Alert summary strip — shows counts per severity level
    const summaryStrip = h('div', { className: 'alert-summary-strip' });

    // Top bar — just data age + refresh (no tab buttons)
    const tabBar = h('div', { className: 'panel-tab-bar' });
    const dataAge = h('span', { className: 'data-age-indicator' }, 'Loading...');
    const refreshBtn = h('button', { className: 'data-refresh-btn', title: 'Refresh data' }, '⟳');
    const rightGroup = h('div', { className: 'tab-bar-right' }, dataAge, refreshBtn);
    tabBar.appendChild(rightGroup);

    panelsGrid.insertBefore(tabBar, panelsGrid.firstChild);

    // Timeline bar — 7-day date selector. Uses LOCAL timezone YYYY-MM-DD
    // so "Hôm nay" in Vietnam (UTC+7) lines up with the date users see
    // on published_at instead of drifting to UTC day. Otherwise an item
    // published at 01:00 VN time shows up on the previous UTC day bucket.
    const localDateString = (d: Date): string => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const todayStr = localDateString(new Date());
    let _selectedDate = todayStr;
    const timelineBar = h('div', { className: 'timeline-bar' });
    const timelineDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i)); // oldest → newest
      return localDateString(d);
    });

    const DOW_VN = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

    const tlBtns = new Map<string, HTMLElement>();
    for (const day of timelineDays) {
      const d = new Date(day + 'T00:00:00');
      const isToday = day === todayStr;
      const dowLabel = isToday ? 'HN' : DOW_VN[d.getDay()];
      const dateLabel = isToday ? 'Hôm nay' : `${d.getDate()}/${d.getMonth() + 1}`;
      const btn = h('button', {
        className: `timeline-day-btn${isToday ? ' timeline-day-btn--active' : ''}`,
        dataset: { date: day },
        title: day,
      },
        h('span', { className: 'tl-dow' }, dowLabel),
        h('span', { className: 'tl-date' }, dateLabel),
        h('span', { className: 'tl-count', style: 'display:none' }, ''),
      );
      btn.addEventListener('click', () => emit('day-selected', day));
      tlBtns.set(day, btn);
      timelineBar.appendChild(btn);
    }
    panelsGrid.insertBefore(timelineBar, tabBar.nextSibling);

    // Insert summary strip after the timeline bar (disclaimer moved to header)
    panelsGrid.insertBefore(summaryStrip, timelineBar.nextSibling);

    /** Update count badges on each timeline day button after data loads. */
    function updateTimelineCounts(allOutbreaks: DiseaseOutbreakItem[]): void {
      for (const [day, btn] of tlBtns) {
        const count = allOutbreaks.filter(o =>
          localDateString(new Date(o.publishedAt)) === day
        ).length;
        const badge = btn.querySelector('.tl-count') as HTMLElement | null;
        if (badge) {
          badge.textContent = count > 0 ? String(count) : '';
          badge.style.display = count > 0 ? '' : 'none';
        }
      }
    }

    /** Rebuild the alert summary strip for a given date's outbreaks. */
    function updateSummaryStrip(allOutbreaks: DiseaseOutbreakItem[], date?: string): void {
      const items = date
        ? allOutbreaks.filter(o => localDateString(new Date(o.publishedAt)) === date)
        : allOutbreaks;
      const alertCnt = items.filter(o => o.alertLevel === 'alert').length;
      const warnCnt = items.filter(o => o.alertLevel === 'warning').length;
      const watchCnt = items.filter(o => o.alertLevel === 'watch').length;

      summaryStrip.textContent = '';
      const pill = (count: number, label: string, cls: string) =>
        h('div', { className: `summary-pill ${cls}` },
          h('span', { className: 'summary-pill-count' }, String(count)),
          h('span', { className: 'summary-pill-label' }, label),
        );
      // Legal-safe pill labels: describe media coverage volume, not an
      // epidemiological severity judgment. "Nhiều tin" ≠ "ca tử vong cao".
      summaryStrip.appendChild(pill(alertCnt, 'Nhiều tin', 'summary-pill--alert'));
      summaryStrip.appendChild(pill(warnCnt, 'Vài tin', 'summary-pill--warning'));
      summaryStrip.appendChild(pill(watchCnt, 'Ít tin', 'summary-pill--watch'));
      summaryStrip.appendChild(
        h('div', { className: 'summary-total' }, `${items.length} tin gần đây`),
      );
    }

    // Mount all panels (single flat view)
    for (const el of panels) panelsGrid.appendChild(el);

    // Mount mobile tab bar. Always present; CSS hides it on desktop.
    const mobileTabs = createMobileTabBar(appShell);
    document.body.appendChild(mobileTabs.el);

    // When any tab is activated we ask MapLibre to recompute canvas size
    // after the transition (previously-hidden containers have zero size,
    // which makes the map render blank until next interaction).
    const observer = new MutationObserver(() => {
      if (appShell.dataset.mobileTab === 'map') {
        setTimeout(() => mapShell.resize(), 50);
      }
    });
    observer.observe(appShell, { attributes: true, attributeFilter: ['data-mobile-tab'] });

    // React to viewport resize — toggle mobile mode class.
    window.addEventListener('resize', () => {
      syncMobileModeClass();
    });

    // (Footer author card moved to global header)

    // 5. Store panel refs in context
    ctx.panels.set(outbreaksPanel.id, outbreaksPanel);
    ctx.panels.set(climatePanel.id, climatePanel);
    ctx.panels.set(topDiseasesPanel.id, topDiseasesPanel);
    ctx.panels.set(regionalSignalsPanel.id, regionalSignalsPanel);
    ctx.panels.set(pipelineOpsPanel.id, pipelineOpsPanel);

    // 6. Map layer controls removed — all layers always on with their
    //    default visibility. Keeps the map uncluttered and mobile-friendly.

    // 7. Create map popup (hidden until a marker is clicked)
    const popup = new MapPopup(mapContainer);

    // 8. Wire event bus — outbreak-selected: fly to + show popup
    const UNLOCATED_PROVINCES = new Set(['Toàn quốc', 'phía Nam', 'ĐBSCL']);
    on('outbreak-selected', (data) => {
      const item = data as DiseaseOutbreakItem;

      // On mobile, list clicks must switch the active view to the map
      // before flying; otherwise the user sees nothing. Defer the actual
      // flyTo until after the tab switch so MapLibre recalculates its
      // canvas dimensions (it was display:none a moment ago).
      const needTabSwitch = isMobileViewport() && mobileTabs.getActive() !== 'map';
      if (needTabSwitch) mobileTabs.setActive('map');

      const runFly = () => {
        const isUnlocated = UNLOCATED_PROVINCES.has(item.province ?? '') || !item.province;
        if (isUnlocated) {
          mapShell.flyTo([108.0, 16.0], 5);
        } else if (item.lat != null && item.lng != null) {
          mapShell.flyTo([item.lng, item.lat], 8);
        }
        mapShell.resize();
        const cx = mapContainer.clientWidth / 2;
        const cy = mapContainer.clientHeight / 2;
        popup.show(item, cx, cy);
      };

      if (needTabSwitch) setTimeout(runFly, 60);
      else runFly();
    });

    // 9. Respond to window resize (ctx flag used by various components)
    ctx.isMobile = isMobileViewport();
    window.addEventListener('resize', () => {
      ctx.isMobile = isMobileViewport();
    });

    // 10. Data fetch + refresh logic
    const AUTO_REFRESH_MS = 10 * 60 * 1000;
    const BACKGROUND_POLL_MS = 20 * 1000;
    const DATA_AGE_REFRESH_MS = 30_000;
    let lastFetchTime = 0;
    let currentFreshness: DataFreshness | null = null;
    let latestClimateForecasts: ClimateForecast[] = [];
    let backgroundPollTimer: number | undefined;
    let pipelinePollTimer: number | undefined;

    function maxTimestamp(values: Array<number | undefined>): number | undefined {
      const valid = values.filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
      return valid.length > 0 ? Math.max(...valid) : undefined;
    }

    function deriveFreshness(
      currentOutbreaks: DiseaseOutbreakItem[],
      currentNews: NewsItem[],
      apiFetchedAt: number,
    ): DataFreshness {
      const sources = new Set<string>();
      for (const outbreak of currentOutbreaks) {
        for (const label of outbreak.sourceLabels ?? []) sources.add(label);
        if (outbreak.source) sources.add(outbreak.source);
      }
      for (const item of currentNews) {
        if (item.source) sources.add(item.source);
      }

      return {
        apiFetchedAt,
        pipelineUpdatedAt: maxTimestamp(currentOutbreaks.map((outbreak) => outbreak.pipelineUpdatedAt)),
        latestArticlePublishedAt: maxTimestamp([
          ...currentOutbreaks.map((outbreak) => outbreak.latestArticlePublishedAt ?? outbreak.publishedAt),
          ...currentNews.map((item) => item.publishedAt),
        ]),
        sourceCount: sources.size,
      };
    }

    function formatAge(ts: number): string {
      const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (secs < 60) return `${secs}s ago`;
      if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
      if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
      return `${Math.floor(secs / 86_400)}d ago`;
    }

    function updateDataAge(): void {
      if (!lastFetchTime) { dataAge.textContent = 'Loading...'; return; }
      if (currentFreshness?.backgroundStatus === 'running') {
        dataAge.textContent = 'Updating...';
        dataAge.title = [
          currentFreshness.refreshStartedAt
            ? `background refresh started ${new Date(currentFreshness.refreshStartedAt).toLocaleString('vi-VN')}`
            : 'background refresh is running',
          currentFreshness.lastSuccessfulRefreshAt
            ? `last success ${new Date(currentFreshness.lastSuccessfulRefreshAt).toLocaleString('vi-VN')}`
            : null,
        ].filter(Boolean).join(' | ');
        return;
      }
      const dataTimestamp = currentFreshness?.pipelineUpdatedAt ?? currentFreshness?.latestArticlePublishedAt;
      dataAge.textContent = dataTimestamp ? `Data ${formatAge(dataTimestamp)}` : `Updated ${formatAge(lastFetchTime)}`;
      dataAge.title = [
        `UI fetched ${formatAge(lastFetchTime)}`,
        currentFreshness?.backgroundStatus ? `background ${currentFreshness.backgroundStatus}` : null,
        currentFreshness?.pipelineUpdatedAt
          ? `pipeline updated ${new Date(currentFreshness.pipelineUpdatedAt).toLocaleString('vi-VN')}`
          : null,
        currentFreshness?.latestArticlePublishedAt
          ? `latest article ${new Date(currentFreshness.latestArticlePublishedAt).toLocaleString('vi-VN')}`
          : null,
        currentFreshness?.lastSuccessfulRefreshAt
          ? `last background success ${new Date(currentFreshness.lastSuccessfulRefreshAt).toLocaleString('vi-VN')}`
          : null,
        currentFreshness?.nextRefreshAt
          ? `next background refresh ${new Date(currentFreshness.nextRefreshAt).toLocaleString('vi-VN')}`
          : null,
        currentFreshness?.sourceCount ? `${currentFreshness.sourceCount} sources` : null,
      ].filter(Boolean).join(' | ');
    }

    async function fetchAllData(options: { refresh?: boolean } = {}): Promise<{ outbreaks: DiseaseOutbreakItem[]; stats: EpidemicStats; news: NewsItem[]; freshness: DataFreshness }> {
      invalidateBulkCache();

      try {
        // Single API call: outbreaks + stats + news in one request (saves ~67% function invocations)
        const bulk = await fetchBulkData({ refresh: options.refresh });
        lastFetchTime = Date.now();
        currentFreshness = bulk.freshness;
        updateDataAge();
        return bulk;
      } catch {
        // Fallback to individual calls if bulk endpoint unavailable
        invalidateCache('disease-outbreaks');
        invalidateCache('health-news');

        const [outbreaksResult, newsResult] = await Promise.allSettled([
          fetchDiseaseOutbreaks({ graceful: false }),
          fetchHealthNews({ graceful: false }),
        ]);

        if (outbreaksResult.status === 'rejected') {
          throw outbreaksResult.reason;
        }

        const outbreaks = outbreaksResult.value;
        const news = newsResult.status === 'fulfilled' ? newsResult.value : [];
        lastFetchTime = Date.now();
        currentFreshness = deriveFreshness(outbreaks, news, lastFetchTime);
        updateDataAge();
        // Derive minimal stats placeholder (UI no longer displays server stats)
        const stats: EpidemicStats = {
          totalOutbreaks: outbreaks.length,
          activeAlerts: outbreaks.filter(o => o.alertLevel === 'alert').length,
          countriesAffected: 0,
          topDiseases: [],
          lastUpdated: Date.now(),
        };
        return { outbreaks, stats, news, freshness: currentFreshness };
      }
    }

    function scheduleBackgroundPoll(freshness: DataFreshness): void {
      if (backgroundPollTimer !== undefined) {
        window.clearTimeout(backgroundPollTimer);
        backgroundPollTimer = undefined;
      }
      if (freshness.backgroundStatus !== 'running') return;

      backgroundPollTimer = window.setTimeout(async () => {
        backgroundPollTimer = undefined;
        try {
          await refreshData(true);
        } catch {
          // Keep the current snapshot; the backend scheduler will retry.
        }
      }, BACKGROUND_POLL_MS);
    }

    async function refreshPipelineStatus(silent = true): Promise<void> {
      try {
        const pipelineStatus = await fetchPipelineStatus({ refresh: !silent });
        pipelineOpsPanel.updateData(pipelineStatus);
      } catch (err) {
        console.error('[EpidemicMonitor] Pipeline status failed:', err);
        pipelineOpsPanel.showFetchError(() => { void refreshPipelineStatus(false); });
      }
    }

    function schedulePipelineStatusPoll(): void {
      if (pipelinePollTimer !== undefined) window.clearInterval(pipelinePollTimer);
      pipelinePollTimer = window.setInterval(() => {
        void refreshPipelineStatus(true);
      }, PIPELINE_STATUS_POLL_MS);
    }

    function applyData(outbreaks: DiseaseOutbreakItem[], _stats: EpidemicStats, news: NewsItem[], freshness: DataFreshness): void {
      ctx.outbreaks = outbreaks;
      ctx.news = news;
      currentFreshness = freshness;
      updateDataAge();
      scheduleBackgroundPoll(freshness);

      outbreaksPanel.updateData(outbreaks);
      topDiseasesPanel.updateData(outbreaks);
      regionalSignalsPanel.updateData(outbreaks, latestClimateForecasts);

      // Update timeline count badges + summary strip with latest data
      updateTimelineCounts(outbreaks);
      updateSummaryStrip(outbreaks); // show all 7-day summary by default

      // Breaking news banner
      const alertOutbreaks = outbreaks.filter(o => o.alertLevel === 'alert');
      if (alertOutbreaks.length > 0) {
        const top = alertOutbreaks[0];
        const totalCases = alertOutbreaks.reduce((s, o) => s + (o.cases ?? 0), 0);
        const latestAlertAt = Math.max(...alertOutbreaks.map(o => o.latestArticlePublishedAt ?? o.publishedAt ?? 0));
        const alertKey = [
          'alert',
          top.disease,
          canonicalProvinceName(top.province ?? ''),
          latestAlertAt,
          alertOutbreaks.length,
        ].join(':');
        banner.show(
          `${diseaseLabel(top.disease)}: ${alertOutbreaks.length} tin báo chí đang đưa, khoảng ${totalCases.toLocaleString('vi-VN')} ca được đề cập`,
          'alert',
          alertKey,
        );
      } else {
        banner.dismiss(false);
      }
    }

    // Initial fetch
    outbreaksPanel.showLoadingState();
    topDiseasesPanel.showLoading();

    let outbreaks: DiseaseOutbreakItem[];
    let stats: EpidemicStats;
    let news: NewsItem[];
    let freshness: DataFreshness;
    let initialOutbreakLoadFailed = false;

    try {
      ({ outbreaks, stats, news, freshness } = await fetchAllData());
      console.info(`[EpidemicMonitor] Live data — ${outbreaks.length} outbreaks, ${news.length} news`);
    } catch (err) {
      console.error('[EpidemicMonitor] Data fetch failed:', err);
      initialOutbreakLoadFailed = true;
      dataAge.textContent = 'Data unavailable';
      outbreaks = [];
      stats = { totalOutbreaks: 0, activeAlerts: 0, countriesAffected: 0, topDiseases: [], lastUpdated: 0 };
      news = [];
      freshness = { apiFetchedAt: Date.now(), sourceCount: 0 };
    }
    applyData(outbreaks, stats, news, freshness);

    // Shared refresh logic — saves snapshot for timeline accumulation
    async function refreshData(silent = false, forceBackendRefresh = false): Promise<void> {
      const fresh = await fetchAllData({ refresh: forceBackendRefresh });
      applyData(fresh.outbreaks, fresh.stats, fresh.news, fresh.freshness);
      // Accumulate snapshot for historical timeline
      void saveSnapshot(fresh.outbreaks);
      if (!silent) console.info(`[EpidemicMonitor] Refreshed — ${fresh.outbreaks.length} outbreaks, ${fresh.news.length} news`);
    }

    function showOutbreakFetchError(): void {
      outbreaksPanel.showFetchError(
        'Không thể tải danh sách bài báo và cảnh báo mới nhất lúc này. Thử tải lại từ panel này hoặc nút refresh ở thanh trên.',
        () => { void retryOutbreakFetch(); },
      );
    }

    async function retryOutbreakFetch(): Promise<void> {
      outbreaksPanel.showLoadingState();
      dataAge.textContent = 'Refreshing...';
      try {
        await refreshData(false, true);
      } catch (err) {
        console.error('[EpidemicMonitor] Retry failed:', err);
        dataAge.textContent = 'Data unavailable';
        showOutbreakFetchError();
      }
    }

    if (initialOutbreakLoadFailed) {
      showOutbreakFetchError();
    }

    pipelineOpsPanel.setRefreshHandler(() => { void refreshPipelineStatus(false); });
    void refreshPipelineStatus(true);
    schedulePipelineStatusPoll();

    // Refresh button handler
    refreshBtn.addEventListener('click', async () => {
      const shouldShowInlineLoading = ctx.outbreaks.length === 0;
      if (shouldShowInlineLoading) outbreaksPanel.showLoadingState();
      refreshBtn.classList.add('refreshing');
      dataAge.textContent = 'Refreshing...';
      try {
        await refreshData(false, true);
      } catch (err) {
        console.error('[EpidemicMonitor] Refresh failed:', err);
        if (shouldShowInlineLoading) {
          dataAge.textContent = 'Data unavailable';
          showOutbreakFetchError();
        } else {
          dataAge.textContent = 'Refresh failed';
        }
      }
      refreshBtn.classList.remove('refreshing');
    });

    // Auto-refresh aligned with backend cache TTL; snapshots feed the local timeline.
    setInterval(async () => {
      try { await refreshData(true); } catch { /* Silent retry next interval */ }
    }, AUTO_REFRESH_MS);

    // Update age indicator every 30 seconds
    setInterval(updateDataAge, DATA_AGE_REFRESH_MS);

    // Snapshot store: save current data + detect escalations (watch→warning→alert)
    try {
      await initSnapshotDB();
      await saveSnapshot(outbreaks);
      void pruneOldSnapshots(30);

      const snapshots = await getRecentSnapshots(30);
      const escalations = detectEscalations(snapshots);
      if (escalations.length > 0) {
        outbreaksPanel.setEscalations(escalations);
      }
    } catch {
      // IndexedDB unavailable — escalations feature disabled silently
    }

    // Build per-country risk score map for choropleth
    const riskWeight: Record<string, number> = { alert: 1, warning: 0.6, watch: 0.3 };
    const riskScores = new Map<string, number>();
    for (const o of outbreaks) {
      const prev = riskScores.get(o.countryCode) ?? 0;
      const score = riskWeight[o.alertLevel] ?? 0.2;
      if (score > prev) riskScores.set(o.countryCode, score);
    }

    // Wire map layers
    const mapCallbacks = {
      // Map marker click: show popup + filter list + highlight province
      onMarkerClick: (item: DiseaseOutbreakItem) => {
        emit('outbreak-selected', item);
        emit('map-marker-clicked', item);
      },
      onCountryClick: (code: string) => {
        const profile = ctx.countryProfiles.get(code);
        if (profile) emit('country-selected', profile);
      },
    };
    updateMapLayers(mapShell, outbreaks, riskScores, null, mapCallbacks);

    // List row click → highlight matching province markers on map
    on('outbreak-selected', (data) => {
      const item = data as DiseaseOutbreakItem;
      if (item.province) setHighlightedProvince(item.province);
    });

    // Province filter cleared from panel → clear map highlight
    on('province-filter-changed', (data) => {
      setHighlightedProvince((data as string | null));
    });

    // Time filter: re-render map layers with filtered outbreaks
    on('time-filter-changed', (data) => {
      const ms = data as number;
      const now = Date.now();
      const filtered = ms > 0
        ? outbreaks.filter(o => (now - o.publishedAt) <= ms)
        : outbreaks;
      updateMapLayers(mapShell, filtered, riskScores, null, mapCallbacks);
      outbreaksPanel.updateData(filtered);
    });

    // Day selected on timeline — toggle: click active day → show all; click other → filter
    on('day-selected', (data) => {
      const date = data as string;
      const isDeselect = date === _selectedDate; // clicking already-active day
      _selectedDate = isDeselect ? todayStr : date;

      for (const [day, btn] of tlBtns) {
        btn.classList.toggle('timeline-day-btn--active', isDeselect ? day === todayStr : day === date);
      }

      if (isDeselect) {
        // Deselect → show all 7 days, highlight today on map
        setSelectedDate(todayStr);
        outbreaksPanel.filterByDate(null);
        updateSummaryStrip(ctx.outbreaks);
      } else {
        // Select specific day → filter panel, highlight on map
        setSelectedDate(date);
        outbreaksPanel.filterByDate(date);
        updateSummaryStrip(ctx.outbreaks, date);
      }
    });

    // Default: show ALL 7 days — today highlighted on map
    setSelectedDate(todayStr);
    outbreaksPanel.filterByDate(null); // show all days, not just today

    // 11. Legacy district boundaries are intentionally not loaded. The bundled
    // ADM2 file predates the 34-province administrative model and can mislead
    // outbreak interpretation.

    // 12. Fetch climate forecasts after initial render. Weather is useful for
    // regional risk enrichment, but it should not delay the outbreak dashboard.
    scheduleDeferredClimateLoad(() => {
      fetchClimateForecasts().then((forecasts) => {
        latestClimateForecasts = forecasts;
        climatePanel.updateData(forecasts);
        regionalSignalsPanel.updateData(ctx.outbreaks, forecasts);

        // Early warnings: provinces with HIGH climate risk but NO active outbreak
        const outbreakProvinces = new Set(outbreaks.map(o => canonicalProvinceName(o.province ?? '')).filter(Boolean));
        const warnings = detectEarlyWarnings(forecasts, outbreakProvinces);
        if (warnings.length > 0) {
          setEarlyWarnings(warnings);
          console.info(`[EpidemicMonitor] ${warnings.length} early warning(s): ${warnings.map(w => w.province).join(', ')}`);
        }
      }).catch(() => {
        // Climate panel shows sample data via service fallback
      });
    });

    // Wire province-selected from climate panel → map flyTo
    on('province-selected', (data) => {
      const { lat, lng } = data as { lat: number; lng: number; province: string };
      mapShell.flyTo([lng, lat], 8);
    });

    console.info('[EpidemicMonitor] App initialized');
  } catch (err) {
    console.error('[EpidemicMonitor] Failed to initialize app:', err);
    const app = document.getElementById('app');
    if (app) {
      app.innerHTML =
        '<div style="color:#e03e3e;padding:24px;font-family:sans-serif">' +
        'Failed to load Epidemic Monitor. Please refresh the page.</div>';
    }
  }
}
