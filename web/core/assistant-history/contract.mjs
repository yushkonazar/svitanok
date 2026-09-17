// Контракт singleton Durable Object для короткої історії діалогів асистента.
// Клієнти не імпортують cloudflare:workers лише заради імені binding.

export const ASSISTANT_HISTORY_DO_NAME = 'assistant-history';
export const ASSISTANT_HISTORY_KEY = 'assistantHistory';
