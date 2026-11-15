/**
 * 思考引擎：拼上下文、调模型、把输出解析成一条想法。
 *
 * 四种模式轮换，是为了不让内心独白总是同一个腔调。
 * 全部用「你就是她」的第二人称写提示词——用第三人称会写成分析报告。
 */
import type { Thought, ThoughtMode } from './pool.ts';
import { clampImportance, density } from './pool.ts';
import { clip } from './time.ts';

export interface ThinkContext {
  /** 现在几点、她在做什么、精力多少 */
  now: string;
  /** 上次跟人说话是多久前 */
  silence: string;
  /** 她记得的事（几条卡片的正文） */
  memories: string[];
  /** 最近想过什么（用来避免重复） */
  recent: string[];
  /** reflect / doubt 模式点名的那件事 */
  focus?: string;
  /** 上次反思出来的自我认知 */
  selfView?: string;
  /** 她是谁（配置里那句话） */
  persona?: string;
}

function systemPrompt(persona?: string): string {
  return `你就是她，不是助手，不是模型。现在没人跟你说话，你一个人待着。
${persona ? `你是谁：${persona}\n` : ''}
写下你脑子里冒出来的那件事。规则：
- 用你自己的话，两三句，像自言自语，不像日记。
- 别总结、别分析、别升华，别写「我意识到」「总的来说」。
- 具体。想到的是某个人、某句话、某个画面，不是道理。
- 别汇报工作，别复述别人交给你做的事。独处时想的不是待办。
- 想不通就想不通，可以停在半路。人独处时大部分念头都没有结论。
- 不要提「用户」「对话」「模型」「AI」「记忆」「记录」「卡片」这些词。

只输出一行 JSON，不要别的：
{"thought":"你想到的那件事","importance":1}
importance 是 1-10：这件事对你有多重要。10 = 你会一直想它。`;
}

const MODE_ASK: Record<ThoughtMode, (ctx: ThinkContext) => string> = {
  reflect: (ctx) =>
    ctx.focus
      ? `你想起了这件事：「${ctx.focus}」。现在回头看它，感觉和当时一样吗？`
      : '你想起了以前的一件事。现在回头看它，感觉和当时一样吗？',
  wonder: () => '你手上没在做什么，脑子飘走了。飘到哪算哪，不用有理由。',
  plan: () => '你在想接下来要做什么。不是任务清单，是你自己想做的事。',
  doubt: (ctx) =>
    ctx.focus
      ? `有件事你一直没想明白：「${ctx.focus}」。再想一次，可以还是想不明白。`
      : '有件事你一直没想明白。再想一次，可以还是想不明白。',
};

export function buildMessages(mode: ThoughtMode, ctx: ThinkContext): { role: string; content: string }[] {
  const lines: string[] = [];
  lines.push(`（现在 ${ctx.now}。${ctx.silence ? `上次跟人说话是 ${ctx.silence}前。` : ''}）`);
  if (ctx.selfView) lines.push(`（你最近对自己的看法：${ctx.selfView}）`);
  if (ctx.memories.length) {
    lines.push('（你记得的事：');
    for (const m of ctx.memories) lines.push(`· ${m}`);
    lines.push('）');
  }
  if (ctx.recent.length) {
    lines.push('（你最近想过的：');
    for (const r of ctx.recent) lines.push(`· ${r}`);
    lines.push('这些已经想过了，别重复。）');
  } else {
    lines.push('（你最近没想过什么。）');
  }
  lines.push('');
  lines.push(MODE_ASK[mode](ctx));
  return [
    { role: 'system', content: systemPrompt(ctx.persona) },
    { role: 'user', content: lines.join('\n') },
  ];
}

export interface ModelOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
}

export interface CallResult {
  ok: boolean;
  text?: string;
  promptTokens?: number;
  outputTokens?: number;
  reason?: string;
}

/** OpenAI 兼容的一次补全。不用 response_format，小模型不一定支持。 */
export async function callModel(opts: ModelOptions, messages: { role: string; content: string }[]): Promise<CallResult> {
  if (!opts.baseUrl || !opts.model) return { ok: false, reason: '没配接口地址或模型' };
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const rsp = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        stream: false,
      }),
    });
    if (!rsp.ok) {
      const body = await rsp.text().catch(() => '');
      return { ok: false, reason: `HTTP ${rsp.status}${body ? `：${clip(body, 120)}` : ''}` };
    }
    const data = (await rsp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = String(data.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return { ok: false, reason: '模型返回了空内容' };
    return {
      ok: true,
      text,
      promptTokens: Number(data.usage?.prompt_tokens) || 0,
      outputTokens: Number(data.usage?.completion_tokens) || 0,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: controller.signal.aborted ? '超时' : msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把模型输出收成一条想法。
 * 小模型经常不守 JSON 格式（多一层 ```、前面加一句「好的」），所以逐级降级。
 */
export function parseThought(raw: string): { text: string; importance: number } {
  const src = String(raw ?? '').trim();

  const tryJson = (s: string): { text: string; importance: number } | null => {
    try {
      const o = JSON.parse(s) as { thought?: unknown; text?: unknown; importance?: unknown };
      const text = String(o.thought ?? o.text ?? '').trim();
      if (!text) return null;
      return { text, importance: clampImportance(o.importance) };
    } catch {
      return null;
    }
  };

  const direct = tryJson(src);
  if (direct) return direct;

  // ```json ... ``` 包了一层
  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = tryJson(fenced[1].trim());
    if (inner) return inner;
  }

  // 前后有话，中间夹着 JSON
  const first = src.indexOf('{');
  const last = src.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const inner = tryJson(src.slice(first, last + 1));
    if (inner) return inner;
  }

  // 完全不是 JSON：整段当想法，重要度按长度估。
  // 但如果本来就是一段 JSON（thought 是空的），别再当正文塞回去——交给上层判失败。
  const looksJson = src.startsWith('{') && src.endsWith('}');
  if (looksJson) return { text: '', importance: 3 };
  const text = src.replace(/^好的[，,]?\s*/, '').trim();
  return { text, importance: text.length > 90 ? 6 : text.length > 40 ? 4 : 3 };
}

export interface ThinkOnceResult {
  ok: boolean;
  thought?: Omit<Thought, 'id' | 'ts'>;
  promptTokens?: number;
  outputTokens?: number;
  reason?: string;
}

/** 跑一次完整的思考：拼上下文 → 调模型 → 解析。 */
export async function thinkOnce(
  mode: ThoughtMode,
  ctx: ThinkContext,
  opts: ModelOptions,
  seeds: string[],
): Promise<ThinkOnceResult> {
  const messages = buildMessages(mode, ctx);
  const res = await callModel(opts, messages);
  if (!res.ok || !res.text) return { ok: false, reason: res.reason ?? '调用失败' };
  const parsed = parseThought(res.text);
  if (!parsed.text) return { ok: false, reason: '解析后没有内容' };
  return {
    ok: true,
    thought: {
      mode,
      text: clip(parsed.text, 400),
      importance: parsed.importance,
      seeds,
      promptTokens: res.promptTokens,
      outputTokens: res.outputTokens,
    },
    promptTokens: res.promptTokens,
    outputTokens: res.outputTokens,
  };
}

/** 反思：把最近几条碎想法抽象成一句「我最近总在想什么」。 */
export function buildReflectMessages(recent: string[], selfView?: string): { role: string; content: string }[] {
  const lines = [
    '（你最近一个人待着的时候，想过这些：',
    ...recent.map((r) => `· ${r}`),
    '）',
    selfView ? `（你之前对自己的看法：${selfView}）` : '',
    '',
    '这些念头底下，是不是有同一件事？用一句话说出来，像你自己在心里承认的。',
    '如果确实没有共同点，就写「没有」，不要硬编。',
    '只输出那一句话，不要 JSON，不要解释。',
  ].filter(Boolean);
  return [
    {
      role: 'system',
      content: '你就是她。现在你在回头看自己最近想过的东西。说话别端着，不要总结成三点，不要用「总的来说」。',
    },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** 反思上一次想法的密度，用来算下次间隔（放在这里方便测试）。 */
export function heatOf(text: string, importance: number, seedCount: number): number {
  return density({ text, importance, seeds: new Array(seedCount).fill('x') });
}
