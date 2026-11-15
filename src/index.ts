// 框架按 package.json 的 `main` 导入本文件，读取具名导出 id/label/defaults/create。
import { SELF_AWARENESS_WORLD } from './definition.ts';

export const id = SELF_AWARENESS_WORLD.id;
export const label = SELF_AWARENESS_WORLD.label;
export const defaults = SELF_AWARENESS_WORLD.defaults;
export const create = SELF_AWARENESS_WORLD.create;

export { SELF_AWARENESS_WORLD } from './definition.ts';
export default SELF_AWARENESS_WORLD;
export { SELF_AWARENESS_DEFAULTS, SELF_AWARENESS_CONFIG_GROUP, resolveEndpoint, type SelfAwarenessConfig } from './config.ts';
