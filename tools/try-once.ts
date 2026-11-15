/**
 * 立刻想一次，看输出像不像人。不写任何文件。
 *
 * 用法（PowerShell / cmd）：
 *   set SA_KEY=你的key
 *   set SA_BASE=https://api.deepseek.com/v1
 *   set SA_MODEL=deepseek-chat
 *   node --experimental-transform-types tools/try-once.ts
 *
 * 三个变量都有默认值（base/model 默认 DeepSeek），只设 SA_KEY 也行。
 * 会拿你记忆核心的真实卡片当素材，跑三种模式各一次，大约几分钱。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { thinkOnce } from '../src/think.ts';
import { density } from '../src/pool.ts';

const KEY = process.env.SA_KEY ?? '';
const BASE = process.env.SA_BASE ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.SA_MODEL ?? 'deepseek-chat';
const DATA = process.env.SA_DATA ?? 'F:/Coopanion/data/home/companion/data';

if (!KEY) {
  console.error('没设密钥。先 set SA_KEY=你的key，再跑一次。');
  process.exit(1);
}

function readCards(): { text: string; kind: string; status?: string }[] {
  try {
    return readFileSync(join(DATA, 'memory-core/cards.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { text: string; kind: string; status?: string })
      .filter((c) => c.status !== 'retired' && c.text);
  } catch {
    console.warn(`读不到 ${DATA}/memory-core/cards.jsonl，用空素材跑（只能看语气）。`);
    return [];
  }
}

const cards = readCards();
const bias: Record<string, number> = { self: 1.5, episode: 1.25, promise: 1.1, note: 0.95, fact: 0.65 };
const picked = [...cards]
  .sort(() => Math.random() - 0.5)
  .sort((a, b) => (bias[b.kind] ?? 0.7) - (bias[a.kind] ?? 0.7))
  .slice(0, 4);

console.log(`素材 ${cards.length} 张，这次挑：`);
for (const c of picked) console.log(`  [${c.kind}] ${c.text.slice(0, 50)}`);
console.log('');

for (const mode of ['wonder', 'doubt', 'reflect'] as const) {
  const t0 = Date.now();
  const res = await thinkOnce(
    mode,
    {
      now: '11-15 23:10，你在窗边，精力 62',
      silence: '6 小时',
      memories: picked.map((c) => c.text.slice(0, 70)),
      recent: [],
      focus: picked[0]?.text.slice(0, 50),
      persona: process.env.SA_PERSONA,
    },
    { baseUrl: BASE, model: MODEL, apiKey: KEY, maxTokens: 220, temperature: 0.95 },
    ['try'],
  );
  if (!res.ok) {
    console.log(`[${mode}] 失败：${res.reason}`);
    continue;
  }
  const t = res.thought!;
  console.log(`[${mode}] ${t.text.length} 字 · 重要度 ${t.importance} · 密度 ${density(t).toFixed(2)} · ${Date.now() - t0}ms · ${res.promptTokens}+${res.outputTokens} tok`);
  console.log(`「${t.text}」\n`);
}
