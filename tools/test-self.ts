/**
 * 自检：节奏算法、JSON 容错、预算闸门、睡眠静默、完整一次 tick。
 * 用假 fetch，不真的花钱。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELF_AWARENESS_DEFAULTS, resolveEndpoint, type SelfAwarenessConfig } from '../src/config.ts';
import { density, nextGapMinutes, noteTtlMs, ThoughtPool, REFLECT_THRESHOLD } from '../src/pool.ts';
import { parseThought, buildMessages } from '../src/think.ts';
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
    // probeOnStart 会额外发一次 fetch，污染「调了几次模型」这类断言
    cfg: { ...SELF_AWARENESS_DEFAULTS, probeOnStart: false, provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'fake', apiKey: 'k', ...cfg } as never,
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

/* 8) 她自己定下次什么时候想 */
{
  const { world } = makeWorld({ enabled: true, dailyLimit: 20, minGapMin: 25, maxGapMin: 90 });
  const realFetch = globalThis.fetch;
  const users: string[] = [];
  let nth = 0;
  globalThis.fetch = (async (_u: unknown, init: { body?: string } = {}) => {
    const body = JSON.parse(String(init.body ?? '{}')) as { messages: { content: string }[] };
    users.push(body.messages?.[1]?.content ?? '');
    nth += 1;
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: `{"thought":"第${nth}条","importance":6,"next":{"in":300,"note":"留话${nth}"}}`,
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }),
    } as never;
  }) as never;

  await world.start(host() as never);
  const internals = world as unknown as { budget: { nextDueAt?: string; lastNoteId?: string }; tick(): Promise<void> };

  internals.budget.nextDueAt = new Date(Date.now() - 1000).toISOString();
  await internals.tick();
  const gap1 = (Date.parse(String(internals.budget.nextDueAt)) - Date.now()) / 60_000;
  ok(gap1 > 290 && gap1 < 305, `39) 她说明天再看 → 间隔按她说的 300 分钟（实际 ${Math.round(gap1)}）`);

  // 第二次：应该把上次那句原样递回去
  internals.budget.nextDueAt = new Date(Date.now() - 1000).toISOString();
  await internals.tick();
  const second = users[1] ?? '';
  ok(second.includes('上次你自己留了一句'), '40) 下次的上下文里有她自己的留话');
  ok(second.includes('留话1'), '41) 递回去的是原文');
  ok(Boolean(internals.budget.lastNoteId), '42) 记下已经递过哪条');

  // 第三次：同一条不重复递
  internals.budget.nextDueAt = new Date(Date.now() - 1000).toISOString();
  await internals.tick();
  const third = users[2] ?? '';
  ok(third.includes('留话2') && !third.includes('留话1'), '43) 只递最新那条，旧的不会再翻出来');

  globalThis.fetch = realFetch;
  await world.stop();
}

/* 9) 她没留话时按密度兜底 */
{
  const { world } = makeWorld({ enabled: true, dailyLimit: 20, minGapMin: 25, maxGapMin: 90 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"thought":"没什么","importance":3}' } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }),
  })) as never;

  await world.start(host() as never);
  const internals = world as unknown as { budget: { nextDueAt?: string }; tick(): Promise<void> };
  internals.budget.nextDueAt = new Date(Date.now() - 1000).toISOString();
  await internals.tick();
  const gap = (Date.parse(String(internals.budget.nextDueAt)) - Date.now()) / 60_000;
  ok(gap >= 20 && gap <= 45, `44) 她没留话 → 按密度算，落在 25-35 附近（实际 ${Math.round(gap)}）`);

  globalThis.fetch = realFetch;
  await world.stop();
}

/* 10) 测接口：不写文件、不占次数、不动 lastError */
{
  const { world } = makeWorld({ enabled: true, apiKey: 'k', provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' });
  const realFetch = globalThis.fetch;
  await world.start(host() as never);

  const before = world.snapshot() as { today: { count: number; tokens: number }; totalThoughts: number; error: string | null };

  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '好' } }], usage: { prompt_tokens: 12, completion_tokens: 2 } }),
  })) as never;
  const good = await (world as unknown as { probe(): Promise<{ ok: boolean; ms: number; model?: string }> }).probe();
  ok(good.ok && good.model === 'm', '45) 接口通了，返回模型名');

  const mid = world.snapshot() as { today: { count: number; tokens: number }; totalThoughts: number; error: string | null };
  ok(mid.today.count === before.today.count, '46) 测接口不占今天的次数');
  ok(mid.today.tokens === before.today.tokens, '47) 测接口不计 token');
  ok(mid.totalThoughts === before.totalThoughts, '48) 测接口不产生想法');
  ok(mid.error === null, '49) 测试成功也不动 lastError');

  globalThis.fetch = (async () => ({ ok: false, status: 401, text: async () => 'bad key' })) as never;
  const bad = await (world as unknown as { probe(): Promise<{ ok: boolean; error?: string }> }).probe();
  ok(!bad.ok && Boolean(bad.error), '50) 接口不通时返回错误');
  const after = world.snapshot() as { error: string | null };
  ok(after.error === null, '51) 手点失败不污染 lastError（不然状态灯会一直红着）');

  globalThis.fetch = realFetch;
  await world.stop();
}

/* 11) 睡着时状态灯是 loading，不是「在跑」也不是「出错」 */
{
  const { world } = makeWorld({ enabled: true, apiKey: 'k', provider: 'custom', baseUrl: 'http://x/v1', model: 'm' });
  await world.start(host() as never);
  const dir = (world as unknown as { coreDir(): string | null }).coreDir();
  ok(Boolean(dir), '52) 记忆核心目录能自动定位（同级或内部都试）');

  const mkdirSync = (await import('node:fs')).mkdirSync;
  const writeFileSync = (await import('node:fs')).writeFileSync;
  mkdirSync(String(dir), { recursive: true });
  writeFileSync(join(String(dir), 'state.json'), JSON.stringify({
    sleeping: true, energy: 12, mood: 50, activity: '睡觉', location: '房间', lastTalkAt: new Date().toISOString(),
  }), 'utf8');

  const lamp = (world.webUi().lamps ?? [])[0];
  ok(lamp?.state === 'loading', '53) 睡着 → 灯是 loading（不是在跑，也不是出错）');
  ok(String(lamp?.hint ?? '').includes('睡着'), '54) 提示里说清楚她睡着了');
  await world.stop();
}

/* 12) 她自己挑方式 / 叫停 / 状态落库 */
{
  const m = parseThought('{"thought":"把两件事连起来看","importance":6,"mode":"synthesize"}');
  ok(m.mode === 'synthesize', '55) 她挑的 mode 能被认出来');

  const badMode = parseThought('{"thought":"随便","importance":6,"mode":"发呆"}');
  ok(badMode.mode === undefined, '56) 乱写的 mode 被忽略，回到插件建议');

  const rest = parseThought('{"thought":"先搁着","importance":5,"rest":true,"next":{"in":900}}');
  ok(rest.rest === true && rest.next?.in === 900, '57) 说 rest 时允许拉到 900 分钟');

  const noRest = parseThought('{"thought":"还没想完","importance":5,"next":{"in":900}}');
  ok(noRest.next?.in === 360, '58) 没说 rest 时 900 被压回 360');

  ok(noteTtlMs({}) === 12 * 3_600_000, '59) 没留间隔时便签存 12 小时');
  ok(noteTtlMs({ nextIn: 1440 }) >= 24 * 3_600_000, '59b) 留了一天就至少存一天');
  ok(noteTtlMs({ nextIn: 99999 }) === 36 * 3_600_000, '59c) 但最多 36 小时，不会翻出半年前的便签');
}

/* 13) 一次真的叫停：默认歇 8 小时，状态一起落库 */
{
  const { world, root } = makeWorld(
    { enabled: true, dailyLimit: 20 },
    { mood: 71, energy: 63, sleeping: false, activity: '在窗边翻书' },
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"thought":"今天到此为止","importance":4,"mode":"plan","rest":true}' } }],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    }),
  })) as never;

  await world.start(host() as never);
  const internals = world as unknown as { budget: { nextDueAt?: string }; tick(): Promise<void>; siteData(): Record<string, unknown> };
  internals.budget.nextDueAt = new Date(Date.now() - 1000).toISOString();
  await internals.tick();
  globalThis.fetch = realFetch;

  const gap = (Date.parse(String(internals.budget.nextDueAt)) - Date.now()) / 60_000;
  ok(gap > 470 && gap < 490, `60) 她说先搁着、没给时间 → 默认歇 8 小时（实际 ${Math.round(gap)}）`);

  const line = JSON.parse(readFileSync(join(root, 'self-awareness', 'thoughts.jsonl'), 'utf8').trim());
  ok(line.rest === true, '61) rest 写进了 thoughts.jsonl');
  ok(line.mode === 'plan', '62) 她挑的 mode 覆盖插件建议');
  ok(line.energy === 63 && line.mood === 71, '63) 当时的精力和心情一起存下来');
  ok(typeof line.phase === 'string' && line.phase.length > 0, '64) 时段也存下来');

  const data = internals.siteData() as { resting: unknown; thoughts: { energy: number | null; phase: string | null }[] };
  ok(Boolean(data.resting) && data.thoughts[0]?.energy === 63, '65) 时间线数据带 resting 与状态');
  ok(Boolean(data.thoughts[0]?.phase), '66) 时间线能回看当时是哪个时段');

  await world.stop();
}

/* 14) 跨夜接续：只接留过话的、最多两跳 */
{
  const { world, root } = makeWorld({ enabled: true });
  const dir = join(root, 'self-awareness');
  mkdirSync(dir, { recursive: true });
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const seed = (h: number, extra: Record<string, unknown> = {}) => ({
    id: `x${h}`, ts: hoursAgo(h), mode: 'wonder', text: '昨晚想到一半的事', importance: 5, seeds: [], ...extra,
  });
  const write = (list: unknown[]) => {
    writeFileSync(join(dir, 'thoughts.jsonl'), list.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    // 池子第一次读过就常驻缓存，直接改文件得让它重读
    (world as unknown as { pool: { cache: unknown } }).pool.cache = null;
  };
  const nm = (world as unknown as {
    nextMode(rand: () => number): { carry?: string; carryAgeMin?: number; carryDepth?: number };
  }).nextMode.bind(world);

  write([seed(8, { nextNote: '明早再看' })]);
  const a = nm(() => 0);
  ok(Boolean(a.carry) && (a.carryAgeMin ?? 0) > 470, `67) 隔夜但留过话，可以接着想（${a.carryAgeMin} 分钟前）`);

  write([seed(8)]);
  ok(!nm(() => 0).carry, '68) 隔夜且没留话，当成想完了');

  write([seed(1, { nextNote: '还在想', carryDepth: 2 })]);
  ok(!nm(() => 0).carry, '69) 已经接了两跳，强制换题');

  write([seed(26, { nextNote: '明早再看' })]);
  ok(!nm(() => 0).carry, '70) 超过 20 小时不再翻出来');

  write([seed(1)]);
  ok(Boolean(nm(() => 0).carry), '71) 两小时内仍然可以接着想');

  const msgs = buildMessages('reflect', {
    now: '11-17 08:00（上午）', silence: '', memories: [], recent: [],
    focus: '那件事', carry: true, carryAgo: '8 小时',
  });
  const user = msgs[1]?.content ?? '';
  ok(user.includes('你上次写到') && user.includes('8 小时前'), '72) 跨夜接续说「写到」并带上隔了多久');
  ok(!user.includes('你想到「'), '73) 不说「你想过」，避免冒充回忆');
}

console.log(bad ? `\n${bad} 项失败（共 ${total}）` : `\n全部通过（共 ${total} 项）`);
if (bad) process.exitCode = 1;
