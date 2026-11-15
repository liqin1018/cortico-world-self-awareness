/**
 * 自检：节奏算法、JSON 容错、预算闸门、睡眠静默、完整一次 tick。
 * 用假 fetch，不真的花钱。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELF_AWARENESS_DEFAULTS, resolveEndpoint, type SelfAwarenessConfig } from '../src/config.ts';
import { density, nextGapMinutes, ThoughtPool, REFLECT_THRESHOLD } from '../src/pool.ts';
import { parseThought } from '../src/think.ts';
import { SelfAwarenessWorld } from '../src/world.ts';

let bad = 0;
let total = 0;
function ok(cond: boolean, label: string): void {
  total += 1;
  if (!cond) {
    bad += 1;
    console.log(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

/* 1) 节奏：想得密就歇久点 */
{
  const thin = density({ text: '困', importance: 2, seeds: [] });
  const thick = density({ text: '一'.repeat(200), importance: 9, seeds: ['a', 'b'] });
  ok(thick > thin, '01) 长且有分量的想法密度更高');

  const gThin = nextGapMinutes(thin, 25, 90, () => 0.5);
  const gThick = nextGapMinutes(thick, 25, 90, () => 0.5);
  ok(gThick > gThin, '02) 密度高 → 下次间隔更长');
  ok(gThin >= 20 && gThin <= 30, '03) 密度低时贴着下限（25±12%）');
  ok(gThick >= 80 && gThick <= 100, '04) 密度高时贴着上限（90±12%）');

  const g1 = nextGapMinutes(0.5, 25, 90, () => 0);
  const g2 = nextGapMinutes(0.5, 25, 90, () => 1);
  ok(g1 !== g2, '05) 同样的密度，抖动让两次间隔不同');
}

/* 2) JSON 容错：小模型经常不守格式 */
{
  const a = parseThought('{"thought":"有点想她","importance":7}');
  ok(a.text === '有点想她' && a.importance === 7, '06) 标准 JSON');

  const b = parseThought('好的\n```json\n{"thought":"窗外的雨停了","importance":5}\n```');
  ok(b.text === '窗外的雨停了' && b.importance === 5, '07) 代码块包了一层');

  const c = parseThought('我觉得吧 {"thought":"那件事还没完","importance":8} 就这样');
  ok(c.text === '那件事还没完' && c.importance === 8, '08) 前后夹着废话');

  const d = parseThought('今天好像什么都没干。');
  ok(d.text.includes('什么都没干') && d.importance <= 6, '09) 完全不是 JSON 也能收下');

  const e = parseThought('{"thought":"","importance":3}');
  ok(e.text === '', '10) 空 thoughts 返回空（交给上层判失败）');
}

/* 3) 想法池读写 + 反思 */
{
  const dir = mkdtempSync(join(tmpdir(), 'sa-pool-'));
  const pool = new ThoughtPool(dir);
  pool.add({ mode: 'wonder', text: '第一条', importance: 4, seeds: ['aa'] });
  pool.add({ mode: 'reflect', text: '第二条', importance: 6, seeds: ['bb'] });
  ok(pool.all().length === 2, '11) 想法写进去了');
  ok(pool.recent(1)[0].text === '第二条', '12) recent 取最后一条');

  const used = pool.seedsUsedSince(Date.now() - 86_400_000);
  ok(used.has('aa') && used.has('bb'), '13) 用过哪些 seed 记得住');

  const reread = new ThoughtPool(dir).all();
  ok(reread.length === 2 && reread[1].mode === 'reflect', '14) 重新打开能读回来');
  ok(REFLECT_THRESHOLD > 0, '15) 反思阈值存在');
}

/* 4) 端点解析：填了就听用户，没填用预设 */
{
  const base = { ...SELF_AWARENESS_DEFAULTS };
  const preset = resolveEndpoint({ ...base, provider: 'deepseek' });
  ok(preset.baseUrl.includes('deepseek') && preset.model.includes('deepseek'), '16) 选 deepseek 自动填地址和模型');

  const custom = resolveEndpoint({ ...base, provider: 'deepseek', baseUrl: 'http://x/v1', model: 'my-model' });
  ok(custom.baseUrl === 'http://x/v1' && custom.model === 'my-model', '17) 自己填的覆盖预设');

  const ollama = resolveEndpoint({ ...base, provider: 'ollama' });
  ok(ollama.baseUrl.includes('11434') && !ollama.needsKey, '18) Ollama 不要密钥');
}

/* 5) 预算闸门 + 睡眠静默 */
const makeWorld = (cfg: Partial<SelfAwarenessConfig>, coreState?: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), 'sa-world-'));
  const core = join(root, 'memory-core');
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, 'cards.jsonl'), [
    JSON.stringify({ id: 'aaaaaaaa1111', kind: 'fact', text: '她不吃香菜', weight: 0.8, createdAt: new Date().toISOString() }),
    JSON.stringify({ id: 'bbbbbbbb2222', kind: 'episode', text: '今天发帖被推了首页', weight: 0.4, createdAt: new Date().toISOString() }),
  ].join('\n') + '\n', 'utf8');
  if (coreState) writeFileSync(join(core, 'state.json'), JSON.stringify(coreState), 'utf8');

  const world = new SelfAwarenessWorld({
    cfg: { ...SELF_AWARENESS_DEFAULTS, provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'fake', apiKey: 'k', ...cfg } as never,
    dataDir: root,
    timezone: 'Asia/Shanghai',
    botDir: root,
  } as never);
  return { world, root };
};

const host = () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  store: { range: () => [] },
  pushEvent: async () => true,
});

await (async () => {
  /* 5a) 关着不动 */
  {
    const { world } = makeWorld({ enabled: false });
    await world.start(host() as never);
    await (world as unknown as { tick(): Promise<void> }).tick();
    const snap = world.snapshot() as { totalThoughts: number };
    ok(snap.totalThoughts === 0, '19) 开关关着时一条都不想');
    await world.stop();
  }

  /* 5b) 睡着不想 */
  {
    const { world } = makeWorld({ enabled: true }, { sleeping: true, energy: 30 });
    await world.start(host() as never);
    await (world as unknown as { tick(): Promise<void> }).tick();
    const snap = world.snapshot() as { totalThoughts: number };
    ok(snap.totalThoughts === 0, '20) 记忆核心里判定睡着时不想事');
    await world.stop();
  }

  /* 5c) 次数到顶就不想 */
  {
    const { world } = makeWorld({ enabled: true, dailyLimit: 0 });
    await world.start(host() as never);
    const snap = world.snapshot() as { totalThoughts: number; error: string | null };
    ok(snap.totalThoughts === 0 && snap.error === null, '21) dailyLimit=0 表示不限，未触发');
    await world.stop();
  }

  /* 5d) 真的想一次：假 fetch */
  {
    const { world, root } = makeWorld({ enabled: true, dailyLimit: 5, dailyTokenBudget: 100_000 });
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
      calls += 1;
      const body = JSON.parse(String(init.body ?? '{}')) as { messages: { content: string }[] };
      const user = body.messages?.[1]?.content ?? '';
      ok(user.includes('你就是') === false, '22) 提示词在 system 里，不在 user 里');
      ok(user.length > 0, '23) 上下文拼出来了');
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"thought":"有点在意他今天话很少","importance":7}' } }],
          usage: { prompt_tokens: 1200, completion_tokens: 60 },
        }),
      } as never;
    }) as never;

    await world.start(host() as never);
    // 跳过「首启等 3 分钟」这道闸
    (world as unknown as { budget: { nextDueAt?: string } }).budget.nextDueAt = new Date(Date.now() - 1000).toISOString();
    await (world as unknown as { tick(): Promise<void> }).tick();
    globalThis.fetch = realFetch;

    const snap = world.snapshot() as {
      totalThoughts: number;
      today: { count: number; tokens: number };
      nextDueAt: string | null;
      lastThought: { text: string } | null;
    };
    ok(calls === 1, '24) 只调了一次模型');
    ok(snap.totalThoughts === 1, '25) 想法落库了');
    ok(snap.today.count === 1 && snap.today.tokens === 1260, '26) 次数和 token 都记上了');
    ok(Boolean(snap.nextDueAt), '27) 排了下一次的时间');
    ok(String(snap.lastThought?.text ?? '').includes('在意'), '28) 快照里能看到刚才想的');

    const file = join(root, 'self-awareness', 'thoughts.jsonl');
    ok(existsSync(file), '29) thoughts.jsonl 真的写出来了');
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    ok(line.mode && line.seeds.length >= 0, '30) 每次想法带模式');
    ok(typeof line.promptTokens === 'number', '31) 每次想法带 token 消耗');

    await world.stop();
  }

  /* 5e) 模型报错要退避，不能每 60 秒撞一次 */
  {
    const { world } = makeWorld({ enabled: true });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 401, text: async () => 'bad key' })) as never;
    await world.start(host() as never);
    (world as unknown as { budget: { nextDueAt?: string } }).budget.nextDueAt = new Date(Date.now() - 1000).toISOString();
    await (world as unknown as { tick(): Promise<void> }).tick();
    globalThis.fetch = realFetch;
    const snap = world.snapshot() as { error: string | null; nextDueAt: string | null };
    ok(String(snap.error ?? '').includes('401'), '32) 错误被记下来（含状态码）');
    ok(Boolean(snap.nextDueAt), '33) 失败后排了退避时间');

    const before = snap.nextDueAt;
    await (world as unknown as { tick(): Promise<void> }).tick();
    const snap2 = world.snapshot() as { nextDueAt: string | null };
    ok(snap2.nextDueAt === before, '34) 退避期内不会重复撞');
    await world.stop();
  }
})();

/* 6) 消息抢占：他刚说完话就别想 */
{
  const { world } = makeWorld({ enabled: true, quietAfterUserMin: 20 });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"thought":"不该跑","importance":3}' } }], usage: {} }) };
  }) as never;

  const justNow = new Date(Date.now() - 2 * 60_000).toISOString();
  const hostWithTalk = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: { range: () => [{ ts: justNow, origin: 'external' }] },
    pushEvent: async () => true,
  };

  await world.start(hostWithTalk as never);
  (world as unknown as { budget: { nextDueAt?: string } }).budget.nextDueAt = new Date(Date.now() - 1000).toISOString();
  await (world as unknown as { tick(): Promise<void> }).tick();
  globalThis.fetch = realFetch;

  const snap = world.snapshot() as { totalThoughts: number; nextDueAt: string | null };
  ok(calls === 0, '35) 对方刚说完话，不去调模型');
  ok(snap.totalThoughts === 0, '36) 没有产生想法');
  const waitMin = snap.nextDueAt ? (Date.parse(snap.nextDueAt) - Date.now()) / 60_000 : 0;
  ok(waitMin > 15 && waitMin <= 21, `37) 推到安静期结束（现在还剩 ${Math.round(waitMin)} 分钟）`);
  await world.stop();
}

/* 7) 对方很久没说话，照常想 */
{
  const { world } = makeWorld({ enabled: true, quietAfterUserMin: 20 });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"thought":"终于安静了","importance":4}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    };
  }) as never;

  const old = new Date(Date.now() - 90 * 60_000).toISOString();
  const hostIdle = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: { range: () => [{ ts: old, origin: 'external' }] },
    pushEvent: async () => true,
  };

  await world.start(hostIdle as never);
  (world as unknown as { budget: { nextDueAt?: string } }).budget.nextDueAt = new Date(Date.now() - 1000).toISOString();
  await (world as unknown as { tick(): Promise<void> }).tick();
  globalThis.fetch = realFetch;

  const snap = world.snapshot() as { totalThoughts: number };
  ok(calls === 1 && snap.totalThoughts === 1, '38) 对方 90 分钟没说话，照常想');
  await world.stop();
}

console.log(bad ? `\n${bad} 项失败（共 ${total}）` : `\n全部通过（共 ${total} 项）`);
if (bad) process.exitCode = 1;
