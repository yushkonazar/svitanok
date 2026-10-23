# Підключення туристичних джерел до Світанку

Стан на 23.10.2026. Проєкт приватний, для однієї людини. Бронювання та оплата відбуваються на сайті обраного сервісу.

## Що вже зроблено

- У Google Cloud `svitanok-apis` створено мапу Svitanok Travel з власним Map ID.
- Опубліковано окремий переглядач `https://maps.svitanok.yushko.dev/travel-map.html`; його адреса не відкриває API або базу Світанку.
- Створено окремий ключ `svitanok-travel-browser` тільки для Maps JavaScript API, з обмеженням `https://maps.svitanok.yushko.dev/*`. Тимчасовий локальний referrer прибрано після перевірки.
- У Cloudflare Worker `svitanok` збережено `MAPS_BROWSER_API_KEY` як зашифрований secret і `MAPS_MAP_ID` як публічну змінну.
- Підготовлено серверний Booking Demand v3.2 адаптер. Без партнерських ключів він не викликається.
- Прямі переходи до Booking/Airbnb та INFOBUS/FlixBus не вимагають реєстрації в партнерських програмах.

## Google Maps: перевірене підключення

Maps JavaScript API увімкнено у проєкті `svitanok-apis`. Ключ і Map ID збережені в основному Worker; Map ID також внесено у версіоновану конфігурацію. Існуючий серверний `MAPS_API_KEY` не копіювався в браузер.

На синтетичній поїздці перевірено справжні плитки Google, точки Львова й Праги, три точки житла, відкриття картки натисканням позначки, повернення до списку та відсутність автоматичного вибору житла. Мобільний перегляд перевірено на 390 × 844 px. Ключ передавався локальному тестовому серверу лише в оперативну пам’ять; локальний referrer після перевірки видалено. Новий інтерфейс Mini App залишається в PR 518 і потребує узгодженого релізу.

## Поточний вибір джерел житла

Власник обрав Booking і наявний вебпошук. SerpApi / Google Hotels не підключати: реєстрацію не розпочато, ключів і підписки немає. До отримання партнерського доступу Booking працюють вебдослідження та переходи на сайт із датами проживання й складом групи.

Відображати дату перевірки, джерело ціни та її обсяг. Вебзнайдений опис об’єкта не є підтвердженням наявності чи повної ціни на вибрані дати; персональні Genius-тарифи користувач перевіряє у власному сеансі Booking.

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
