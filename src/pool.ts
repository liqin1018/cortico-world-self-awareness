/**
 * 想法池：想法本身 + 「下次隔多久」这件事。
 *
 * 节奏是这里最要紧的一段。固定间隔就是闹钟；我们要的是：
 * 这次想得多、想得深 → 歇久点；这次敷衍了一句 → 过一会儿再想。
 * 间隔由内容算出来，不是钟表算出来。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ThoughtMode = 'reflect' | 'wonder' | 'plan' | 'doubt' | 'synthesize';

export const THOUGHT_MODES: ThoughtMode[] = ['reflect', 'wonder', 'plan', 'doubt', 'synthesize'];

export interface Thought {
  id: string;
  ts: string;
  mode: ThoughtMode;
  text: string;
  /** 1-10。高到一定程度会触发「反思」——往上抽象一层。 */
  importance: number;
  /** 这次是拿哪些卡当引子想出来的（卡片 id 前 8 位），用来防止反复嚼同一件事。 */
  seeds: string[];
  promptTokens?: number;
  outputTokens?: number;
  /** 这条是接着上一条想下去的，不是新起一件 */
  carry?: boolean;
  /** 接着想时，上一条是多久前写的（分钟）。隔着夜就是几百分钟。 */
  carryGapMin?: number;
  /** 同一条线已经接了几跳。到上限就强制换题，防止反茭。 */
  carryDepth?: number;
  /** 她自己定的下次间隔（分钟）。没写就按密度算。 */
  nextIn?: number;
  /** 她给自己留的话：「明早再看看那个帖子」。下次会原样递回去。 */
  nextNote?: string;
  /** 她说「先搁着」——不是按密度排的下一跳，是她自己叫停的。 */
  rest?: boolean;
  /** 写下这条时的状态，用来在时间线上回看「她当时是什么样子」。 */
  mood?: number;
  energy?: number;
  phase?: string;
}

export interface Reflection {
  id: string;
  ts: string;
  text: string;
  fromCount: number;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      // 坏行跳过：手改过文件也别让整个池子读不出来
    }
  }
  return out;
}

export class ThoughtPool {
  private readonly dir: string;
  private cache: Thought[] | null = null;

  constructor(dir: string) {
    this.dir = dir;
    ensureDir(dir);
  }

  get file(): string {
    return join(this.dir, 'thoughts.jsonl');
  }

  get reflectionFile(): string {
    return join(this.dir, 'reflections.jsonl');
  }

  all(): Thought[] {
    if (!this.cache) this.cache = readJsonl<Thought>(this.file);
    return this.cache;
  }

  recent(n: number): Thought[] {
    return this.all().slice(-Math.max(0, n));
  }

  add(t: Omit<Thought, 'id' | 'ts'> & { ts?: string }): Thought {
    const thought: Thought = {
      id: randomUUID().slice(0, 8),
      ts: t.ts ?? new Date().toISOString(),
      mode: t.mode,
      text: t.text,
      importance: clampImportance(t.importance),
      seeds: t.seeds ?? [],
      ...(t.promptTokens ? { promptTokens: t.promptTokens } : {}),
      ...(t.outputTokens ? { outputTokens: t.outputTokens } : {}),
      ...(t.carry ? { carry: true } : {}),
      ...(typeof t.carryGapMin === 'number' ? { carryGapMin: t.carryGapMin } : {}),
      ...(typeof t.carryDepth === 'number' ? { carryDepth: t.carryDepth } : {}),
      ...(t.nextIn ? { nextIn: t.nextIn } : {}),
      ...(t.nextNote ? { nextNote: t.nextNote } : {}),
      ...(t.rest ? { rest: true } : {}),
      ...(typeof t.mood === 'number' ? { mood: t.mood } : {}),
      ...(typeof t.energy === 'number' ? { energy: t.energy } : {}),
      ...(t.phase ? { phase: t.phase } : {}),
    };
    ensureDir(this.dir);
    // 先让 cache 落地再 append：否则 all() 会从文件里读回刚写的那条，push 之后就有了两份
    const list = this.all();
    appendFileSync(this.file, `${JSON.stringify(thought)}\n`, 'utf8');
    list.push(thought);
    return thought;
  }

  /**
   * 删一条。先留一份 .bak，再写临时文件替换——
   * 不能直接截断原文件，写到一半断电就全没了。
   * 返回被删的那条；没找到就是 null。
   */
  remove(id: string): Thought | null {
    const all = this.all();
    const hit = all.find((t) => t.id === id);
    if (!hit) return null;
    const next = all.filter((t) => t.id !== id);
    ensureDir(this.dir);
    try {
      copyFileSync(this.file, `${this.file}.bak`);
    } catch {
      return null; // 备份没成就不删
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, next.map((t) => JSON.stringify(t)).join('\n') + (next.length ? '\n' : ''), 'utf8');
    renameSync(tmp, this.file);
    this.cache = next;
    return hit;
  }

  reflections(): Reflection[] {
    return readJsonl<Reflection>(this.reflectionFile);
  }

  addReflection(text: string, fromCount: number): Reflection {
    const r: Reflection = {
      id: randomUUID().slice(0, 8),
      ts: new Date().toISOString(),
      text,
      fromCount,
    };
    ensureDir(this.dir);
    appendFileSync(this.reflectionFile, `${JSON.stringify(r)}\n`, 'utf8');
    return r;
  }

  /** 最近这些 seed 用过没有（防止两周内反复拿同一张卡当引子）。 */
  seedsUsedSince(cutoffMs: number): Set<string> {
    const used = new Set<string>();
    for (const t of this.all()) {
      if ((Date.parse(t.ts) || 0) < cutoffMs) continue;
      for (const s of t.seeds) used.add(s);
    }
    return used;
  }
}

export function clampImportance(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 4;
  return Math.max(1, Math.min(10, Math.round(v)));
}

/**
 * 这次想法有多「密」：0 是敷衍一句，1 是想了很深。
 * 三个因素：长度够不够、重要度、有没有真的抓住某个具体的东西。
 */
export function density(t: Pick<Thought, 'text' | 'importance' | 'seeds'>): number {
  const len = String(t.text ?? '').trim().length;
  // 40 字以下算稀薄，180 字以上算满
  const lenScore = Math.min(1, Math.max(0, (len - 20) / 160));
  const impScore = (clampImportance(t.importance) - 1) / 9;
  const seedScore = t.seeds.length ? Math.min(1, t.seeds.length / 2) : 0;
  return clamp01(lenScore * 0.45 + impScore * 0.4 + seedScore * 0.15);
}

/**
 * 下次隔多久。密度高往 max 靠，密度低往 min 靠，再加 ±12% 的抖动。
 * 抖动不是为了「随机」，是为了不让间隔看起来像一个公式。
 */
export function nextGapMinutes(
  densityValue: number,
  minMin: number,
  maxMin: number,
  rand: () => number = Math.random,
): number {
  const lo = Math.max(1, Math.min(minMin, maxMin));
  const hi = Math.max(lo + 1, Math.max(minMin, maxMin));
  const d = clamp01(densityValue);
  const base = lo + (hi - lo) * d;
  const jitter = base * (rand() * 0.24 - 0.12);
  return Math.max(lo * 0.8, Math.min(hi * 1.2, base + jitter));
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

/** 她自己说的「多久之后再想」的允许范围。上下都留边：说 1 分钟太密，说三天就断了。 */
export const NEXT_MIN_MINUTES = 15;
export const NEXT_MAX_MINUTES = 360;
/** 说「先搁着」时允许拉得更长：至少两小时，最多一天。 */
export const REST_MIN_MINUTES = 120;
export const REST_MAX_MINUTES = 1440;
/** 她说了 rest 却没给间隔时的默认值：睡一觉再说。 */
export const REST_DEFAULT_MINUTES = 480;

/** 把模型给的值收进合法范围；不是数字就当没写。 */
export function clampNextIn(value: unknown, max = NEXT_MAX_MINUTES): number | undefined {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return Math.round(Math.max(NEXT_MIN_MINUTES, Math.min(max, v)));
}

/** 「先搁着」用的间隔：范围比平时宽。 */
export function clampRestIn(value: unknown): number | undefined {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return Math.round(Math.max(REST_MIN_MINUTES, Math.min(REST_MAX_MINUTES, v)));
}

/**
 * 她留的那句话能存多久。
 * 以前是硬 12 小时——她说「明早再看」，隔了 13 小时那张便签就直接没了。
 * 现在跟着她自己的 next 走：留的间隔越长，便签留得越久；仍留上限，免得半年前的便签被翻出来。
 */
export const NOTE_TTL_MS = 12 * 3_600_000;
export const NOTE_TTL_MAX_MS = 36 * 3_600_000;

export function noteTtlMs(t: { nextIn?: number }): number {
  const byHer = (Number(t.nextIn) || 0) * 60_000 + 3_600_000;
  return Math.min(NOTE_TTL_MAX_MS, Math.max(NOTE_TTL_MS, byHer));
}

/**
 * 跨天接续的三道闸。
 * 只在「同一天内」能接着想的旧限制，让隔夜的心事第二天只能从头再讲一遍；
 * 放开到 20 小时就够覆盖一夜，再长就变成翻旧账。
 * 同时必须是她自己留了话（或说要歇着）——没留就是真想完了。
 */
export const CARRY_FRESH_MIN = 120;
export const CARRY_MAX_AGE_MIN = 1200;
export const CARRY_MAX_DEPTH = 2;

/** 累计重要度到这条线就该往上抽象一层了（写一条 reflection）。 */
export const REFLECT_THRESHOLD = 24;

export interface BudgetState {
  day: string;
  count: number;
  tokens: number;
  pendingImportance: number;
  lastThoughtAt?: string;
  nextDueAt?: string;
  /** 她留的那句话已经递过一次了，别重复递。 */
  lastNoteId?: string;
  /** 这一段沉默已经写过一条「想说话」了，别每个 tick 重写。 */
  lastUrgeAt?: string;
}

const BUDGET_FILE = 'state.json';

export function loadBudget(dir: string): BudgetState {
  const file = join(dir, BUDGET_FILE);
  if (!existsSync(file)) return { day: '', count: 0, tokens: 0, pendingImportance: 0 };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BudgetState>;
    return {
      day: String(raw.day ?? ''),
      count: Number(raw.count) || 0,
      tokens: Number(raw.tokens) || 0,
      pendingImportance: Number(raw.pendingImportance) || 0,
      ...(raw.lastThoughtAt ? { lastThoughtAt: String(raw.lastThoughtAt) } : {}),
      ...(raw.nextDueAt ? { nextDueAt: String(raw.nextDueAt) } : {}),
      ...(raw.lastNoteId ? { lastNoteId: String(raw.lastNoteId) } : {}),
      ...(raw.lastUrgeAt ? { lastUrgeAt: String(raw.lastUrgeAt) } : {}),
    };
  } catch {
    return { day: '', count: 0, tokens: 0, pendingImportance: 0 };
  }
}

export function saveBudget(dir: string, state: BudgetState): void {
  ensureDir(dir);
  writeFileSync(join(dir, BUDGET_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 跨天清零。返回是不是新的一天。 */
export function rollDay(state: BudgetState, today: string): boolean {
  if (state.day === today) return false;
  state.day = today;
  state.count = 0;
  state.tokens = 0;
  return true;
}
