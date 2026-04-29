import { Panel } from '@/components/panel-base';
import { h } from '@/utils/dom-utils';
import type { PipelineEvent, PipelineRun, PipelineStatus } from '@/types';

const STAGES = ['scan', 'base-url', 'classify', 'extract', 'verify', 'snapshot', 'd1-sync'];

interface StageSummary {
  stage: string;
  status: string;
  count: string;
  detail: string;
  work: string;
  result: string;
  errors: string;
}

function formatAge(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'n/a';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return 'n/a';
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function formatTime(ts: number | undefined): string {
  if (!ts) return 'n/a';
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusLabel(value: string): string {
  if (value === 'succeeded') return 'OK';
  if (value === 'running') return 'RUN';
  if (value === 'waiting') return 'WAIT';
  if (value === 'failed') return 'ERR';
  return value.toUpperCase();
}

function stageStatus(events: PipelineEvent[], stage: string): string {
  return events.find((event) => event.stage === stage)?.status ?? 'idle';
}

function summarizeBacklog(run: PipelineRun): number {
  return run.pendingJobs + run.runningJobs + run.deadJobs;
}

function eventMeta(event: PipelineEvent | undefined): Record<string, unknown> {
  return event?.meta && typeof event.meta === 'object' ? event.meta as Record<string, unknown> : {};
}

function metric(meta: Record<string, unknown>, key: string): number | undefined {
  const value = meta[key];
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function nestedMetric(meta: Record<string, unknown>, key: string, nestedKey: string): number | undefined {
  const value = meta[key];
  if (!value || typeof value !== 'object') return undefined;
  return metric(value as Record<string, unknown>, nestedKey);
}

function fmt(value: number | undefined, fallback = '0'): string {
  return value == null ? fallback : value.toLocaleString('vi-VN');
}

function stageSummary(stage: string, run: PipelineRun, event: PipelineEvent | undefined): StageSummary {
  const status = event?.status ?? 'idle';
  const meta = eventMeta(event);
  const errors = metric(meta, 'errors') ?? 0;

  if (stage === 'scan') {
    const seen = metric(meta, 'seenArticles');
    const added = metric(meta, 'newArticles') ?? run.scanNew;
    const changed = metric(meta, 'changedArticles') ?? run.scanChanged;
    return {
      stage,
      status,
      count: `${fmt(added)} new`,
      detail: `${fmt(changed)} chg / ${fmt(seen, '-')} seen`,
      work: `${fmt(seen, '-')} seen`,
      result: `${fmt(added)} new, ${fmt(changed)} chg`,
      errors: '-',
    };
  }

  if (stage === 'base-url') {
    const attempts = metric(meta, 'attempts');
    const waitedMs = metric(meta, 'waitedMs');
    const httpStatus = nestedMetric(meta, 'lastProbe', 'status');
    const ready = meta.ready === true;
    return {
      stage,
      status,
      count: `${fmt(attempts, '1')} try`,
      detail: httpStatus ? `HTTP ${httpStatus} / ${formatDuration(waitedMs)}` : formatDuration(waitedMs),
      work: `${fmt(attempts, '1')} probe`,
      result: ready ? 'ready' : (httpStatus ? `HTTP ${httpStatus}` : statusLabel(status)),
      errors: status === 'failed' || status === 'waiting' ? statusLabel(status) : '-',
    };
  }

  if (stage === 'classify') {
    const claimed = metric(meta, 'claimed');
    const processed = metric(meta, 'processed') ?? run.classified;
    const positives = metric(meta, 'positives') ?? run.positives;
    return {
      stage,
      status,
      count: `${fmt(processed)} done`,
      detail: `${fmt(positives)} pos / ${fmt(errors)} err`,
      work: `${fmt(claimed, '-')} claimed`,
      result: `${fmt(processed)} done, ${fmt(positives)} pos`,
      errors: fmt(errors),
    };
  }

  if (stage === 'extract' || stage === 'verify') {
    const claimed = metric(meta, 'claimed') ?? (stage === 'extract' ? run.extracted : run.verified);
    const published = metric(meta, 'published');
    const rejected = metric(meta, 'rejected');
    return {
      stage,
      status,
      count: `${fmt(claimed)} jobs`,
      detail: `${fmt(published, '-')} pub / ${fmt(rejected, '-')} rej`,
      work: `${fmt(claimed)} claimed`,
      result: `${fmt(published, '-')} pub, ${fmt(rejected, '-')} rej`,
      errors: fmt(errors),
    };
  }

  if (stage === 'snapshot') {
    const articleCount = metric(meta, 'articleCount') ?? run.articleCount;
    const eventCount = metric(meta, 'events') ?? run.eventCount;
    const publishedOutbreaks = metric(meta, 'publishedOutbreaks');
    return {
      stage,
      status,
      count: `${fmt(articleCount)} rows`,
      detail: `${fmt(eventCount)} ev / ${fmt(publishedOutbreaks, '-')} pub`,
      work: `${fmt(articleCount)} articles`,
      result: `${fmt(eventCount)} events`,
      errors: '-',
    };
  }

  if (stage === 'd1-sync') {
    const itemCount = metric(meta, 'itemCount') ?? run.d1ItemCount;
    const publishedCount = metric(meta, 'publishedCount') ?? run.d1PublishedCount;
    const newsOnlyCount = metric(meta, 'newsOnlyCount');
    return {
      stage,
      status,
      count: `${fmt(itemCount)} rows`,
      detail: `${fmt(publishedCount)} pub / ${fmt(newsOnlyCount, '-')} news`,
      work: `${fmt(itemCount)} upsert`,
      result: `${fmt(publishedCount)} pub, ${fmt(newsOnlyCount, '-')} news`,
      errors: '-',
    };
  }

  return {
    stage,
    status,
    count: '-',
    detail: statusLabel(status),
    work: '-',
    result: '-',
    errors: '-',
  };
}

export class PipelineOpsPanel extends Panel {
  private status: PipelineStatus | null = null;
  private refresh: (() => void) | null = null;

  constructor() {
    super({ id: 'pipeline-ops', title: 'Kỹ thuật pipeline', showCount: true, defaultRowSpan: 3 });
    this.showLoading();
  }

  setRefreshHandler(handler: () => void): void {
    this.refresh = handler;
  }

  updateData(status: PipelineStatus): void {
    this.status = status;
    const latestRun = status.latest?.run;
    this.setCount(latestRun ? summarizeBacklog(latestRun) : 0);
    this.render();
  }

  showFetchError(retry: () => void): void {
    this.showError('Không tải được trạng thái pipeline.', retry);
  }

  private render(): void {
    if (!this.status?.latest?.run) {
      this.setContentNode(h('div', { className: 'pipeline-empty' }, 'Chưa có telemetry từ worker.'));
      return;
    }

    const latest = this.status.latest;
    const run = latest.run;
    const events = [...latest.events].sort((a, b) => b.createdAt - a.createdAt);
    const heartbeatAge = run.heartbeatAt ? Date.now() - run.heartbeatAt : undefined;
    const healthClass = `pipeline-health--${this.status.health.state}`;
    const refreshBtn = h('button', {
      className: 'pipeline-refresh-btn',
      type: 'button',
      title: 'Tải lại trạng thái pipeline',
    }, '↻');
    refreshBtn.addEventListener('click', () => this.refresh?.());

    const stageSummaries = STAGES.map((stage) => stageSummary(
      stage,
      run,
      events.find((event) => event.stage === stage),
    ));

    const stageNodes = stageSummaries.map((summary) => {
      const status = stageStatus(events, summary.stage);
      return h('span', { className: `pipeline-stage pipeline-stage--${status}` },
        h('span', { className: 'pipeline-stage-name' }, summary.stage),
        h('span', { className: 'pipeline-stage-count' }, summary.count),
        h('span', { className: 'pipeline-stage-status' }, statusLabel(status)),
        h('span', { className: 'pipeline-stage-detail' }, summary.detail),
      );
    });

    const summaryRows = stageSummaries.map((summary) => h('div', {
      className: `pipeline-summary-row pipeline-summary-row--${summary.status}`,
    },
      h('span', null, summary.stage),
      h('span', null, summary.work),
      h('span', null, summary.result),
      h('span', null, summary.errors),
    ));

    const eventRows = events.slice(0, 8).map((event) => h('div', {
      className: `pipeline-event pipeline-event--${event.status}`,
      title: event.message ?? event.stage,
    },
      h('span', { className: 'pipeline-event-time' }, formatTime(event.createdAt)),
      h('span', { className: 'pipeline-event-stage' }, event.stage),
      h('span', { className: 'pipeline-event-message' }, event.message ?? event.status),
    ));

    this.setContentNode(h('div', { className: 'pipeline-root' },
      h('div', { className: `pipeline-health ${healthClass}` },
        h('div', { className: 'pipeline-health-main' },
          h('span', { className: 'pipeline-health-state' }, this.status.health.state.toUpperCase()),
          h('span', { className: 'pipeline-health-reason' }, this.status.health.reason),
        ),
        refreshBtn,
      ),
      h('div', { className: 'pipeline-kpis' },
        h('div', { className: 'pipeline-kpi' }, h('b', null, String(run.pendingJobs)), h('span', null, 'pending')),
        h('div', { className: 'pipeline-kpi' }, h('b', null, String(run.runningJobs)), h('span', null, 'running')),
        h('div', { className: 'pipeline-kpi' }, h('b', null, String(run.deadJobs)), h('span', null, 'dead')),
        h('div', { className: 'pipeline-kpi' }, h('b', null, formatAge(heartbeatAge)), h('span', null, 'heartbeat')),
      ),
      h('div', { className: 'pipeline-stage-grid' }, ...stageNodes),
      h('div', { className: 'pipeline-summary-table' },
        h('div', { className: 'pipeline-summary-row pipeline-summary-row--head' },
          h('span', null, 'node'),
          h('span', null, 'work'),
          h('span', null, 'result'),
          h('span', null, 'err'),
        ),
        ...summaryRows,
      ),
      h('div', { className: 'pipeline-run-meta' },
        h('span', null, `run ${run.runId}`),
        h('span', null, `duration ${formatDuration(run.durationMs)}`),
        h('span', null, `items ${run.d1ItemCount}`),
        h('span', null, `classified ${run.classified}`),
      ),
      run.error ? h('div', { className: 'pipeline-error-line', title: run.error }, run.error) : null,
      h('div', { className: 'pipeline-events' }, ...eventRows),
    ));
  }
}
