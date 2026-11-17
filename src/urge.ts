/**
 * 想说话的冲动。
 *
 * 插件本身永远不发消息（这是它能「静默思考」的前提），但当对方刚结束对话、
 * 她又正好在惦记一件事时，把这份「想说」写成一条本地记录。记忆核心读到它，
 * 会挑一个合适的时机替她开口——开口的仍然是主模型，不是这个插件。
 *
 * 所以这是「把冲动交出去」，不是「插件说话」。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Urge {
  id: string;
  ts: string;
  type: 'silence';
  text: string;
  importance: number;
  sourceId?: string;
  /** 写这条时，对方已经安静了多少分钟。 */
  quietMin: number;
}

const FILE = 'urges.jsonl';

export function appendUrge(dir: string, urge: Urge): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, FILE), `${JSON.stringify(urge)}\n`, 'utf8');
}

/** 读最近几条；坏行跳过，手改过文件也不至于整片读不出来。 */
export function readUrges(dir: string, limit = 20): Urge[] {
  const file = join(dir, FILE);
  if (!existsSync(file)) return [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Urge[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as Partial<Urge>;
      if (typeof o.text !== 'string' || !o.text.trim()) continue;
      out.push({
        id: String(o.id ?? ''),
        ts: String(o.ts ?? ''),
        type: 'silence',
        text: o.text,
        importance: Number(o.importance) || 5,
        ...(o.sourceId ? { sourceId: String(o.sourceId) } : {}),
        quietMin: Number(o.quietMin) || 0,
      });
    } catch {
      // 坏行跳过
    }
  }
  return out.slice(-limit);
}
