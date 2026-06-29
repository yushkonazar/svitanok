// Шаблон модуля (§3, §4). Копіюй для нового модуля.
//  - kind: 'producer' (пише в RunBus, виконується першим) | 'consumer'.
//  - enabled(config): читає свій зріз повного конфігу (§19.5).
//  - run(ctx): повертає Block або null. null = «нічого свіжого» (єдиний сигнал).
//  - Падіння модуля не валить брифінг (orchestrator ловить через allSettled).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

export const templateModule: Module<AppConfig> = {
  id: 'template',
  kind: 'consumer',
  enabled: () => false,
  async run(_ctx: Ctx<AppConfig>): Promise<Block | null> {
    return null;
  },
};
