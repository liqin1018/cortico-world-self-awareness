/**
 * 自我意识：她自己的内在时间线。
 *
 * 三条硬约束（改代码时别破坏）：
 *  1) 绝不 pushEvent —— 这个插件永远不产生消息，只写本地文件；
 *  2) 没配模型、没开开关就完全不动，连定时器都不该有事干；
 *  3) 每一次思考都要记 token，超预算就停到明天 —— 花的是用户自己的钱。
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { formatLocal } from './time.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import {
  resolveEndpoint,
  SELF_AWARENESS_CONFIG_GROUP,
  SELF_AWARENESS_DEFAULTS,
  type SelfAwarenessConfig,
} from './config.ts';
import {
  ThoughtPool,
  THOUGHT_MODES,
  REFLECT_THRESHOLD,
  density,
  loadBudget,
  nextGapMinutes,
  noteTtlMs,
  CARRY_FRESH_MIN,
  CARRY_MAX_AGE_MIN,
  CARRY_MAX_DEPTH,
  REST_DEFAULT_MINUTES,
  rollDay,
  saveBudget,
  type BudgetState,
  type Thought,
  type ThoughtMode,
} from './pool.ts';
import { buildReflectMessages, callModel, thinkOnce, type ThinkContext } from './think.ts';
import { ThoughtSite } from './site.ts';
import { clip, dayKey, humanSpan, moodWord, timeOfDay } from './time.ts';
import { appendUrge } from './urge.ts';

const TICK_MS = 60_000;
/** 连续失败后别每 60 秒撞一次墙。 */
const FAIL_COOLDOWN_MS = 15 * 60_000;
const FAIL_HARD_MS = 45 * 60_000;
/** 刚装好/刚重启时先等一会儿，别一打开就花一次钱。 */
const FIRST_DELAY_MS = 3 * 60_000;
/** 同一张卡两周内不再拿来当引子。 */
const SEED_REUSE_MS = 14 * 86_400_000;
/** 挑素材时的类型偏好：独处想的是「人」，不是「任务」。 */
const KIND_BIAS: Record<string, number> = {
  self: 1.5,
  episode: 1.25,
  promise: 1.1,
  note: 0.95,
  fact: 0.65,
};

interface MemoryCoreState {
  energy?: number;
  mood?: number;
  sleeping?: boolean;
  activity?: string;
  location?: string;
  lastUserAt?: string;
}

/** 一条素材：卡片（你记下的）或原文（他说过的）。 */
interface Seed {
  /** c:卡片前8位 / r:cursor */
  ref: string;
  text: string;
  from: 'card' | 'raw';
}

interface CardLite {
  id: string;
  kind: string;
  text: string;
  weight?: number;
  createdAt?: string;
  coldAt?: string;
  status?: string;
}

export class SelfAwarenessWorld implements World {
  /** 必须和 definition 的 id 一致：宿主会比对，不一致就直接判「加载失败」。 */
  readonly id = 'self-awareness';
  private readonly ctx: WorldContext<SelfAwarenessConfig>;
  private readonly dataDir: string;
  private readonly pool: ThoughtPool;
  private readonly site: ThoughtSite;
  private budget: BudgetState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private host: WorldHost | null = null;
  private stopped = false;
  private ticking = false;
  private fails = 0;
  private lastError = '';
  private modeCursor = 0;
  private lastActivityProbe = 0;
  private lastActivityAt = 0;
  private lastSnapshot: { ts: string; text: string; mode: ThoughtMode } | null = null;

  constructor(ctx: WorldContext<SelfAwarenessConfig>) {
    this.ctx = ctx;
    const base = typeof ctx.dataDir === 'string' && ctx.dataDir ? ctx.dataDir : '.';
    this.dataDir = join(base, 'self-awareness');
    this.pool = new ThoughtPool(this.dataDir);
    this.site = new ThoughtSite({
      data: () => this.siteData(),
      probe: () => this.probe(),
    });
    this.budget = loadBudget(this.dataDir);
    const last = this.pool.all().slice(-1)[0];
    if (last) this.lastSnapshot = { ts: last.ts, text: last.text, mode: last.mode };
  }

  /** 不往提示词里塞任何东西——想什么都只在本地文件里。 */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  /** 一个工具都不给。给了主模型就会去调，一调就不「静默」了。 */
  tools(): ToolDef[] {
    return [];
  }

  /**
   * 配置组必须从这里交出去——宿主读的是 `instance.webUi().config`，
   * 不写在 definition 里。没这个方法，设置页就是空的。
   */
  webUi(): WorldWebUiDecl {
    const cfg = this.cfg();
    const endpoint = resolveEndpoint(cfg);
    const next = this.budget.nextDueAt ? formatLocal(this.budget.nextDueAt, this.tz()).slice(11, 16) : '未安排';
    const core = this.readCoreState();
    // 睡着不是错误，但也别显示成「在跑」——不然分不清她是睡了还是挂了
    const dozing = Boolean(cfg.sleepSilent && core?.sleeping);
    const bad = this.lastError ?? this.startupNote;
    const state: 'online' | 'loading' | 'error' | 'offline' = bad
      ? 'error'
      : dozing
        ? 'loading'
        : cfg.enabled && endpoint.model
          ? 'online'
          : 'offline';
    const hint = bad
      ? clip(bad, 40)
      : !cfg.enabled
        ? '已关闭'
        : !endpoint.model
          ? '还没配模型'
          : dozing
            ? `睡着了（精力 ${Math.round(Number(core?.energy) || 0)}），醒了接着想`
            : `今天想过 ${this.budget.count} 次`;
    return {
      label: '自我意识',
      lamps: [{ label: '自我意识', state, hint }],
      badges: [
        { label: '今天想过', value: `${this.budget.count} 次` },
        { label: '下次', value: next },
        { label: '想法', value: this.pool.all().length },
      ],
      ...(this.site.origin
        ? { links: [{ label: '看她的时间线', href: this.site.origin, inheritTheme: false }] }
        : {}),
      config: [SELF_AWARENESS_CONFIG_GROUP],
    };
  }

  private cfg(): SelfAwarenessConfig {
    return { ...SELF_AWARENESS_DEFAULTS, ...((this.ctx.cfg ?? {}) as SelfAwarenessConfig) };
  }

  private tz(): string {
    return this.ctx.timezone || 'Asia/Shanghai';
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    const cfg = this.cfg();
    try {
      host.log?.info?.('[self-awareness] 启动', {
        dataDir: this.dataDir,
        thoughts: this.pool.all().length,
        enabled: cfg.enabled,
        model: resolveEndpoint(cfg).model || '(未配)',
      });
    } catch {
      // 日志失败不影响挂载
    }
    if (cfg.probeOnStart) {
      // 不 await：启动不该为了一个 ping 卡住
      void this.probe().then((r) => {
        this.startupNote = r.ok ? null : `启动自检失败：${r.error}`;
        if (!r.ok) {
          try {
            host.log?.warn?.(`[self-awareness] 启动自检失败：${r.error}`);
          } catch {
            // ignore
          }
        }
      }).catch(() => {
        this.startupNote = null;
      });
    }
    if (cfg.siteEnabled) {
      const origin = await this.site.start(cfg.sitePort).catch(() => null);
      if (origin) {
        try {
          host.log?.info?.(`[self-awareness] 时间线页面 ${origin}`);
        } catch {
          // ignore
        }
      }
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    saveBudget(this.dataDir, this.budget);
    await this.site.stop();
    this.host = null;
  }

  // ---- 主循环 ----

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.tickInner();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      try {
        this.host?.log?.warn?.('[self-awareness] tick 出错', this.lastError);
      } catch {
        // ignore
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<void> {
    const cfg = this.cfg();
    if (!cfg.enabled) return;

    const now = Date.now();
    // 跨天清零：次数和预算都是按自然日算的
    if (rollDay(this.budget, dayKey(now, this.tz()))) saveBudget(this.dataDir, this.budget);

    const endpoint = resolveEndpoint(cfg);
    if (!endpoint.baseUrl || !endpoint.model) {
      this.lastError = '还没配模型（接口地址和模型都空着）';
      return;
    }
    if (endpoint.needsKey && !String(cfg.apiKey ?? '').trim()) {
      this.lastError = '还没填密钥';
      return;
    }

    // 预算闸门：先看钱，再看节奏
    const limit = Math.max(0, Number(cfg.dailyLimit) || 0);
    if (limit > 0 && this.budget.count >= limit) return;
    const tokenBudget = Math.max(0, Number(cfg.dailyTokenBudget) || 0);
    if (tokenBudget > 0 && this.budget.tokens >= tokenBudget) return;

    // 睡着就不想。读记忆核心的状态，读不到就当醒着。
    const core = this.readCoreState();
    if (cfg.sleepSilent && core?.sleeping) return;

    // 第一次跑先等几分钟：刚装好的人需要时间去填模型和密钥，不该一启动就产生费用
    if (!this.budget.nextDueAt) {
      this.budget.nextDueAt = new Date(now + FIRST_DELAY_MS).toISOString();
      saveBudget(this.dataDir, this.budget);
      return;
    }

    // 对方安静下来了：把「想说话」写出去，交给记忆核心决定要不要开口。
    // 放在 due 之前——就算下一次思考还有三小时，这份冲动也该现在写。
    this.maybeUrge(now);

    // 节奏：上一次定的时间没到就什么都不做（这是唯一等时间的地方）
    const due = this.budget.nextDueAt ? Date.parse(this.budget.nextDueAt) : 0;
    if (Number.isFinite(due) && due > now) return;

    // 消息抢占：他刚说完话就先别想，人在聊天时该在听，不是走神。
    const quietMin = Math.max(0, Number(cfg.quietAfterUserMin) || 0);
    if (quietMin > 0) {
      const last = this.probeLastActivity(now);
      if (last > 0 && now - last < quietMin * 60_000) {
        const wait = quietMin * 60_000 - (now - last);
        this.budget.nextDueAt = new Date(now + wait).toISOString();
        saveBudget(this.dataDir, this.budget);
        return;
      }
    }

    const { mode, carry, carryAgeMin, carryDepth } = this.nextMode();
    const seeds = this.pickSeeds(mode, now);
    const note = this.latestNote(now);
    const loops = this.openLoops(now);
    const ctx = this.buildContext(
      core,
      now,
      seeds,
      carry,
      note?.text,
      carryAgeMin ? humanSpan(carryAgeMin * 60_000) : undefined,
      loops,
    );

    const started = Date.now();
    const res = await thinkOnce(
      mode,
      ctx,
      {
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        apiKey: String(cfg.apiKey ?? '').trim(),
        // 保底 600：推理模型的 reasoning 也算在 max_tokens 里，给 220 会把正文挤没
        maxTokens: Math.max(600, Number(cfg.maxOutputTokens) || 220),
        temperature: Number(cfg.temperature) || 0.95,
      },
      seeds.map((c) => c.ref),
    );

    if (!res.ok || !res.thought) {
      this.fails += 1;
      this.lastError = res.reason ?? '调用失败';
      const wait = this.fails >= 3 ? FAIL_HARD_MS : FAIL_COOLDOWN_MS;
      this.budget.nextDueAt = new Date(Date.now() + wait).toISOString();
      saveBudget(this.dataDir, this.budget);
      return;
    }

    this.fails = 0;
    this.lastError = '';
    // 她自己挑了哪条旧线，就接那条；没挑才按建议
    const picked = res.pickedLoop ? loops[res.pickedLoop - 1] : undefined;
    const carried = Boolean(picked) || (Boolean(carry) && res.thought.mode === mode);
    const carryGap = picked ? picked.ageMin : carryAgeMin;
    const carryDeep = picked ? picked.depth + 1 : carryDepth;
    const thought = this.pool.add({
      ...res.thought,
      carry: carried,
      ...(carried && carryGap ? { carryGapMin: carryGap } : {}),
      ...(carried && carryDeep ? { carryDepth: carryDeep } : {}),
      // 把「她当时是什么样子」一起存下来：时间线以后能回看，不只是知道她想了什么
      ...(typeof core?.mood === 'number' ? { mood: Math.round(core.mood) } : {}),
      ...(typeof core?.energy === 'number' ? { energy: Math.round(core.energy) } : {}),
      phase: timeOfDay(now, this.tz()),
    });
    this.lastSnapshot = { ts: thought.ts, text: thought.text, mode: thought.mode };

    this.budget.count += 1;
    this.budget.tokens += (res.promptTokens ?? 0) + (res.outputTokens ?? 0);
    this.budget.pendingImportance += thought.importance;
    this.budget.lastThoughtAt = thought.ts;

    // 下次隔多久：她说「先搁着」就按她的长间隔，其余听她自己定的，没定才按密度算
    const herNext = Number(res.thought.nextIn);
    const gap = Number.isFinite(herNext) && herNext > 0
      ? herNext
      : thought.rest
        ? REST_DEFAULT_MINUTES
        : nextGapMinutes(density(thought), Number(cfg.minGapMin) || 25, Number(cfg.maxGapMin) || 90);
    if (note) this.budget.lastNoteId = note.id;
    this.budget.nextDueAt = new Date(Date.now() + Math.round(gap * 60_000)).toISOString();
    saveBudget(this.dataDir, this.budget);

    // 想得够多了，往上抽象一层
    if (this.budget.pendingImportance >= REFLECT_THRESHOLD) {
      await this.reflect(endpoint, cfg);
    }

    try {
      this.host?.log?.info?.('[self-awareness] 想了', {
        mode: thought.mode,
        importance: thought.importance,
        gapMin: Math.round(gap),
        byHer: Number.isFinite(herNext) && herNext > 0,
        rest: Boolean(thought.rest),
        ms: Date.now() - started,
      });
    } catch {
      // ignore
    }
  }

  /** 反思：把最近的碎想法收成一句自我认知。 */
  private async reflect(
    endpoint: { baseUrl: string; model: string },
    cfg: SelfAwarenessConfig,
  ): Promise<void> {
    const recent = this.pool.recent(6).map((t) => clip(t.text, 90));
    if (recent.length < 3) return;

    const last = this.pool.reflections().slice(-1)[0];
    const res = await callModel(
      {
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        apiKey: String(cfg.apiKey ?? '').trim(),
        // 推理模型会先花几百 token 想，120 不够——实测会被 reasoning 吃干，正文为空
        maxTokens: 600,
        temperature: 0.7,
      },
      buildReflectMessages(recent, last?.text),
    );
    // 失败别清零：攒了这么久的重要度，一次网络抖动不该白扔
    if (!res.ok || !res.text) {
      this.lastError = `反思失败：${res.reason ?? '空返回'}`;
      return;
    }

    const line = clip(res.text.replace(/^["「]|["」]$/g, ''), 120);
    // 模型自己说「没有」就别硬记，这时候才算这笔账结清
    if (!line || /^没有[。.]?$/.test(line)) {
      this.budget.pendingImportance = 0;
      this.budget.tokens += (res.promptTokens ?? 0) + (res.outputTokens ?? 0);
      saveBudget(this.dataDir, this.budget);
      return;
    }
    this.pool.addReflection(line, recent.length);
    this.budget.pendingImportance = 0;
    this.budget.tokens += (res.promptTokens ?? 0) + (res.outputTokens ?? 0);
    saveBudget(this.dataDir, this.budget);
    try {
      this.host?.log?.info?.('[self-awareness] 反思', { from: recent.length, text: clip(line, 40) });
    } catch {
      // ignore
    }
  }

  // ---- 素材 ----

  /**
   * 最近一次外部消息的时间（任何来源：私聊、群聊都算）。
   * 30 秒缓存一次，别每个 tick 都去翻事件表。
   */
  /**
   * 对方刚安静下来时，把「想说话」写成一条冲动。
   *
   * 只在 4–45 分钟的沉默窗口里写，每段沉默只写一条；取自最近 3 小时内、
   * 重要度 6 以上的想法。不调模型、不花钱——只是把已有的东西挪个地方。
   * 她说了「先搁着」的那段时间里不写：那是她自己要的安静。
   */
  private maybeUrge(now: number): void {
    const cfg = this.cfg();
    if (cfg.urgeEnabled === false) return;
    const last = this.probeLastActivity(now);
    if (!last) return;
    const quietMin = (now - last) / 60_000;
    if (quietMin < 4 || quietMin > 45) return;
    const key = new Date(last).toISOString();
    if (this.budget.lastUrgeAt === key) return;

    const lastThought = this.pool.recent(1)[0];
    if (lastThought?.rest) {
      const restAge = now - (Date.parse(lastThought.ts) || 0);
      if (restAge >= 0 && restAge < 12 * 3_600_000) return;
    }

    const source = this.pool.recent(8).reverse().find((t) => {
      const age = now - (Date.parse(t.ts) || 0);
      return age >= 0 && age <= 3 * 3_600_000 && Number(t.importance) >= 6;
    });
    if (!source) return;

    appendUrge(this.dataDir, {
      id: randomUUID().slice(0, 8),
      ts: new Date(now).toISOString(),
      type: 'silence',
      text: clip(source.text, 120),
      importance: source.importance,
      sourceId: source.id,
      quietMin: Math.round(quietMin),
    });
    this.budget.lastUrgeAt = key;
    saveBudget(this.dataDir, this.budget);
  }

  private probeLastActivity(now: number): number {
    if (now - this.lastActivityProbe < 30_000) return this.lastActivityAt;
    this.lastActivityProbe = now;
    try {
      const events = (this.host?.store?.range({ origin: 'external', limit: 40 }) ?? []) as { ts?: string }[];
      let best = 0;
      for (const e of events) {
        const t = Date.parse(String(e.ts ?? ''));
        if (Number.isFinite(t) && t > best && t <= now + 60_000) best = t;
      }
      this.lastActivityAt = best;
    } catch {
      this.lastActivityAt = 0;
    }
    return this.lastActivityAt;
  }

  /**
   * 她上一条给自己留的话。超过 12 小时就不提了——她说「明早看看」，
   * 现在都第二天晚上了，再提就是翻旧账。用过的记在 budget.lastNoteId，不重复递。
   */
  private latestNote(now: number): { id: string; text: string } | null {
    const recent = this.pool.recent(12).reverse();
    for (const t of recent) {
      if (!t.nextNote) continue;
      if (t.id === this.budget.lastNoteId) continue;
      const at = Date.parse(t.ts) || 0;
      // 便签能存多久，跟着她自己定的间隔走（以前硬 12 小时，"明早再看"会直接丢）
      if (!at || now - at > noteTtlMs(t)) continue;
      return { id: t.id, text: t.nextNote };
    }
    return null;
  }

  /** 记忆核心的 state.json。没装记忆核心就返回 null，不报错。 */
  private readCoreState(): MemoryCoreState | null {
    const dir = this.coreDir();
    if (!dir) return null;
    const file = join(dir, 'state.json');
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as MemoryCoreState;
    } catch {
      return null;
    }
  }

  private coreDir(): string | null {
    const cfg = this.cfg();
    const explicit = String(cfg.memoryCoreDir ?? '').trim();
    if (explicit) return existsSync(explicit) ? explicit : null;
    const base = typeof this.ctx.dataDir === 'string' ? this.ctx.dataDir : '';
    if (!base) return null;
    // 宿主给的 dataDir 是 <botData>/self-awareness，记忆核心在 **同级** 的 memory-core。
    // 但测试和手工跑时常常直接传 <botData>，所以两条都试——只认一条会静默读不到卡片。
    for (const guess of [join(base, '..', 'memory-core'), join(base, 'memory-core')]) {
      if (existsSync(guess)) return guess;
    }
    return null;
  }

  private cards(): CardLite[] {
    const dir = this.coreDir();
    if (!dir) return [];
    const file = join(dir, 'cards.jsonl');
    if (!existsSync(file)) return [];
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: CardLite[] = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const c = JSON.parse(s) as CardLite;
        if (c.status === 'retired') continue;
        if (!c.text) continue;
        out.push(c);
      } catch {
        // 坏行跳过
      }
    }
    return out;
  }

  /** 挑几张卡当这次的引子：排除两周内用过的，偏向最近的和权重高的。 */
  /**
   * 挑这次要拿什么当引子。
   *
   * 卡片是结论（干），原文是现场（湿）。只吃卡片的话，三五条之后就绕着小黑盒转，
   * 因为库里大半是「谁让我做什么」。所以两种混着挑：一条原话 + 一张卡。
   */
  private pickSeeds(mode: ThoughtMode, now: number): Seed[] {
    // plan 模式是「往后想」，不需要旧素材
    const want = mode === 'plan' ? 0 : mode === 'reflect' || mode === 'doubt' ? 1 : 2;
    if (!want) return [];

    const used = this.pool.seedsUsedSince(now - SEED_REUSE_MS);
    const rank = <T extends { score: number }>(list: T[]) => list.sort((a, b) => b.score - a.score);

    const cards = this.cards()
      .filter((c) => !used.has(`c:${c.id.slice(0, 8)}`))
      .map((c) => {
        const age = now - (Date.parse(c.createdAt ?? '') || now);
        const fresh = Math.max(0, 1 - age / (30 * 86_400_000));
        // 卡片里大头是「谁让我做什么」这类指令，拿它当发呆素材只会想出工作汇报。
        // 偏向关于人的：自己/关系、经历、承诺；事实类降权。
        const bias = KIND_BIAS[c.kind] ?? 0.7;
        return {
          ref: `c:${c.id.slice(0, 8)}`,
          text: c.text,
          from: 'card' as const,
          score: ((Number(c.weight) || 0.5) * 0.5 + fresh * 0.5) * bias + Math.random() * 0.3,
        };
      });
    const raws = this.rawSeeds(now)
      .filter((r) => !used.has(r.ref))
      .map((r) => ({ ...r, score: 1 + Math.random() * 0.3 }));

    const picked: Seed[] = [];
    // 两条以上时，先保证有一条原话——原文比结论更有画面
    if (want >= 2 && raws.length) {
      const top = rank(raws)[0];
      picked.push({ ref: top.ref, text: top.text, from: 'raw' });
    }
    for (const c of rank(cards)) {
      if (picked.length >= want) break;
      picked.push({ ref: c.ref, text: c.text, from: 'card' });
    }
    // 卡片不够就用原文补
    for (const r of rank(raws)) {
      if (picked.length >= want) break;
      if (picked.some((p) => p.ref === r.ref)) continue;
      picked.push({ ref: r.ref, text: r.text, from: 'raw' });
    }
    return picked;
  }

  /** 从原文库里挑几句「像人说的话」：不要界面回执，不要长文，不要没标点的碎片。 */
  private rawSeeds(now: number): Seed[] {
    const dir = this.coreDir();
    if (!dir) return [];
    const file = join(dir, 'turns.jsonl');
    if (!existsSync(file)) return [];
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter(Boolean).slice(-140);
    const junk = /^(选了|点了|返回|打开|关闭|确认|取消|好的|嗯|哦|在吗)/;
    const out: Seed[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < 14; i -= 1) {
      let e: { cursor?: number; ts?: string; text?: string };
      try {
        e = JSON.parse(lines[i]) as typeof e;
      } catch {
        continue;
      }
      const text = String(e.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 12 || text.length > 70) continue;
      if (!/[，。？！…]/.test(text)) continue;
      if (junk.test(text)) continue;
      const at = Date.parse(String(e.ts ?? ''));
      if (Number.isFinite(at) && now - at > 14 * 86_400_000) continue;
      out.push({ ref: `r:${e.cursor ?? i}`, text, from: 'raw' });
    }
    return out;
  }

  private buildContext(
    core: MemoryCoreState | null,
    now: number,
    seeds: Seed[],
    carry?: string,
    lastNote?: string,
    carryAgo?: string,
    loops?: { id: string; text: string; ageMin: number; depth: number }[],
  ): ThinkContext {
    const tz = this.tz();
    // 「11-15 23:30（深夜）」——只说时间她不知道那是深夜，会想出「下午出去走走」
    const bits: string[] = [`${formatLocal(now, tz).slice(5, 16)}（${timeOfDay(now, tz)}）`];
    if (core?.activity) bits.push(`你在${core.activity}`);
    else bits.push('你一个人待着');
    if (core?.location) bits.push(`在${core.location}`);
    if (typeof core?.energy === 'number') bits.push(`精力 ${Math.round(core.energy)}`);
    if (typeof core?.mood === 'number') bits.push(`心情${moodWord(core.mood)}`);

    const lastUser = core?.lastUserAt ? Date.parse(core.lastUserAt) : 0;
    const silence = Number.isFinite(lastUser) && lastUser > 0 ? humanSpan(now - lastUser) : '';

    const memories = seeds.map((c) => clip(c.text, 70));
    // 没有引子的时候，给几条背景，别让她对着空气想
    if (!memories.length) {
      const recent = this.cards()
        .sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0))
        .slice(0, 3);
      for (const c of recent) memories.push(clip(c.text, 60));
    }

    const reflections = this.pool.reflections();
    return {
      now: bits.join('，'),
      silence,
      memories,
      recent: this.pool.recent(3).map((t) => clip(t.text, 60)),
      lastNote,
      focus: carry ? clip(carry, 50) : seeds[0] ? clip(seeds[0].text, 50) : undefined,
      carry: Boolean(carry),
      carryAgo,
      loops: loops?.length
        ? loops.map((l) => ({ text: clip(l.text, 60), ago: humanSpan(l.ageMin * 60_000) }))
        : undefined,
      selfView: reflections.length ? clip(reflections.slice(-1)[0].text, 80) : undefined,
      persona: String(this.cfg().personaNote ?? '').trim() || undefined,
    };
  }

  /**
   * 手上还挂着的事：最近 12 条里留过话、还没过期的，最多三条。
   * 这些不是「待办」，是她自己说过「还想接着想」的线。
   */
  private openLoops(now: number): { id: string; text: string; ageMin: number; depth: number }[] {
    const out: { id: string; text: string; ageMin: number; depth: number }[] = [];
    for (const t of this.pool.all().slice(-12).reverse()) {
      if (!t.nextNote) continue;
      const at = Date.parse(t.ts) || 0;
      if (!at || now - at > noteTtlMs(t)) continue;
      out.push({
        id: t.id,
        text: t.text,
        ageMin: Math.max(1, Math.round((now - at) / 60_000)),
        depth: Number(t.carryDepth) || 0,
      });
      if (out.length >= 3) break;
    }
    return out;
  }

  /**
   * 模式轮换：七成按顺序，三成随机跳，免得形成「每个模式轮流打卡」的机械感。
   *
   * 接着上一条想：两小时内跟以前一样（想到一半就该接）；
   * 隔夜的接续要严一点——必须是她自己留了话或说要歇着，才说明这件事还没完，
   * 而且同一条线最多接两跳，第三跳强制换题（不然会反刍）。
   */
  private nextMode(rand: () => number = Math.random): {
    mode: ThoughtMode;
    carry?: string;
    carryAgeMin?: number;
    carryDepth?: number;
  } {
    const last = this.pool.recent(1)[0];
    const ageMin = last ? (Date.now() - (Date.parse(last.ts) || 0)) / 60_000 : Infinity;
    const depth = Number(last?.carryDepth) || 0;
    const leftOpen = Boolean(last && (last.nextNote || last.rest));
    const canCarry =
      Boolean(last)
      && depth < CARRY_MAX_DEPTH
      && (ageMin <= CARRY_FRESH_MIN || (ageMin <= CARRY_MAX_AGE_MIN && leftOpen));

    if (canCarry && rand() < (ageMin <= CARRY_FRESH_MIN ? 0.3 : 0.55)) {
      return {
        mode: 'reflect',
        carry: last!.text,
        carryAgeMin: Math.max(1, Math.round(ageMin)),
        carryDepth: depth + 1,
      };
    }
    if (rand() < 0.3) {
      return { mode: THOUGHT_MODES[Math.floor(rand() * THOUGHT_MODES.length)] };
    }
    const m = THOUGHT_MODES[this.modeCursor % THOUGHT_MODES.length];
    this.modeCursor += 1;
    return { mode: m };
  }

  // ---- 给状态页看 ----

  /**
   * 手测一次接口通不通。
   *
   * 只发一句「在吗」拿一个回复——**不写任何文件、不占次数、不动 lastError**。
   * 手点测试失败是查询行为，不该让状态灯一直红着。
   */
  async probe(): Promise<{ ok: boolean; ms: number; model?: string; error?: string }> {
    const cfg = this.cfg();
    const endpoint = resolveEndpoint(cfg);
    if (!endpoint.model) return { ok: false, ms: 0, error: '还没选模型' };
    if (endpoint.needsKey && !String(cfg.apiKey ?? '').trim()) return { ok: false, ms: 0, error: '还没填密钥' };
    const started = Date.now();
    const res = await callModel(
      {
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        apiKey: String(cfg.apiKey ?? '').trim(),
        maxTokens: 400,
        temperature: 0,
      },
      [
        { role: 'system', content: '只回一个字：好' },
        { role: 'user', content: '在吗' },
      ],
    );
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, error: res.reason ?? '未知错误' };
    return { ok: true, ms, model: endpoint.model };
  }

  /** 时间线页面要的数据：倒序、只给最近 60 条。 */
  private siteData(): Record<string, unknown> {
    const cfg = this.cfg();
    const endpoint = resolveEndpoint(cfg);
    return {
      enabled: Boolean(cfg.enabled),
      model: endpoint.model || null,
      today: { count: this.budget.count, tokens: this.budget.tokens },
      limit: { count: Number(cfg.dailyLimit) || 0, tokens: Number(cfg.dailyTokenBudget) || 0 },
      nextDueAt: this.budget.nextDueAt ?? null,
      // 她说「先搁着」的话，页面就别再写「等下一次思考」了——她是在歇，不是卡住了
      resting: (() => {
        const last = this.pool.recent(1)[0];
        return last?.rest ? { at: last.ts, until: this.budget.nextDueAt ?? null } : null;
      })(),
      // 给页面用的「当前那张便签」：过期的不算，免得侧栏挂着三天前的话
      note: (() => {
        // 便签有效期现在能到 36 小时，往回多看几条，别因为条数少就漏了它
        for (const t of this.pool.recent(12).reverse()) {
          if (!t.nextNote) continue;
          const at = Date.parse(t.ts) || 0;
          if (!at || Date.now() - at > noteTtlMs(t)) continue;
          return { text: t.nextNote, in: t.nextIn ?? null, at: t.ts, mode: t.mode };
        }
        return null;
      })(),
      totalThoughts: this.pool.all().length,
      thoughts: this.pool
        .all()
        .slice(-60)
        .reverse()
        .map((t) => ({
          id: t.id,
          ts: t.ts,
          mode: t.mode,
          text: t.text,
          importance: t.importance,
          carry: Boolean(t.carry),
          carryGapMin: typeof t.carryGapMin === 'number' ? t.carryGapMin : null,
          carryDepth: typeof t.carryDepth === 'number' ? t.carryDepth : null,
          nextNote: t.nextNote ?? null,
          nextIn: t.nextIn ?? null,
          rest: Boolean(t.rest),
          mood: typeof t.mood === 'number' ? t.mood : null,
          energy: typeof t.energy === 'number' ? t.energy : null,
          phase: t.phase ?? null,
          promptTokens: t.promptTokens ?? 0,
          outputTokens: t.outputTokens ?? 0,
        })),
      reflections: this.pool
        .reflections()
        .slice(-5)
        .reverse()
        .map((r) => ({ ts: r.ts, text: r.text, fromCount: r.fromCount })),
      error: this.lastError || null,
    };
  }

  snapshot(): Record<string, unknown> {
    const cfg = this.cfg();
    const endpoint = resolveEndpoint(cfg);
    return {
      enabled: Boolean(cfg.enabled),
      model: endpoint.model || null,
      baseUrl: endpoint.baseUrl || null,
      hasKey: Boolean(String(cfg.apiKey ?? '').trim()),
      lastThought: this.lastSnapshot,
      totalThoughts: this.pool.all().length,
      reflections: this.pool.reflections().slice(-3),
      today: { count: this.budget.count, tokens: this.budget.tokens },
      limit: { count: Number(cfg.dailyLimit) || 0, tokens: Number(cfg.dailyTokenBudget) || 0 },
      nextDueAt: this.budget.nextDueAt ?? null,
      error: this.lastError || null,
      thoughtFile: this.pool.file,
    };
  }
}
