# Ізольована проба OpenAI File Search

Статус: **готова до synthetic-only запуску; не запускалась на production і не
є частиною асистента.**

Цей документ описує єдиний допустимий спосіб порівняти hosted File Search до
окремого privacy-рішення. За [офіційною документацією OpenAI](https://developers.openai.com/api/docs/guides/retrieval),
File Search потребує завантаження файла у `vector_store`; видалення зв'язку
vector store не видаляє backing File само по собі. Для upload harness
використовує актуальний purpose `user_data`. Тому «просто увімкнути
інструмент» у живому brain не є безпечною зміною.

## Що робить harness

`npm run eval:file-search` запускається **лише** за одночасної наявності:

```bash
OPENAI_FILE_SEARCH_EXPERIMENT=synthetic-only
OPENAI_API_KEY=…
```

Він приймає жодних аргументів, не читає файл, Drive, D1, KV, Telegram або
поточні документи власника. Замість цього в коді є короткий штучний текст із
відомим маркером. Послідовність така:

1. створити одноразові OpenAI File і vector store з 1-добовим expiry guard;
2. прикріпити synthetic File та дочекатися `completed`;
3. виконати Responses із `store:false`, `file_search` та
   `include: ["file_search_call.results"]`;
4. перевірити факт успішного file-search call і маркер у повернутих search
   results, не друкуючи provider output;
5. у `finally` видалити **vector store**, а потім **backing File**; у звіті
   немає ключа, id, вмісту чи body помилки.

Невдача під час upload, indexing або Responses не скасовує cleanup. Це також
перевіряється локальним unit test з fake HTTP.

## Межа та рішення

Harness підтверджує лише API-семантику, `store:false` для Responses і cleanup
тимчасових об'єктів. Він **не** вимірює якість retrieval на приватному CV чи
конспекті — отже не є дозволом вважати hosted File Search продуктивним або
вмикати його в runtime.

Порівняння на реальному документі потребує окремого рішення власника, де
одночасно названі:

- один конкретний не-чутливий файл і його дозволений тип;
- ціль порівняння та обмежений набір запитів;
- зовнішня межа зберігання OpenAI та явне видалення backing File після проби;
- критерії якості/latency/cost і умова, за якої експеримент вважається
  непридатним.

До такого рішення Svitanok використовує наявну власну narrow knowledge base:
D1 — truth, Vectorize — відновлювана проєкція, а `knowledge.inspect/import`
залишаються allowlist-first і T1. У production prompt/adapter **немає**
`file_search`, тож цей harness не може непомітно передати документ провайдеру.
