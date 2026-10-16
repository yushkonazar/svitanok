# Ручний план 0.11.0: підтвердження релізу

16.10.2026, [PR #491](https://github.com/yushkonazar/svitanok/pull/491),
repository SHA `09e4a0d8ca4d3e834c13a5cabad8cf77176005dc`.
Root/Mini App — 0.11.0; Brain має незалежну версію 0.1.0.
Mini App: <https://svitanok.yushko.dev/app/>.

- Перед міграцією збережено серверну точку відновлення D1 Time Travel
  і попередню Worker version у приватній локальній `.workspace`.
  SQL-дамп особистих записів не створювали.
- Єдину pending expand-міграцію `0042_motivation_plan.sql` застосовано
  до merge/deployment. Підтверджено п’ять нових таблиць; pending міграцій немає.
- Cloudflare Git build успішний. Worker version
  `48f23ad1-2804-4eee-99ff-b45ae0ddb252` отримала 100% трафіку.
  Entry JS/CSS та PlanScreen JS/CSS у production за SHA-256 збігаються
  з перевіреною локальною збіркою; HTML посилається на очікувані assets.
- Brain атомарно оновлено до цього SHA, readiness deployment успішний.
  `brainExpected` містить той самий SHA. Інструкції синхронізовані.
- CI PR і main, Workers Builds, D1 migrate, Sync instructions та deploy host
  успішні. Повні локальні набори: 5719 root tests і 375 Mini App tests.
- Опублікований інтерфейс перевірено у чистому Chrome без сесії власника:
  320/390/768 px × дві теми × три вкладки, без переповнення та page errors.
  Частковий результат, скасування, умова винагороди і створення чернетки
  пройшли у відокремленому локальному демо.
- `/api/plan` без авторизації повертає 401 та `private, no-store`.
  Чинні `/api/finance`, `/api/stats` і `/api/system` також повертають 401;
  публічний `/api/status` — 200.

Увімкнення правил і прийняття власних задач залишені явними діями власника
в Telegram Mini App. Тестових особистих зобов’язань, повідомлень асистента,
календарних подій, дозволів на покупки чи списань XP не створювали.
Живий сценарій з авторизованої Telegram-сесії та жести на iPhone ще має
перевірити власник під час користування. Окремий Vitest Workers pool локально
не стартував; успішні CI й незалежна Miniflare D1 перевірка не названі
підтвердженням цього runner.

[Користування, арифметика XP, календар і межі першого зрізу](manual-plan-0.11.0.md).
