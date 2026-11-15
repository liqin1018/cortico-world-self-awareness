/** 时间小工具：只留这个插件用得到的几个。 */

export function formatLocal(iso: string | number | Date, tz: string): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

export function dayKey(ms: number, tz: string): string {
  return formatLocal(ms, tz).slice(0, 10);
}

/** 「6 小时前」这种话。 */
export function humanSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = m / 60;
  if (h < 24) return h < 2 ? `${Math.round(h * 10) / 10} 小时` : `${Math.round(h)} 小时`;
  return `${Math.round(h / 24)} 天`;
}

export function clip(text: string, limit: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
