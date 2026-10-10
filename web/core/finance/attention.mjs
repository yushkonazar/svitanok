import { executeFinanceCommand, FinanceConflict } from './workspace.mjs';
import { readTransaction } from './store.mjs';
import { parseFinanceAttention } from './attention-state.mjs';
import { transactionText } from './notify.mjs';
import { financeMiniAppButton } from './links.mjs';

/** Owner acknowledgement is not payment confirmation or cancellation.
 * The worker's primary-owner callback gate owns authentication.
 * @param {Env} env @param {string} id @param {'reviewing'|'different'} status @param {number} nowMs */
export async function acknowledgeFinanceAlert(env, id, status, nowMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await readTransaction(env, id);
    if (!row) throw new Error('Операція вже недоступна.');
    const attention = parseFinanceAttention(row.raw_json);
    if (attention) return { row, attention };
    const state = await env.DB?.prepare("SELECT version FROM finance_settings WHERE id='owner'")
      .bind()
      .first();
    try {
      await executeFinanceCommand(
        env,
        {
          id: crypto.randomUUID(),
          version: Number(state?.version),
          type: 'transaction-attention',
          payload: { transactionId: id, status },
        },
        nowMs,
      );
      return { row, attention: { status, at: new Date(nowMs).toISOString(), source: 'owner' } };
    } catch (error) {
      if (!(error instanceof FinanceConflict) || attempt) throw error;
    }
  }
  throw new Error('Не вдалося зберегти відповідь.');
}

/** @param {Env} env @param {any} row @param {{status:string}} attention @param {string|number|null} chatId */
export function financeAcknowledgementCard(env, row, attention, chatId) {
  const line =
    attention.status === 'different'
      ? 'Позначив як різні покупки. Обидві операції залишились в обліку.'
      : 'Позначив для твоєї перевірки. Списання не скасовував.';
  const open = financeMiniAppButton(env, 'Відкрити операцію', 'transaction', row.id, chatId);
  return {
    text: `${transactionText({ ...row, merchant: row.description, flags: ['duplicate'] })}\n\n${line}`,
    reply_markup: { inline_keyboard: open ? [[open]] : [] },
  };
}
