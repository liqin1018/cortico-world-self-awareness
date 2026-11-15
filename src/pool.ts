/**
 * 想法池：想法本身 + 「下次隔多久」这件事。
 *
 * 节奏是这里最要紧的一段。固定间隔就是闹钟；我们要的是：
 * 这次想得多、想得深 → 歇久点；这次敷衍了一句 → 过一会儿再想。
 * 间隔由内容算出来，不是钟表算出来。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    };
    ensureDir(this.dir);
    // 先让 cache 落地再 append：否则 all() 会从文件里读回刚写的那条，push 之后就有了两份
    const list = this.all();
    appendFileSync(this.file, `${JSON.stringify(thought)}\n`, 'utf8');
    list.push(thought);
    return thought;
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

/** 累计重要度到这条线就该往上抽象一层了（写一条 reflection）。 */
export const REFLECT_THRESHOLD = 24;

export interface BudgetState {
  day: string;
  count: number;
  tokens: number;
  pendingImportance: number;
  lastThoughtAt?: string;
  nextDueAt?: string;
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
