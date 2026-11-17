/**
 * 思考引擎：拼上下文、调模型、把输出解析成一条想法。
 *
 * 四种模式轮换，是为了不让内心独白总是同一个腔调。
 * 全部用「你就是她」的第二人称写提示词——用第三人称会写成分析报告。
 */
import type { Thought, ThoughtMode } from './pool.ts';
import { clampImportance, clampNextIn, clampRestIn, density } from './pool.ts';
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
  /** 上次她给自己留的那句话，原样递回来 */
  lastNote?: string;
  /** 这次是接着上一条想下去，不是新起一件 */
  carry?: boolean;
  /** 上一条是多久前写的（「8 小时」「两天」）。跨夜时得让她知道隔了多久。 */
  carryAgo?: string;
  /** 手上还挂着的几件没想完的事，她自己挑接哪条。 */
  loops?: { text: string; ago: string }[];
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
- 用什么方式想，你自己挑：回看 / 走神 / 打算 / 琢磨 / 综合。
- 想完之后，留一句「下次从哪儿接着想」和大致的间隔写进 next。
- 真的不想了、想搁着，就写 "rest":true，间隔可以长到一天。

只输出一行 JSON，不要别的：
{"thought":"你想到的那件事","importance":1,"mode":"wonder","next":{"in":60,"note":"留给自己的一句话"},"rest":false,"pick":0}
mode 只能填：reflect（回看以前的事）/ wonder（没缘由地走神）/ plan（打算接下来做什么）/ doubt（琢磨一件没想明白的）/ synthesize（把两件看着不相干的事连起来）。
importance 是 1-10：这件事对你有多重要。10 = 你会一直想它。
next 是你给自己留的：还会想，就定个时间（15–360 分钟；写了 rest 可以到 1440）和一句「下次从哪儿接着想」。
想完了、没什么可接的，就空着。
pick 是接哪条旧线：下面会列出你手上还挂着的几件，接第几件就写几，新起一件写 0。`;
}

const MODE_LABEL: Record<ThoughtMode, string> = {
  reflect: '回看',
  wonder: '走神',
  plan: '打算',
  doubt: '琢磨',
  synthesize: '综合',
};

/** 把五种方式摆给她选，不是替她定。 */
const MODE_MENU = [
  '· 回看：想起以前的一件事，回头看它',
  '· 走神：手上没在做什么，脑子飘走了',
  '· 打算：想自己接下来要做什么（不是待办清单）',
  '· 琢磨：一件一直没想明白的事，再想一次',
  '· 综合：把两件看着没关系的事连起来看',
].join('\n');

const MODE_ASK: Record<ThoughtMode, (ctx: ThinkContext) => string> = {
  reflect: (ctx) => {
    if (!ctx.focus) return '你想起了以前的一件事。现在回头看它，感觉和当时一样吗？';
    return `你想起了这件事：「${ctx.focus}」。现在回头看它，感觉和当时一样吗？`;
  },
  wonder: () => '你手上没在做什么，脑子飘走了。飘到哪算哪，不用有理由。',
  plan: () => '你在想接下来要做什么。不是任务清单，是你自己想做的事。',
  doubt: (ctx) =>
    ctx.focus
      ? `有件事你一直没想明白：「${ctx.focus}」。再想一次，可以还是想不明白。`
      : '有件事你一直没想明白。再想一次，可以还是想不明白。',
  synthesize: (ctx) => {
    const list = ctx.memories ?? [];
    if (list.length < 2) return '你手上只有一件事。试着把它和别的什么连起来想。';
    return `「${clip(list[0], 60)}」和「${clip(list[1], 60)}」——这两件事看着没关系。`
      + '它们之间有没有相通的地方？\n别硬凑，真的没有就说没有。';
  },
};

export function buildMessages(mode: ThoughtMode, ctx: ThinkContext): { role: string; content: string }[] {
  const lines: string[] = [];
  lines.push(`（现在 ${ctx.now}。${ctx.silence ? `上次跟人说话是 ${ctx.silence}前。` : ''}）`);
  if (ctx.lastNote) lines.push(`（上次你自己留了一句：${ctx.lastNote}）`);
  if (ctx.selfView) lines.push(`（你最近对自己的看法：${ctx.selfView}）`);
  if (ctx.memories.length) {
    lines.push('（你记得的事：');
    for (const m of ctx.memories) lines.push(`· ${m}`);
    lines.push('）');
  }
  if (ctx.recent.length) {
    lines.push('（你最近想过的：');
    for (const r of ctx.recent) lines.push(`· ${r}`);
    lines.push('同一件事可以接着想，但要说新的一层，别把上面的话重说一遍；换新的事也行。）');
  } else {
    lines.push('（你最近没想过什么。）');
  }
  lines.push('');
  if (ctx.carry && ctx.focus) {
    // 接着上一条想：这时候别让她换题，除非她自己要换
    const when = ctx.carryAgo ? `（${ctx.carryAgo}前）` : '';
    lines.push(`你上次写到「${ctx.focus}」${when}，没写完。接着往下想——说新的一层，别把上次那句重说一遍。`);
    lines.push(`想换件事也行；换就换，mode 里写你这次想用的方式。`);
  } else {
    lines.push('这次没人跟你说话。想怎么想都行：');
    lines.push(MODE_MENU);
    if (ctx.loops?.length) {
      lines.push('（你手上还挂着这几件，没想完：');
      ctx.loops.forEach((l, i) => lines.push(`${i + 1}. ${l.text}（${l.ago}前写的）`));
      lines.push('接哪条都行，也可以新起一件；接的话在 pick 里写序号，新起写 0。）');
    }
    if (ctx.focus) lines.push(`（手边现成的事：「${ctx.focus}」，想从这儿起头也行，不想用也行。）`);
    lines.push(`这会儿更像「${MODE_LABEL[mode]}」：${MODE_ASK[mode](ctx)}`);
    lines.push('你也可以换别的，mode 里写你选的。');
  }
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
    if (!text) {
      // 推理模型（deepseek-flash 这类）会先用掉一大截 token 想，额度给小了正文就没空间。
      // 这里自动加额重试一次——max_tokens 只是上限，给大了不额外花钱。
      const used = Number(data.usage?.completion_tokens) || 0;
      const reason = String(data.choices?.[0]?.finish_reason ?? '');
      if (opts.maxTokens < 2400) {
        return callModel({ ...opts, maxTokens: Math.max(800, opts.maxTokens * 3 + 200) }, messages);
      }
      return { ok: false, reason: `模型返回了空内容（输出 ${used} token，finish=${reason || '?'}）` };
    }
    return {
      ok: true,
      text,
      promptTokens: Number(data.usage?.prompt_tokens) || 0,
      outputTokens: Number(data.usage?.completion_tokens) || 0,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) return { ok: false, reason: '超时' };
    // fetch 的 message 常常只有「fetch failed」，真正的原因在 cause.code 里
    const code = (error as { cause?: { code?: string; message?: string } })?.cause?.code;
    const detail = (error as { cause?: { message?: string } })?.cause?.message;
    const hint = code === 'ECONNREFUSED'
      ? '连不上这个地址（服务没开或端口不对）'
      : code === 'ENOTFOUND'
        ? '域名解析不了（地址写错了）'
        : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
          ? '连不上（超时）'
          : '';
    const tail = [code, hint].filter(Boolean).join('：');
    return { ok: false, reason: tail ? `${msg}（${tail}）` : (detail ? `${msg}（${clip(detail, 60)}）` : msg) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把模型输出收成一条想法。
 * 小模型经常不守 JSON 格式（多一层 ```、前面加一句「好的」），所以逐级降级。
 */
export interface ParsedThought {
  text: string;
  importance: number;
  next?: { in?: number; note?: string };
}

export interface ParsedThought {
  text: string;
  importance: number;
  next?: { in?: number; note?: string };
  /** 她自己挑的方式。没填就用插件建议的那个。 */
  mode?: ThoughtMode;
  /** 她说「先搁着」。 */
  rest?: boolean;
  /** 接第几条旧线（从 1 开始）；0 / 没写就是新起一件。 */
  pick?: number;
}

const MODE_IDS: ThoughtMode[] = ['reflect', 'wonder', 'plan', 'doubt', 'synthesize'];

function asMode(value: unknown): ThoughtMode | undefined {
  return typeof value === 'string' && (MODE_IDS as string[]).includes(value) ? (value as ThoughtMode) : undefined;
}

/** 她给自己留的那句：范围收进合法范围，note 超过 40 字截断。都不合法就当没留。 */
export function parseNext(value: unknown, rest = false): { in?: number; note?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as { in?: unknown; note?: unknown };
  // 说了 rest 就允许拉到一天，否则还是 15–360
  const inMin = rest ? clampRestIn(o.in) : clampNextIn(o.in);
  const note = typeof o.note === 'string' && o.note.trim() ? clip(o.note.trim(), 40) : undefined;
  if (inMin === undefined && !note) return undefined;
  return { ...(inMin !== undefined ? { in: inMin } : {}), ...(note ? { note } : {}) };
}

export function parseThought(raw: string): ParsedThought {
  const src = String(raw ?? '').trim();

  const tryJson = (s: string): ParsedThought | null => {
    try {
      const o = JSON.parse(s) as { thought?: unknown; text?: unknown; importance?: unknown; next?: unknown; mode?: unknown; rest?: unknown; pick?: unknown };
      const text = String(o.thought ?? o.text ?? '').trim();
      if (!text) return null;
      const rest = o.rest === true || o.rest === 'true';
      const next = parseNext(o.next, rest);
      const mode = asMode(o.mode);
      const pick = Number(o.pick);
      return {
        text,
        importance: clampImportance(o.importance),
        ...(next ? { next } : {}),
        ...(mode ? { mode } : {}),
        ...(rest ? { rest: true } : {}),
        ...(Number.isFinite(pick) && pick > 0 ? { pick: Math.round(pick) } : {}),
      };
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
  /** 她挑了第几条旧线（从 1 开始）；没挑就没有。 */
  pickedLoop?: number;
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
  // 她自己挑了方式就用她的；没挑就沿用插件建议的
  const finalMode = parsed.mode ?? mode;
  const picked = parsed.pick && ctx.loops?.length && parsed.pick <= ctx.loops.length
    ? parsed.pick
    : undefined;
  return {
    ok: true,
    ...(picked ? { pickedLoop: picked } : {}),
    thought: {
      mode: finalMode,
      text: clip(parsed.text, 400),
      importance: parsed.importance,
      seeds,
      // 她自己留的那句要带出去，不然解析了也白解析
      ...(parsed.next?.in ? { nextIn: parsed.next.in } : {}),
      ...(parsed.next?.note ? { nextNote: parsed.next.note } : {}),
      ...(parsed.rest ? { rest: true } : {}),
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
