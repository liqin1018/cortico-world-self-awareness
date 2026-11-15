/** 配置：默认关闭，因为没配模型就不会想事情。 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export type Provider = 'deepseek' | 'openai' | 'ollama' | 'custom';

export interface SelfAwarenessConfig {
  enabled: boolean;
  provider: Provider;
  baseUrl: string;
  model: string;
  /** 直接存本机 config.json。ollama 这类不要密钥的留空即可。 */
  apiKey: string;
  /** 一天最多想几次。0 = 不限（不建议）。 */
  dailyLimit: number;
  /** 一天最多花多少 token。0 = 不限。 */
  dailyTokenBudget: number;
  minGapMin: number;
  maxGapMin: number;
  /** 对方说完话后多少分钟内不去想事——人在说话时，她该在听，不是在走神。 */
  quietAfterUserMin: number;
  /** 记忆核心那边判定「在睡觉」时，完全停止思考。 */
  sleepSilent: boolean;
  maxOutputTokens: number;
  temperature: number;
  /** 一句话交代她是谁，写进思考的上下文。留空就只按记忆来。 */
  personaNote: string;
  /** 本地时间线页面 */
  siteEnabled: boolean;
  sitePort: number;
  /** 记忆核心的数据目录。留空自动找同级的 memory-core。 */
  memoryCoreDir: string;
}

/** 常见服务的默认地址：选了就自动填，填了就以你填的为准。 */
export const PROVIDER_PRESETS: Record<Provider, { baseUrl: string; model: string; needsKey: boolean }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needsKey: false },
  custom: { baseUrl: '', model: '', needsKey: false },
};

export const SELF_AWARENESS_DEFAULTS: SelfAwarenessConfig = {
  enabled: false,
  provider: 'deepseek',
  baseUrl: '',
  model: '',
  apiKey: '',
  dailyLimit: 12,
  dailyTokenBudget: 60_000,
  minGapMin: 25,
  maxGapMin: 90,
  quietAfterUserMin: 20,
  sleepSilent: true,
  maxOutputTokens: 220,
  temperature: 0.95,
  personaNote: '',
  siteEnabled: true,
  sitePort: 7802,
  memoryCoreDir: '',
};

const RAW_GROUP: ConfigGroup = {
  // 这两个字段是宿主校验配置组的硬条件（isConfigGroup）：缺一个整组就被丢掉，
  // 界面上只显示「配置组不可用」。title/description 要放在 schema 里，不是组上。
  id: 'world:self-awareness',
  owner: 'world:self-awareness',
  schema: {
    type: 'object',
    title: '自我意识',
    description:
      '没人说话的时候，她也在想自己的事。想到的写在本机一个文件里，不会发消息，也不占对话的 token。'
      + '先在 World 列表里启用本插件，再回来填模型和密钥；不填模型不会跑。'
      + '要花钱：每次思考都是一次模型请求，默认一天最多 12 次、6 万 token。',
    properties: {
      'worlds.self-awareness.provider': {
        type: 'string',
        enum: ['deepseek', 'openai', 'ollama', 'custom'],
        title: '用哪家',
        description: '选一个就行，下面两项留空就用它的默认地址和模型。本地 Ollama 不用密钥。',
        default: 'deepseek',
        'x-hot': true,
      } as never,
      'worlds.self-awareness.apiKey': {
        type: 'string',
        title: '密钥',
        description: '只存在你本机的 config.json 里，不会上传。你的密钥能调什么模型，它就用什么。',
        default: '',
        'x-hot': true,
      } as never,
      'worlds.self-awareness.model': {
        type: 'string',
        title: '模型',
        description: '留空用默认。建议用便宜的小模型——内心独白不需要多聪明，反而笨一点更像人。',
        default: '',
        'x-hot': true,
      } as never,
      'worlds.self-awareness.baseUrl': {
        type: 'string',
        title: '接口地址',
        description: '留空用默认。要接别的服务就填 OpenAI 兼容的 /v1 地址。',
        default: '',
      },
      'worlds.self-awareness.dailyLimit': {
        type: 'integer',
        title: '一天最多想几次',
        description: '硬上限。12 次大约几毛钱。0 = 不限，不建议。',
        minimum: 0,
        maximum: 200,
        default: 12,
      },
      'worlds.self-awareness.dailyTokenBudget': {
        type: 'integer',
        title: '一天最多花多少 token',
        description: '超过就停到明天。60,000 大约是一天 12 次思考的量。0 = 不限。',
        minimum: 0,
        maximum: 5_000_000,
        default: 60_000,
      },
      'worlds.self-awareness.minGapMin': {
        type: 'integer',
        title: '最短隔多久',
        description: '两次思考之间至少隔这么久（分钟）。',
        minimum: 1,
        maximum: 1440,
        default: 25,
      },
      'worlds.self-awareness.maxGapMin': {
        type: 'integer',
        title: '最长隔多久',
        description: '想到的东西多，就自动往这个上限靠；想得敷衍，就往上面那个下限靠。',
        minimum: 2,
        maximum: 1440,
        default: 90,
      },
      'worlds.self-awareness.quietAfterUserMin': {
        type: 'integer',
        title: '对方说话后安静多久',
        description: '他刚说完话的这段时间里不去想事——人在聊天的时候，她应该在听，不是在走神。0 = 不设限。',
        minimum: 0,
        maximum: 720,
        default: 20,
      },
      'worlds.self-awareness.sleepSilent': {
        type: 'boolean',
        title: '睡着时不想事',
        description: '读记忆核心的状态，判定她在睡觉就完全不跑。关掉的话睡觉期间也会想（有点怪）。',
        default: true,
      },
      'worlds.self-awareness.maxOutputTokens': {
        type: 'integer',
        title: '一次最多写多少字',
        description: '按 token 算，220 大约两三句话。内心独白太长会变成作文。',
        minimum: 60,
        maximum: 1200,
        default: 220,
      },
      'worlds.self-awareness.temperature': {
        type: 'number',
        title: '发散程度',
        description: '0.6 更稳定但容易重复，1.1 更跳脱但可能胡言乱语。0.95 是个折中。',
        minimum: 0,
        maximum: 2,
        default: 0.95,
      },
      'worlds.self-awareness.personaNote': {
        type: 'string',
        title: '她是谁',
        description: '一句话交代她的脾气，比如「你叫穹，话少，嘴硬心软」。留空就只按记忆来，容易写成通用 AI 的语气。',
        default: '',
        'x-hot': true,
      } as never,
      'worlds.self-awareness.siteEnabled': {
        type: 'boolean',
        title: '本地时间线页面',
        description: '开一个只在本机的小网页，能按时间翻她想过的每一条、她自己收成的自我认知，以及今天花了多少。只绑 127.0.0.1，不对外。',
        default: true,
      },
      'worlds.self-awareness.sitePort': {
        type: 'integer',
        title: '页面端口',
        description: '默认 7802。被占用会自动往后找。改完要重启 World。',
        minimum: 1024,
        maximum: 65_535,
        default: 7802,
      },
      'worlds.self-awareness.memoryCoreDir': {
        type: 'string',
        title: '记忆核心目录',
        description: '留空自动找同级的 memory-core。装了记忆核心才需要这个，没装也能跑（只是没有素材）。',
        default: '',
      },
    },
    required: [],
  } as never,
};

/** 设置页顺序：先让人能跑起来（模型三件套），再谈频率和预算。 */
const SETTINGS_ORDER = [
  'worlds.self-awareness.provider',
  'worlds.self-awareness.apiKey',
  'worlds.self-awareness.model',
  'worlds.self-awareness.baseUrl',
  'worlds.self-awareness.dailyLimit',
  'worlds.self-awareness.dailyTokenBudget',
  'worlds.self-awareness.minGapMin',
  'worlds.self-awareness.maxGapMin',
  'worlds.self-awareness.quietAfterUserMin',
  'worlds.self-awareness.sleepSilent',
  'worlds.self-awareness.maxOutputTokens',
  'worlds.self-awareness.temperature',
  'worlds.self-awareness.personaNote',
  'worlds.self-awareness.siteEnabled',
  'worlds.self-awareness.sitePort',
  'worlds.self-awareness.memoryCoreDir',
];

export const SELF_AWARENESS_CONFIG_GROUP: ConfigGroup = (() => {
  const props = (RAW_GROUP.schema.properties ?? {}) as Record<string, unknown>;
  const known = SETTINGS_ORDER.filter((k) => k in props);
  const rest = Object.keys(props).filter((k) => !known.includes(k));
  return {
    ...RAW_GROUP,
    schema: { ...RAW_GROUP.schema, properties: Object.fromEntries([...known, ...rest].map((k) => [k, props[k]])) },
  };
})();

/** 实际要用的地址和模型：填了听你的，没填用预设。 */
export function resolveEndpoint(cfg: SelfAwarenessConfig): { baseUrl: string; model: string; needsKey: boolean } {
  const preset = PROVIDER_PRESETS[cfg.provider] ?? PROVIDER_PRESETS.custom;
  const baseUrl = String(cfg.baseUrl ?? '').trim() || preset.baseUrl;
  const model = String(cfg.model ?? '').trim() || preset.model;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), model, needsKey: preset.needsKey };
}
