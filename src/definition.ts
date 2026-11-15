/** World 定义：没有工具、没有事件——它只在后台写文件。 */
import type { EventDescribe, ToolDescribe } from 'cortico/core/types.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import { SELF_AWARENESS_DEFAULTS, type SelfAwarenessConfig } from './config.ts';
import { SelfAwarenessWorld } from './world.ts';

const TOOLS: ToolDescribe[] = [];
const EVENTS: EventDescribe[] = [];

export const SELF_AWARENESS_WORLD: WorldDefinition<SelfAwarenessConfig> = {
  id: 'self-awareness',
  label: '自我意识',
  defaults: () => ({ ...SELF_AWARENESS_DEFAULTS }),
  create: (ctx) => new SelfAwarenessWorld(ctx),
  describe: { tools: TOOLS, events: EVENTS },
};
