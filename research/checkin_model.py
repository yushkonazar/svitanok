"""Референсна модель «Індекс дня» — вивідник математики й тест-оракул.

⚠️ ЦЕЙ ФАЙЛ НЕ ЇДЕ В ПРОД. Воркер — JS (web/worker.js, Cloudflare Workers),
Python там не виконується. Роль файлу інша й важливіша:

  1. СПЕЦИФІКАЦІЯ — тут живе математика в читабельному вигляді (numpy/scipy),
     де її видно цілком і можна перевірити олівцем. Порт у JS
     (web/checkin-model.mjs) мусить давати ТІ САМІ числа.
  2. ОРАКУЛ — `python checkin_model.py --emit-golden` пише золоті вектори
     у tests/fixtures/checkin-golden.json; JS-тест звіряється з ними.
     Розбіжність у 7-му знаку -> тест червоний. Це і є «підключення»
     до основного файлу: не імпортом, а контрактом.
  3. ПІСОЧНИЦЯ — тут дешево перевірити гіпотезу (чи ловить модель лаговий
     звʼязок? чи не переучується ridge на 20 добах?) перш ніж писати JS.

Запуск:
  python research/checkin_model.py              # демо на синтетиці + звіт
  python research/checkin_model.py --emit-golden
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field as dc_field
from pathlib import Path

import numpy as np
from scipy import stats

# ─────────────────────────────────────────────────────────────────────────────
# 1. РЕЄСТР ПОЛІВ
#
# Кожне поле чек-іну описане ОДИН раз: як звести до 0..1, куди «добре», і в
# який індекс воно входить. Порядок полів у реєстрі — контракт із JS (золоті
# вектори позиційні), тож НЕ переставляти, лише дописувати в кінець.
#
# polarity=-1 — реверсне поле: більше = гірше (румінація, екран, тривога).
# Без нього індекс «Відновлення» зростав би від румінації.
# ─────────────────────────────────────────────────────────────────────────────

RECOVERY, RESOURCE, WORK, AGENCY, BODY = "recovery", "resource", "work", "agency", "body"
INDICES = [RECOVERY, RESOURCE, WORK, AGENCY, BODY]
INDEX_LABEL = {
    RECOVERY: "Відновлення",
    RESOURCE: "Ресурс",
    WORK: "Робота",
    AGENCY: "Автономія",
    BODY: "Тіло",
}


@dataclass(frozen=True)
class Field:
    name: str
    slot: str
    index: str
    weight: float = 1.0
    polarity: int = 1
    # Ординальні переліки: значення -> позиція. None для числових 1..5.
    levels: tuple[str, ...] | None = None
    # Числовий діапазон для лінійного зведення (min, max). None -> 1..5.
    span: tuple[float, float] | None = None
    # Небінарне зведення (сон): назва спецпроцедури.
    curve: str | None = None
    # Легасі-значення з KV, яким свідомо НЕ призначено рівня (-> None). Тримаємо
    # явно, щоб CI-assert на боці JS відрізняв свідоме виключення від забутого
    # рівня. Дзеркало `legacyUnscored` у web/checkin-model.mjs.
    legacy_unscored: tuple[str, ...] = ()


FIELDS: tuple[Field, ...] = (
    # ── Відновлення ──────────────────────────────────────────────────────────
    # ⚠️ sleepKind — РЕЖИМ ночі, а не її тривалість, і він стоїть перед усім
    # іншим про сон. «Не спав» і «дрімав уривками» доти лягали в sleepH як
    # «мало спав», тобто три різні ночі ставали однією.
    #
    # Він НЕ замінює sleepH/sleepQ, а гейтить їх у чек-іні: на не-нічних
    # варіантах ті два питання не показуються, а значення ВИВОДЯТЬСЯ
    # (flattenCheckinDay на боці JS). Лишити їх порожніми було б найгіршим
    # варіантом: RECOVERY утратив би два з чотирьох ранкових полів саме в ту
    # добу, яка найінформативніша, і при MIN_FIELDS_PER_INDEX=2 найгірші ночі
    # зникали б з моделі взагалі.
    Field("sleepKind", "morning", RECOVERY, weight=1.2, levels=("none", "naps", "slept")),
    Field("sleepH", "morning", RECOVERY, weight=1.5, curve="sleep_hours"),
    Field("sleepQ", "morning", RECOVERY, weight=1.2),
    Field("sleepLatency", "morning", RECOVERY, weight=0.8, levels=("fast", "mid", "slow", "vslow"), polarity=-1),
    Field("bedtime", "morning", RECOVERY, weight=0.8, levels=("e23", "e00", "e01", "e02", "late"), polarity=-1),
    Field("detached", "evening", RECOVERY, weight=1.2, levels=("no", "partly", "yes")),
    Field("rumination", "evening", RECOVERY, weight=1.2, polarity=-1),
    Field("screen", "evening", RECOVERY, weight=0.6, levels=("low", "mid", "high", "vhigh"), polarity=-1),
    Field("caffeine", "evening", RECOVERY, weight=0.4, span=(0, 4), polarity=-1),
    # ── Ресурс (афект: три зрізи доби) ───────────────────────────────────────
    Field("energy@morning", "morning", RESOURCE, weight=1.0),
    Field("energy@afternoon", "afternoon", RESOURCE, weight=1.0),
    Field("energy@evening", "evening", RESOURCE, weight=1.0),
    Field("mood@morning", "morning", RESOURCE, weight=1.0),
    Field("mood@afternoon", "afternoon", RESOURCE, weight=1.0),
    Field("mood@evening", "evening", RESOURCE, weight=1.0),
    Field("worryAM", "morning", RESOURCE, weight=0.8, polarity=-1),
    Field("rushed", "afternoon", RESOURCE, weight=0.8, polarity=-1),
    # Переривання ЗЗОВНІ — окремо від власного відволікання. Доти обидві
    # причини зливались у блокер 'distract', хоч рішення в них різні.
    Field("interrupted", "afternoon", RESOURCE, weight=0.8, levels=("none", "few", "many"), polarity=-1),
    # ── Робота ───────────────────────────────────────────────────────────────
    Field("output", "evening", WORK, weight=1.5),
    Field("focusQuality", "evening", WORK, weight=1.2),
    Field("effort", "evening", WORK, weight=0.6),
    Field("kept", "evening", WORK, weight=1.2, levels=("no", "partly", "changed", "yes")),
    # legacy_unscored: старе «Збився» ("off") пізніше розділили на три різні дні
    # (behind/other/overload) — відновити, який саме, неможливо, тож свідомо None.
    Field("pace", "afternoon", WORK, weight=0.8, levels=("overload", "behind", "other", "on", "better"),
          legacy_unscored=("off",)),
    Field("jobProgress", "evening", WORK, weight=0.6),
    # Прогрес на ОБІД — друга не-вечірня опора WORK після pace. До неї індекс
    # тримався на одному полі поза вечором.
    Field("mainProgress", "afternoon", WORK, weight=1.0, levels=("none", "started", "half", "most")),
    # ── Автономія / сенс ─────────────────────────────────────────────────────
    Field("autonomy", "evening", AGENCY, weight=1.5),
    # ⚠️ ЧАСТКА виконаного плану, не булеве «влучив бодай у щось». Доти воно
    # було 0/1 з критерієм plan.some(p in ate) — і доба з планом [робота, спорт]
    # та фактом [спорт, відпочинок] діставала повну одиницю, хоч робота не
    # сталась. Що більше категорій обираєш уранці, то легше було «виконати
    # план», тобто AGENCY систематично завищувався саме в тих, хто планує
    # більше. span=(0,1) був такий від початку — міняється лише те, чим його
    # заповнюють.
    Field("intentMatch", "derived", AGENCY, weight=1.2, span=(0, 1)),
    Field("jobConfidence", "evening", AGENCY, weight=0.6),
    # Очікуваний контроль над днем (ранок) — пара до вечірньої autonomy.
    Field("dayControl", "morning", AGENCY, weight=1.0),
    # ── Тіло / режим ─────────────────────────────────────────────────────────
    # 'active' («Активно») чек-ін збирає з самого початку — без нього BODY (лише
    # 2 поля) ставав None і викидав УСЮ добу з навчання ваг/архетипів (B5).
    Field("moved", "evening", BODY, weight=1.5, levels=("none", "light", "active", "workout")),
    Field("outdoor", "evening", BODY, weight=1.2, levels=("none", "short", "long")),
    # ⚠️ ДВА НЕ-ВЕЧІРНІ ВХОДИ В BODY — і це головна причина, чому вони тут.
    # Доти індекс мав РІВНО два поля, обидва вечірні, при MIN_FIELDS_PER_INDEX=2:
    # запасу не було взагалі, і один пропущений тап робив BODY=None на всю добу,
    # а отже викидав її з архетипів. Заміряно: при явці вечора 20% архетипи
    # діставали 10 придатних діб із потрібних 20.
    #
    # Рівні дзеркалять вечірні аналоги слово в слово (none/light/workout проти
    # moved; none/short/long проти outdoor) — інакше пара «намір проти факту»
    # порівнювала б різні шкали.
    Field("movePlan", "morning", BODY, weight=1.0, levels=("none", "light", "workout")),
    Field("outdoorNow", "afternoon", BODY, weight=1.0, levels=("none", "short", "long")),
)

FIELD_INDEX = {f.name: i for i, f in enumerate(FIELDS)}

# Гейти. Свідомо консервативні: цей блок легко зробити брехливим, і брехня
# тут ВИГЛЯДАЄ як аналітика, тобто підштовхує до рішень.
MIN_FIELDS_PER_INDEX = 2   # менше — індекс за добу не рахуємо (None)
MIN_DAYS_FOR_FIT = 20      # менше — ваги не вчимо, беремо апріорні
MIN_N_PER_BUCKET = 8       # драйвер показуємо лише з 8 добами в КОЖНОМУ кошику
MIN_INDICES_FOR_SCORE = 3  # менше — «Індекс дня» за добу не рахуємо взагалі
RIDGE_GRID = [0.05, 0.15, 0.5, 1.5, 5, 15]  # λ обирається за LOO-CV, не зашита


# ─────────────────────────────────────────────────────────────────────────────
# 2. НОРМАЛІЗАЦІЯ 0..1
# ─────────────────────────────────────────────────────────────────────────────

def sleep_hours_score(h: float) -> float:
    """Сон -> 0..1 НЕЛІНІЙНО: 7–9 год = плато 1.0, штраф в обидва боки.

    Лінійна шкала карала б 10 годин як «краще за 8», а 9.5 — як ідеал. Плато
    з двобічним спадом — те, що реально описує норму (7–9 год).
    """
    if h is None:
        return None
    if 7.0 <= h <= 9.0:
        return 1.0
    if h < 7.0:
        return max(0.0, 1.0 - (7.0 - h) / 4.0)   # 3 год -> 0.0
    return max(0.0, 1.0 - (h - 9.0) / 3.0)       # 12 год -> 0.0


def normalize(f: Field, raw) -> float | None:
    """Сире значення поля -> 0..1 з урахуванням полярності. None лишається None."""
    if raw is None:
        return None
    if f.curve == "sleep_hours":
        v = sleep_hours_score(float(raw))
    elif f.levels is not None:
        if raw not in f.levels:
            return None
        v = f.levels.index(raw) / (len(f.levels) - 1)
    elif f.span is not None:
        lo, hi = f.span
        v = (float(raw) - lo) / (hi - lo)
    else:
        v = (float(raw) - 1.0) / 4.0
    v = min(1.0, max(0.0, v))
    return 1.0 - v if f.polarity < 0 else v


# ─────────────────────────────────────────────────────────────────────────────
# 3. КОМПОЗИТНІ ІНДЕКСИ
# ─────────────────────────────────────────────────────────────────────────────

def day_indices(day: dict) -> dict[str, float | None]:
    """Доба (плоский dict сирих полів) -> {індекс: 0..1 | None}.

    Ключове: ваги ПЕРЕНОРМОВУЮТЬСЯ на присутні поля. Чек-ін заповнюється
    нерівно (вечір частіше порожній), і без перенормування доба з одним
    заповненим полем давала б індекс, поділений на повну суму ваг, тобто
    систематично занижений. Це не косметика — це різниця між «мало даних»
    і «поганий день».
    """
    out = {}
    for idx in INDICES:
        num = den = 0.0
        seen = 0
        for f in FIELDS:
            if f.index != idx:
                continue
            v = normalize(f, day.get(f.name))
            if v is None:
                continue
            num += v * f.weight
            den += f.weight
            seen += 1
        out[idx] = (num / den) if seen >= MIN_FIELDS_PER_INDEX and den > 0 else None
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 4. ВАГИ, ЩО ВЧАТЬСЯ (ridge)
#
# Суть: НЕ ми вирішуємо, що для власника «хороший день», а його власні оцінки
# dayScore. Ridge-регресія 5 індексів -> dayScore каже, з чого САМЕ в цієї
# людини складається оцінка дня. У JS це 5x5 система — розвʼязується Гаусом
# у ~40 рядків, без матбібліотек.
# ─────────────────────────────────────────────────────────────────────────────

def fit_weights(rows: list[tuple[dict[str, float | None], float]]):
    """[(індекси доби, dayScore)] -> {weights, r2, n, learned}.

    Беремо лише доби, де ПОВНИЙ набір 5 індексів і є dayScore: часткові рядки
    зробили б коефіцієнти непорівнюваними між собою.
    """
    full = [(ix, sc) for ix, sc in rows if all(ix[i] is not None for i in INDICES) and sc is not None]
    prior = {i: 1.0 / len(INDICES) for i in INDICES}
    if len(full) < MIN_DAYS_FOR_FIT:
        return {"weights": prior, "r2": None, "n": len(full), "learned": False}

    X = np.array([[ix[i] for i in INDICES] for ix, _ in full], dtype=float)
    y = np.array([(sc - 1.0) / 4.0 for _, sc in full], dtype=float)  # dayScore 1..5 -> 0..1

    Xm, ym = X.mean(0), y.mean()
    # СТАНДАРТИЗАЦІЯ, не саме центрування: ridge штрафує коефіцієнти, тож без
    # спільного масштабу предиктор із меншим розкидом дістає більший β і
    # сильніший штраф — регуляризація починає залежати від рівності виміру, а
    # не від його важливості.
    sd = X.std(0, ddof=1)
    sd = np.where(sd > 1e-9, sd, 1.0)
    Xz = (X - Xm) / sd
    yc = y - ym
    ss_tot = float((yc ** 2).sum())
    rows = Xz.shape[0]

    gram = Xz.T @ Xz
    rhs = Xz.T @ yc

    def fit_at(lam: float):
        """Підгонка при заданій λ + LOO-CV у ЗАМКНУТІЙ формі.

        PRESS через діагональ капелюшної матриці: залишок відкинутої доби
        дорівнює e/(1-h), тож перенавчати `rows` разів не треба. 1/rows у h —
        внесок вільного члена, знятого центруванням.
        """
        A = gram + lam * np.eye(len(INDICES))
        beta = np.linalg.solve(A, rhs)
        Ainv = np.linalg.inv(A)
        h = 1.0 / rows + np.einsum("ij,jk,ik->i", Xz, Ainv, Xz)
        e = yc - Xz @ beta
        # Клемп ЗНИЗУ, не фолбек на e: при h -> 1 підстановка самого залишку
        # робила б штраф НАЙМЕНШИМ саме для доби, яку підгонка «вивчила
        # напамʼять» — помилка в бік оптимізму там, де CV мусить бути суворим.
        denom = np.maximum(1.0 - h, 1e-6)
        press = float(((e / denom) ** 2).sum())
        return {"lambda": lam, "beta": beta, "ss_res": float((e ** 2).sum()), "press": press}

    best = min((fit_at(l) for l in RIDGE_GRID), key=lambda c: c["press"])
    beta, lam = best["beta"], best["lambda"]

    r2 = 1.0 - best["ss_res"] / ss_tot if ss_tot > 1e-12 else None
    # CV-R² може бути ВІДʼЄМНИМ — це не помилка, а «передбачає гірше за
    # середнє». Обрізати до нуля означало б сховати єдиний випадок, коли
    # моделі не варто вірити.
    r2cv = 1.0 - best["press"] / ss_tot if ss_tot > 1e-12 else None

    # Коефіцієнти — у ВИХІДНОМУ масштабі індексів, інакше intercept поїде.
    beta_raw = beta / sd
    mag = np.abs(beta_raw)
    share = mag / mag.sum() if mag.sum() > 1e-12 else np.full(len(INDICES), 1 / len(INDICES))
    return {
        "weights": {i: float(s) for i, s in zip(INDICES, share)},
        "beta": {i: float(b) for i, b in zip(INDICES, beta_raw)},
        # Знак окремо від величини: смуги показують ВАГУ, рахунок мусить знати
        # НАПРЯМОК. Доти знак губився в abs, і вимір, що тягне день униз,
        # підіймав «Індекс дня».
        "signs": {i: (-1 if b < 0 else 1) for i, b in zip(INDICES, beta_raw)},
        "intercept": float(ym - Xm @ beta_raw),
        "lambda": float(lam),
        "r2": r2,
        "r2cv": r2cv,
        "n": len(full),
        "learned": True,
    }


def day_index_score(ix: dict[str, float | None], weights: dict[str, float],
                    signs: dict[str, int] | None = None) -> float | None:
    """5 індексів + ваги -> «Індекс дня» 0..100. Ваги перенормовуються на наявні.

    ЗНАК МАЄ ЗНАЧЕННЯ: ваги — це |β|/Σ|β|, чиста величина внеску. Якщо у виміру
    відʼємний коефіцієнт (більше — гірший день), у середнє входить його
    ДОПОВНЕННЯ; інакше високе значення шкідливого виміру підіймало б оцінку.
    """
    num = den = 0.0
    for i in INDICES:
        if ix.get(i) is None:
            continue
        v = 1.0 - ix[i] if signs and signs.get(i, 1) < 0 else ix[i]
        num += v * weights[i]
        den += weights[i]
    return round(100 * num / den, 1) if den > 0 else None


def indices_present(ix: dict[str, float | None]) -> int:
    """Скільки з пʼяти індексів доба реально дає."""
    return sum(1 for i in INDICES if ix.get(i) is not None)


# ─────────────────────────────────────────────────────────────────────────────
# 5. ДРАЙВЕРИ — ефект розміру, не «середнє вище»
#
# Cohen's d, а не гола різниця середніх: різниця 0.4 при розкиді 0.3 і при
# розкиді 2.0 — це два різні світи, а в UI обидві виглядали б однаково.
#
# Значущість — Welch's t-test (НЕ перестановочний тест, як у першій версії):
# перестановки вимагають PRNG, а PRNG-послідовність не переноситься між
# Python (numpy) і JS біт-у-біт — золоті вектори тоді ніколи не збіглися б.
# Welch не передбачає рівних дисперсій (кошики різного розміру) і рахується
# в замкнутій формі — той самий результат в обох мовах, без жодного seed.
# ─────────────────────────────────────────────────────────────────────────────

def cohens_d(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return 0.0
    sa, sb = a.var(ddof=1), b.var(ddof=1)
    pooled = math.sqrt(((na - 1) * sa + (nb - 1) * sb) / (na + nb - 2))
    return float((a.mean() - b.mean()) / pooled) if pooled > 1e-9 else 0.0


def welch_p(a: np.ndarray, b: np.ndarray) -> float:
    _, p = stats.ttest_ind(a, b, equal_var=False)
    return float(p)


def drivers(days: list[dict], target: str = "dayScore") -> list[dict]:
    """Кожне бінаризовне поле -> вплив на цільову оцінку, відсортовано за |d|.

    Один генеричний прохід замість рукописної картки на поле: додав поле в
    реєстр -> воно САМО зʼявляється в аналізі, коли набереться вибірка.
    """
    out = []
    for f in FIELDS:
        hi, lo = [], []
        for d in days:
            t = d.get(target)
            v = normalize(f, d.get(f.name))
            if t is None or v is None:
                continue
            if v >= 0.75:
                hi.append(t)
            elif v <= 0.25:
                lo.append(t)
        if len(hi) < MIN_N_PER_BUCKET or len(lo) < MIN_N_PER_BUCKET:
            continue
        a, b = np.array(hi, float), np.array(lo, float)
        out.append({
            "field": f.name,
            "index": f.index,
            "delta": round(float(a.mean() - b.mean()), 2),
            "d": round(cohens_d(a, b), 2),
            "p": round(welch_p(a, b), 4),
            "nHigh": len(hi),
            "nLow": len(lo),
        })
    _apply_bh(out)
    return sorted(out, key=lambda r: -abs(r["d"]))


BH_ALPHA = 0.05


def _apply_bh(rows: list[dict]) -> None:
    """Поправка Бенʼяміні-Хохберга на МНОЖИННІ порівняння — на місці.

    Драйверів десятки, кожен перевіряється власним тестом при p<0.05: на 25
    полях приблизно один «значущий» результат очікується ЧИСТО ВИПАДКОВО, тобто
    підпис «значущо» на найгучнішому рядку був майже гарантований навіть на
    шумі. BH контролює частку хибних відкриттів у всій родині.

    Не Бонферроні: той при 25 порівняннях вимагав би p<0.002 і не пропустив би
    нічого, крім найгрубіших ефектів — для розвідки власних даних надто суворо.

    q рахується монотонно з кінця: інакше крок BH міг би оголосити значущим
    рядок із БІЛЬШИМ p, ніж у визнаного незначущим сусіда.
    """
    m = len(rows)
    if not m:
        return
    order = sorted(range(m), key=lambda i: rows[i]["p"])
    running = 1.0
    for k in range(m - 1, -1, -1):
        row = rows[order[k]]
        running = min(running, (m / (k + 1)) * row["p"])
        row["q"] = round(running, 4)
        row["passesBH"] = running <= BH_ALPHA


# ─────────────────────────────────────────────────────────────────────────────
# 6. ЛАГОВІ ЗВʼЯЗКИ — єдине, що дивиться на ЗАВТРА
#
# Дизайн daily-diary досліджень: відновлення ввечері передбачає завтрашню
# залученість. Уся наявна статистика застосунку — виключно всередині доби,
# тож цей блок відповідає на питання, на яке зараз не відповідає ніщо.
# Spearman, бо шкали 1..5 порядкові, а не інтервальні.
# ─────────────────────────────────────────────────────────────────────────────

def lagged(days: list[dict], src_index: str, target: str = "dayScore") -> dict | None:
    xs, ys = [], []
    for today, tomorrow in zip(days, days[1:]):
        v = day_indices(today).get(src_index)
        t = tomorrow.get(target)
        if v is not None and t is not None:
            xs.append(v)
            ys.append(t)
    if len(xs) < MIN_N_PER_BUCKET * 2:
        return {"ready": False, "n": len(xs), "needed": MIN_N_PER_BUCKET * 2}
    rho, p = stats.spearmanr(xs, ys)
    return {"ready": True, "n": len(xs), "rho": round(float(rho), 3), "p": round(float(p), 4),
            "src": src_index, "target": target}


# ─────────────────────────────────────────────────────────────────────────────
# 7. АРХЕТИПИ ДНІВ — k-means на 5-вимірних векторах
#
# Замість «середній день» (якого не існує) — 3-4 ТИПИ днів із частотою.
# Ініціалізація — ДЕТЕРМІНОВАНА (maxmin farthest-point), не k-means++ із PRNG:
# перший центр — найближча до загального середнього доба (найбільш «типова»),
# кожен наступний — доба, що максимізує мінімальну відстань до вже обраних
# центрів. Без жодного seed, тому Python і JS дають ІДЕНТИЧНИЙ результат
# (з точністю до плаваючої коми), а не «схожий у межах випадковості».
# ─────────────────────────────────────────────────────────────────────────────

def _farthest_point_init(Xs: np.ndarray, k: int) -> np.ndarray:
    n = len(Xs)
    mean = Xs.mean(0)
    first = int(np.argmin(((Xs - mean) ** 2).sum(1)))
    chosen = [first]
    dist = ((Xs - Xs[first]) ** 2).sum(1)
    for _ in range(k - 1):
        nxt = int(np.argmax(dist))
        chosen.append(nxt)
        dist = np.minimum(dist, ((Xs - Xs[nxt]) ** 2).sum(1))
    return Xs[chosen].copy()


def archetypes(days: list[dict], k: int = 4) -> dict:
    V = [[ix[i] for i in INDICES] for ix in (day_indices(d) for d in days)
         if all(ix[i] is not None for i in INDICES)]
    if len(V) < k * 5:
        return {"ready": False, "n": len(V), "needed": k * 5}
    X = np.array(V, float)
    Xs = (X - X.mean(0)) / np.where(X.std(0) < 1e-9, 1.0, X.std(0))

    C = _farthest_point_init(Xs, k)
    for _ in range(60):
        lab = np.argmin(((Xs[:, None, :] - C[None, :, :]) ** 2).sum(-1), axis=1)
        newC = np.array([Xs[lab == j].mean(0) if (lab == j).any() else C[j] for j in range(k)])
        if np.allclose(newC, C, atol=1e-9):
            break
        C = newC

    groups = []
    for j in range(k):
        m = lab == j
        if not m.any():
            continue
        prof = X[m].mean(0)
        groups.append({
            "n": int(m.sum()),
            "share": round(float(m.mean()), 3),
            "profile": {i: round(float(v), 3) for i, v in zip(INDICES, prof)},
            "top": INDICES[int(np.argmax(prof))],
            "low": INDICES[int(np.argmin(prof))],
        })
    return {"ready": True, "k": k, "n": len(V), "groups": sorted(groups, key=lambda g: -g["n"])}


# ─────────────────────────────────────────────────────────────────────────────
# 8. СИНТЕТИКА — щоб пайплайн можна було ганяти без вивантаження реального KV
#
# Латентний сигнал закладений НАВМИСНО (сон -> енергія -> вихлоп -> оцінка):
# без нього неможливо відрізнити «модель не працює» від «у даних нема звʼязку».
# ─────────────────────────────────────────────────────────────────────────────

def synth(n: int = 120, seed: int = 42) -> list[dict]:
    rng = np.random.default_rng(seed)
    days, carry = [], 0.0
    for _ in range(n):
        sleep = float(np.clip(rng.normal(7.0, 1.3), 3.5, 10.5))
        base = sleep_hours_score(sleep)
        rec = float(np.clip(base * 0.7 + carry * 0.3 + rng.normal(0, 0.12), 0, 1))
        en = int(np.clip(round(1 + 4 * (rec * 0.8 + rng.normal(0, 0.15))), 1, 5))
        mo = int(np.clip(round(1 + 4 * (rec * 0.6 + rng.normal(0, 0.2))), 1, 5))
        outp = int(np.clip(round(1 + 4 * (rec * 0.55 + rng.normal(0, 0.22))), 1, 5))
        auto = int(np.clip(round(rng.normal(3.4, 1.0)), 1, 5))
        rum = int(np.clip(round(6 - 4 * rec + rng.normal(0, 0.9)), 1, 5))
        score = int(np.clip(round(1 + 4 * (0.42 * rec + 0.30 * (outp - 1) / 4 + 0.18 * (auto - 1) / 4
                                           + rng.normal(0, 0.10))), 1, 5))
        # sleepKind корелює зі сном: короткі ночі частіше «дрімав», зовсім
        # погані — «не спав». Без цієї залежності золоті вектори перевіряли б
        # поле, яке ні на що не схоже в реальних даних.
        if sleep < 4.5:
            kind = rng.choice(["none", "naps", "slept"], p=[.35, .45, .20])
        elif sleep < 6.0:
            kind = rng.choice(["naps", "slept"], p=[.35, .65])
        else:
            kind = "slept"
        days.append({
            "sleepKind": kind,
            "sleepH": round(sleep, 1),
            "sleepQ": int(np.clip(round(1 + 4 * base + rng.normal(0, 0.5)), 1, 5)),
            "sleepLatency": rng.choice(["fast", "mid", "slow", "vslow"], p=[.4, .3, .2, .1]),
            "bedtime": rng.choice(["e23", "e00", "e01", "e02", "late"], p=[.2, .3, .25, .15, .1]),
            "detached": rng.choice(["no", "partly", "yes"], p=[.25, .4, .35]),
            "rumination": rum,
            "screen": rng.choice(["low", "mid", "high", "vhigh"], p=[.2, .4, .3, .1]),
            "caffeine": int(rng.integers(0, 5)),
            "energy@morning": en,
            "energy@afternoon": int(np.clip(en + rng.integers(-1, 1), 1, 5)),
            "energy@evening": int(np.clip(en - 1 + rng.integers(0, 2), 1, 5)),
            "mood@morning": mo,
            "mood@afternoon": int(np.clip(mo + rng.integers(-1, 2), 1, 5)),
            "mood@evening": int(np.clip(mo + rng.integers(-1, 1), 1, 5)),
            "worryAM": int(np.clip(round(rng.normal(2.6, 1.0)), 1, 5)),
            "rushed": int(np.clip(round(rng.normal(3.0, 1.0)), 1, 5)),
            "interrupted": rng.choice(["none", "few", "many"], p=[.3, .45, .25]),
            "output": outp,
            "focusQuality": int(np.clip(outp + rng.integers(-1, 2), 1, 5)),
            "effort": int(np.clip(round(rng.normal(3.3, 1.0)), 1, 5)),
            "kept": rng.choice(["no", "partly", "changed", "yes"], p=[.15, .35, .15, .35]),
            "pace": rng.choice(["overload", "behind", "other", "on", "better"], p=[.1, .25, .15, .4, .1]),
            "jobProgress": int(np.clip(round(rng.normal(3.0, 1.1)), 1, 5)),
            # Прогрес на обід тягнеться за вечірнім результатом — інакше пара
            # «половина до обіду -> кращий вечір» не мала б у синтетиці сигналу.
            "mainProgress": ["none", "started", "half", "most"][int(np.clip(round((outp - 1) / 4 * 3 + rng.normal(0, 0.6)), 0, 3))],
            "autonomy": auto,
            # План — до 2 категорій, тож частка може бути лише 0, 0.5 або 1.
            # ⚠️ Доти генератор давав самі 0/1, і золоті вектори перевіряли
            # тільки КІНЦІ шкали — проміжне значення жоден тест не проходив.
            "intentMatch": float(rng.choice([0.0, 0.5, 1.0], p=[.30, .25, .45])),
            "jobConfidence": int(np.clip(round(rng.normal(3.2, 1.0)), 1, 5)),
            "dayControl": int(np.clip(round(auto + rng.normal(0, 0.9)), 1, 5)),
            "movePlan": rng.choice(["none", "light", "workout"], p=[.35, .45, .20]),
            "outdoorNow": rng.choice(["none", "short", "long"], p=[.3, .5, .2]),
            "moved": rng.choice(["none", "light", "active", "workout"], p=[.35, .35, .10, .20]),
            "outdoor": rng.choice(["none", "short", "long"], p=[.3, .45, .25]),
            "dayScore": score,
        })
        carry = rec
    return days


# ─────────────────────────────────────────────────────────────────────────────
# 9. ЗВІТ І ЗОЛОТІ ВЕКТОРИ
# ─────────────────────────────────────────────────────────────────────────────

def analyze(days: list[dict]) -> dict:
    idx = [day_indices(d) for d in days]
    fit = fit_weights(list(zip(idx, [d.get("dayScore") for d in days])))
    # ГЕЙТ ПОКРИТТЯ — найбільше джерело хибного прочитання блоку. «Індекс дня»
    # перенормовує ваги на НАЯВНІ індекси, тож о 09:00 доступні щонайбільше два
    # виміри, і «92» означало «я виспався», а виглядало як підсумок доби.
    cover = [indices_present(i) for i in idx]
    scores = [
        day_index_score(i, fit["weights"], fit.get("signs")) if c >= MIN_INDICES_FOR_SCORE else None
        for i, c in zip(idx, cover)
    ]
    valid = [s for s in scores if s is not None]
    return {
        "n": len(days),
        "fit": fit,
        "dayIndex": {
            "last": scores[-1] if scores else None,
            "mean": round(float(np.mean(valid)), 1) if valid else None,
            "lastCoverage": cover[-1] if cover else 0,
            "needCoverage": MIN_INDICES_FOR_SCORE,
            "scored": len(valid),
        },
        "drivers": drivers(days),
        "lagged": {i: lagged(days, i) for i in (RECOVERY, BODY)},
        "archetypes": archetypes(days),
    }


def emit_golden(path: Path) -> dict:
    """Золоті вектори для JS-тесту: фіксована синтетика -> очікувані числа."""
    days = synth(120, seed=42)
    res = analyze(days)
    payload = {
        "_readme": "Згенеровано research/checkin_model.py --emit-golden. НЕ редагувати руками.",
        "fieldOrder": [f.name for f in FIELDS],
        "constants": {
            "MIN_FIELDS_PER_INDEX": MIN_FIELDS_PER_INDEX,
            "MIN_DAYS_FOR_FIT": MIN_DAYS_FOR_FIT,
            "MIN_N_PER_BUCKET": MIN_N_PER_BUCKET,
            "MIN_INDICES_FOR_SCORE": MIN_INDICES_FOR_SCORE,
            "RIDGE_GRID": RIDGE_GRID,
        },
        # Точкові перевірки нормалізації — найдешевший спосіб зловити розʼїзд
        # полярності/кривої сну в порті.
        "normalize": [
            {"field": f.name, "raw": raw, "want": normalize(f, raw)}
            for f, raw in (
                (FIELDS[FIELD_INDEX["sleepH"]], 8.0),
                (FIELDS[FIELD_INDEX["sleepH"]], 5.0),
                (FIELDS[FIELD_INDEX["sleepH"]], 11.0),
                (FIELDS[FIELD_INDEX["rumination"]], 5),
                (FIELDS[FIELD_INDEX["bedtime"]], "late"),
                (FIELDS[FIELD_INDEX["moved"]], "workout"),
                # 'active' — рівень, якого моделі бракувало (B5): пінимо його
                # позицію (1/3 між light і workout), щоб порт не «повернувся»
                # до трирівневої шкали непомітно.
                (FIELDS[FIELD_INDEX["moved"]], "active"),
                # Легасі pace:"off" — свідомо None, а не здогадка (legacy_unscored).
                (FIELDS[FIELD_INDEX["pace"]], "off"),
                (FIELDS[FIELD_INDEX["kept"]], "changed"),
            )
        ],
        # Увесь набір, не зразок: fit/drivers/archetypes/lagged рахуються на
        # ВСІХ 120 добах, тож JS-тест мусить дістати той самий вхід, а не
        # відтворювати synth() власним (неминуче іншим) PRNG.
        "days": days,
        "sampleIndices": [day_indices(d) for d in days[:3]],
        "fit": res["fit"],
        "dayIndex": res["dayIndex"],
        "drivers": res["drivers"],
        "lagged": res["lagged"],
        "archetypes": res["archetypes"],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n" + фінальний перенос: файл комітиться в репо, де його чекає
    # prettier --check. Без явного newline Windows писав би CRLF (Path.write_text
    # транслює переноси за платформою), і `npm run format:check` червонів би —
    # причому лише в того, хто регенерував на Windows.
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return payload


def main() -> None:
    # Консоль Windows за замовчуванням cp1251 і давиться на «²»/кирилиці у
    # звіті. Друк — не сама модель, тож просто змушуємо потік у UTF-8.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="Референсна модель «Індекс дня»")
    ap.add_argument("--emit-golden", action="store_true", help="записати золоті вектори для JS-тесту")
    ap.add_argument("--days", type=int, default=120)
    args = ap.parse_args()

    if args.emit_golden:
        out = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "checkin-golden.json"
        emit_golden(out)
        print(f"golden -> {out}")
        return

    res = analyze(synth(args.days))
    fit = res["fit"]
    print(f"\n=== ІНДЕКС ДНЯ · {res['n']} діб ===")
    print(f"останній {res['dayIndex']['last']} · середній {res['dayIndex']['mean']}")
    print(f"\nваги вивчені: {fit['learned']} (n={fit['n']}, R²={fit['r2']:.3f})" if fit["learned"]
          else f"\nваги апріорні (n={fit['n']})")
    for i in INDICES:
        print(f"  {INDEX_LABEL[i]:<13} {fit['weights'][i] * 100:5.1f}%")

    print("\n=== ДРАЙВЕРИ (топ-6 за |d|) ===")
    for r in res["drivers"][:6]:
        sig = "*" if r["p"] < 0.05 else " "
        print(f" {sig} {r['field']:<18} Δ{r['delta']:+.2f}  d={r['d']:+.2f}  p={r['p']:.3f}  n={r['nHigh']}/{r['nLow']}")

    print("\n=== ЛАГ: сьогодні -> ЗАВТРА ===")
    for k, v in res["lagged"].items():
        if v and v.get("ready"):
            print(f"  {INDEX_LABEL[k]:<13} rho={v['rho']:+.3f} p={v['p']:.4f} n={v['n']}")
        else:
            print(f"  {INDEX_LABEL[k]:<13} ще рано (n={v['n']}/{v['needed']})")

    a = res["archetypes"]
    print("\n=== АРХЕТИПИ ДНІВ ===")
    if a.get("ready"):
        for g in a["groups"]:
            print(f"  {g['share'] * 100:4.1f}%  n={g['n']:<3} сильне: {INDEX_LABEL[g['top']]:<13} слабке: {INDEX_LABEL[g['low']]}")
    else:
        print(f"  ще рано (n={a['n']}/{a['needed']})")
    print()


if __name__ == "__main__":
    main()
