# Життєвий цикл run

Це контракт control plane для одного `run_id`. Він однаково застосовується до
chat, quick, scheduler і worker-профілів. D1 `runs` — audit-проєкція, але не
джерело дозволу виконувати інструменти: ним є `RunRegistryDO`.

## Стани

| Стан        | Авторитетний запис                               | Дозволена наступна дія                                                                       |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `new`       | `run_id` ще ніде не зареєстрований               | `registryBegin`                                                                              |
| `active`    | `RunRegistryDO.active[run_id]`                   | brain може отримати `/run`; internal tool/status/deliver лише з підписом, nonce і active run |
| `completed` | короткоживучий `RunRegistryDO.completed[run_id]` | повторити тільки фінальний `/internal/runs` report; інструменти й delivery вже заборонені    |
| `terminal`  | completion window минув                          | жодне internal повідомлення цього run не авторизоване                                        |

Тред має незалежний серіалізований стан: `idle` → `claimed/pending` →
`active` → `idle` або наступний запис FIFO-черги. Запис у queue не є run і не
одержує прав на інструменти, доки `threadSetRun` не прив'яже до нього новий
`run_id`.

## Порядок переходів

1. Ядро створює `run_id` і **спочатку** викликає `registryBegin`. Якщо Durable
   Object недоступний, brain не стартує (fail closed).
2. Registry записує authoritative active state. Спроба записати telemetry у
   D1 є best-effort: її збій не може залишити run без можливості завершитись.
3. Ядро відсилає підписаний `POST /run`. Brain приймає його лише після HMAC,
   contract, run-id match, slot check і nonce.
4. Brain може надсилати signed internal calls. Кожний проходить HMAC → active
   run → nonce → schema. Повтор не виконує інструмент удруге.
5. Фінал йде через `/internal/runs`. Registry спершу переносить active state у
   коротке completed window, а тоді прибирає active право; D1 finish і
   telemetry можуть безпечно ретраїтися.
6. Завершення звільняє claim треду незалежно від помилки telemetry і піднімає
   наступний queued запис. Watchdog закриває прострочений run з `error=timeout`.

## Інваріанти повтору і збою

- `registryBegin` і `registryFinish` ідемпотентні за `run_id`; finish не
  переписує вже встановлений terminal результат.
- `run_steps` має унікальність `(run_id, n)`, тому повтор report не дублює
  кроки.
- nonce споживається лише після перевірки підпису та права на run. Помилковий
  або зайнятий запит не "спалює" легітимний retry.
- Queue advance не залежить від D1 telemetry; telemetry має бути чесно
  позначена як неповна, а не блокувати користувача.
- `deliver` і Telegram outbox ідемпотентні за своєю чергою; запізнілий run не
  може перезаписати status іншого run того ж треду.

## Спостережуваність

`/status` показує active/queued треди, свіжість та версійну сумісність brain,
готовність model runtime і останній успішний non-shadow run. Це діагностика,
не control plane: доступність у статусі ніколи не замінює registry gate.

Пов'язані модулі: `web/core/run-registry/do.mjs`,
`web/core/run-registry/client.mjs`, `web/core/internal/router.mjs`,
`web/core/prerouter.mjs` і `brain/src/server.ts`.
