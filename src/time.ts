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

/** 一天里的哪一段。她需要知道「现在是深夜」，不然会想出「下午出去走走」。 */
export function timeOfDay(ms: number, tz: string): string {
  const h = localHour(ms, tz);
  if (h >= 5 && h < 8) return '清晨';
  if (h >= 8 && h < 11) return '上午';
  if (h >= 11 && h < 13) return '中午';
  if (h >= 13 && h < 17) return '下午';
  if (h >= 17 && h < 19) return '傍晚';
  if (h >= 19 && h < 23) return '晚上';
  return '深夜';
}

export function localHour(ms: number, tz: string): number {
  const s = formatLocal(ms, tz);
  return Number(s.slice(11, 13)) || 0;
}

/** 心情说成人话，和记忆核心的档位对齐。 */
export function moodWord(mood: number): string {
  const v = Number(mood);
  if (!Number.isFinite(v)) return '一般';
  if (v >= 78) return '很好';
  if (v >= 62) return '还行';
  if (v >= 45) return '一般';
  if (v >= 30) return '有点低落';
  return '很难过';
}

export function clip(text: string, limit: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
