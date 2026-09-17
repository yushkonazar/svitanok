# Журнал фактів і provenance

`facts` зберігає лише поточну структуровану істину. `fact_ledger` -
append-only історія, з якої власник може побачити, чому факт зʼявився,
змінився, зник або був відновлений. Журнал не є другою активною памʼяттю:
старий чи видалений запис ніколи не повертається у `facts.get` сам собою.

## Що записується

Кожна зміна має сталий `fact_id`, `operation` (`created`, `updated`,
`deleted`, `restored`), знімок значення й metadata (`source`, confidence,
дати, supersedes). Додатково ядро, не модель, додає:

- `actor`: `model`, `owner`, `trusted_server` або `undo`;
- `tainted`: чи був у контексті зовнішній вміст під час запиту;
- `why`: коротка підстава власника або контрольоване пояснення policy.

`facts.get` повертає лише current truth і явно мітить `stale` та `review_due`.
`facts.ledger` читає історію, включно з видаленими значеннями. Усі ці дані
входять у backup/export і видаляються разом із фактами через `forget all`.

## Запис і видалення

`facts.set` створює або редагує поточний факт. `null` є допустимим значенням,
але ніколи не означає видалення. Для видалення є окремий `facts.delete`:
він завжди T1, прибирає current truth лише після ✅ і залишає знімок у
журналі. Відкат T0-запису теж пише подію `deleted` або `restored`.

Факт і його event пишуться однією D1 batch-транзакцією. Збій не має права
підтвердити успішний запис без історії.

## Taint і підтвердження

Router обчислює taint після кожного tainting tool output. Перед будь-яким
persistent executor він передає policy context поза model payload. Якщо дія
стає proposal, цей trusted context зберігається в `proposals.context_json`;
після ✅ executor одержує той самий taint і `actor=owner`. Так provenance не
губиться між зовнішнім текстом, tool arguments, 30-хвилинним очікуванням і
фактичним D1 write, а модель не може його підробити через `payload_json`.
