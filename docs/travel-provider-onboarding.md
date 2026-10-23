# Підключення туристичних джерел до Світанку

Стан на 23.10.2026. Проєкт приватний, для однієї людини. Бронювання та оплата відбуваються на сайті обраного сервісу.

## Що вже зроблено

- У Google Cloud `svitanok-apis` створено мапу Svitanok Travel з власним Map ID.
- Опубліковано окремий переглядач `https://maps.svitanok.yushko.dev/travel-map.html`; його адреса не відкриває API або базу Світанку.
- Підготовлено окремий браузерний ключ Maps JavaScript API: створення ключа очікує погодження, ключ ще не видано.
- Підготовлено серверний Booking Demand v3.2 адаптер. Без партнерських ключів він не викликається.
- Прямі переходи до Booking/Airbnb та INFOBUS/FlixBus не вимагають реєстрації в партнерських програмах.

## Google Maps: завершення

Після погодження створити ключ тільки для Maps JavaScript API, з HTTP referrers `https://maps.svitanok.yushko.dev/*` і тимчасово `http://localhost:53749/*`. Зберегти як Cloudflare secret `MAPS_BROWSER_API_KEY` основного Worker `svitanok`. Існуючий серверний `MAPS_API_KEY` не копіювати в браузер. Map ID уже внесено в конфігурацію основного Worker.

Перевірити справжню мапу на синтетичній поїздці: точки, вибір картки, масштаб і помилки завантаження. Потім прибрати локальний referrer. Налаштування ключа не означає, що новий інтерфейс Mini App уже опублікований.

## Житло без очікування партнерського договору

Рекомендований для випробування варіант: [SerpApi Google Hotels](https://serpapi.com/google-hotels-api). Це окреме джерело результатів Google Hotels, не підключення особистого Booking-акаунта і не обіцянка персональних тарифів Genius.

1. Погодити використання сервісу; вибір запитано в чаті.
2. Відкрити [реєстрацію безкоштовного плану](https://serpapi.com/users/sign_up?plan=free), пройти реєстрацію й самостійно прийняти умови.
3. Залишити план Free: за [офіційними тарифами](https://serpapi.com/pricing) він коштує $0 і включає 250 пошуків на місяць. Starter коштує $25/місяць за 1000 пошуків; платний план не підключати без окремого рішення.
4. Ключ зберегти в локальному ігнорованому файлі або менеджері секретів, не в чаті та не в Git. Після цього завершити адаптер і перевірити реальні відповіді.
5. Відображати дату перевірки, джерело ціни та її обсяг. Параметри проживання й кількість кімнат повинні підтримуватися джерелом; непідтримуваний склад групи не підміняти іншими умовами.

## Booking: окремий доступ до Demand API

[Офіційні вимоги](https://developers.booking.com/demand/docs/getting-started/prerequisites): Managed Affiliate Partner, погоджений договір, Partner Centre, API token та affiliate ID. [Звичайна партнерська реєстрація](https://www.booking.com/affiliate-program/v2/index.html) зараз спрямовує до CJ для посилань і рекламних інструментів; вона сама по собі не підтверджує доступу до Demand API.

Спочатку потрібно отримати від партнерської підтримки підтвердження, що приватний застосунок з одним користувачем може отримати search/look/redirect доступ. Не вказувати вигадану компанію чи аудиторію. До такого підтвердження немає сенсу оформлювати CJ лише заради API.

Після схвалення потрібні `BOOKING_API_TOKEN`, `BOOKING_AFFILIATE_ID`, фактична країна проживання booker (`BOOKING_BOOKER_COUNTRY`) і sandbox. Production вмикається після перевірки реальних дат, гостей, фотографій і повної ціни. Особистий туристичний логін Booking не замінює цих даних.

Текст запиту до партнерської підтримки або майбутнього account manager:

> Hello. I am developing Svitanok, a private Telegram Mini App used by one person to plan personal trips. Its domain is https://svitanok.yushko.dev. I need read-only accommodation search, dated prices for the requested guests, property photos and details, followed by a redirect to Booking.com for booking and payment. I do not operate a travel agency or a public booking platform. Is Managed Affiliate / Demand API access available for this use case? If so, please explain the eligibility requirements, agreement, charges or minimum volumes, sandbox access and application process. I would also like to understand whether personal Genius prices can be represented, or whether only standard affiliate rates are available.

## INFOBUS / BusSystem

Є [форма INFOBUS](https://partner.infobus.eu/ua/) з ім’ям, email, телефоном, адресою сайту й згодою з умовами. Окрема [сторінка BusSystem для агентів](https://bussystem.eu/uk/agents) описує договір та API. Контакти з цих сторінок: `cpa@infobus.eu` і `partner@infobus.eu`.

Спочатку уточнити можливість приватного read-only доступу. Телефон і контактний email для заявки має підтвердити власник. Реєстраційну форму й згоду з договором не відправляли.

Готовий текст запиту:

> Добрий день! Розробляю Світанок — приватний Telegram Mini App для планування власних поїздок, один користувач. Адреса: https://svitanok.yushko.dev. Потрібен пошук автобусних рейсів за містами, датами й кількістю пасажирів: розклад, тривалість, ціна, багаж і посилання для переходу до оплати на INFOBUS. Бронювання та платежі через API не плануються. Чи можливий доступ до API для такого особистого використання? Які умови, вартість або мінімальні обсяги, чи є тестове середовище та які дані потрібні для заявки? Зокрема цікавить напрямок Львів — Прага й зворотна дорога.

## FlixBus

[Офіційна сторінка](https://www.flixbus.com/company/partners/affiliate-partners) відокремлює AWIN-посилання від dynamic API. Для API вказано `online-distribution@flixbus.com`; у запиті просять інформацію про компанію, домени та місячну відвідуваність. Приватний проєкт потрібно описати прямо, без вигаданих показників.

Готовий текст запиту:

> Hello Flix Online Distribution Team. I am developing Svitanok, a private Telegram Mini App for planning my personal trips, used by one person. Domain: https://svitanok.yushko.dev. There is no public audience or travel-agency business. I would like read-only access to dated FlixBus routes, schedules, fares and baggage conditions, with a redirect to FlixBus for booking and payment. Is your dynamic API or a suitable self-service integration available for this low-volume private use case? Please advise the eligibility requirements, agreement, fees or minimum volumes, sandbox access and next steps. My initial route is Lviv — Prague, including return travel.

## Airbnb

За [офіційним описом API-програм](https://www.airbnb.com/help/article/3418) доступ залежить від програми та договору; відкритого guest-search API для приватного мандрівника не підтверджено. Підтримується перехід до Airbnb з датами й гостями. Реєстрація як власника житла для цього не потрібна.

Жоден із наведених листів не надіслано. Вони готові для погодження та відправлення після підтвердження контактів власника. Паролі, платіжні дані та API-ключі не потрібні в переписці.
