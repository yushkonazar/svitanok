"""Референсна модель «Важелі» — вивідник математики й тест-оракул.

⚠️ ЦЕЙ ФАЙЛ НЕ ЇДЕ В ПРОД, як і checkin_model.py поруч. Воркер — JS
(Cloudflare Workers), Python там не виконується. Роль файлу:

  1. СПЕЦИФІКАЦІЯ — математика в читабельному вигляді. Порт у JS
     (web/levers-core.mjs) мусить давати ТІ САМІ числа.
  2. ОРАКУЛ — `python levers_model.py --emit-golden` пише золоті вектори
     у tests/fixtures/levers-golden.json; JS-тест звіряється з ними.
  3. ПІСОЧНИЦЯ — `--measure` проганяє контроль рівня помилки й потужності.

Запуск:
  python research/levers_model.py                # демо на синтетиці
  python research/levers_model.py --emit-golden
  python research/levers_model.py --measure      # контроль (довго, ~2 хв)

──────────────────────────────────────────────────────────────────────────────
ЧОМУ САМЕ ТАКА МАТЕМАТИКА (замір 21.08.2026, .workspace/StatsRevision/
levers-method-measurement-2026-08-21.md)

Наївний перебір пар із ранговою кореляцією на ТИЖНЕВИХ рядах бреше: тижні
автокорельовані, а p рахується так, ніби вони незалежні. Заміряно: 33 хибні
«відкриття» зі 156 навіть із поправкою Беньяміні-Хохберга.

Заміряні ліки й чому обрано саме перетин:

  · перші різниці обох рядів — лікують автокореляцію, але ПЕРЕЛІКОВУЮТЬ її
    на майже білому ряді (diff білого шуму дає ACF(1) = -0.5, та сама хвороба
    дзеркально). Самі по собі: 20-29% тижнів із хибним рядком, НА БУДЬ-ЯКОМУ N.
  · поправка ефективного N (Кенʼєлл-Квенуй) — чиста на білих рядах, але сліпа
    до слабких звʼязків від автокорельованого драйвера.
  · ПЕРЕТИН (AND) — рядок показуємо, лише якщо пара витримала BH і на різницях,
    І на eff-N. Заміряно 0-4% тижнів із хибним рядком на всіх N, тобто в межах
    обіцянки q=0.10, і потужність не гірша за слабший із двох методів.

⚠️ Дві речі, які в JS уже правильні й тут МУСЯТЬ бути такими самими, інакше
золоті вектори порівнюватимуть різну математику:
  · ранги з УСЕРЕДНЕННЯМ при звʼязках (scipy method='average'). Тижневі ряди
    дискретні (енергія 1-5, вогники 0-5, лічильники) — наївні ранги через
    подвійний argsort дали б rho, що залежить від порядку тижнів.
  · p через t-розподіл, не нормальне наближення. При n=13 нормальне дає
    рівень помилки 8.3% замість 5%.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from scipy import stats

# ─────────────────────────────────────────────────────────────────────────────
# 1. РЕЄСТР ТИЖНЕВИХ ОЗНАК
#
# Порядок — контракт із JS (золоті вектори позиційні): НЕ переставляти, лише
# дописувати в кінець. `agg` описує, як тижнева згортка робиться зі стору;
# сам збір — у JS (web/levers-core.mjs), тут лише назва й домен, бо оракул
# отримує вже готові ряди.
# ─────────────────────────────────────────────────────────────────────────────

RECOVERY, AFFECT, HABITS, LEARNING, SEARCH, ATTENTION = (
    "recovery", "affect", "habits", "learning", "search", "attention",
)

FEATURES = [
    ("sleep", RECOVERY),        # середні години сну за тиждень
    ("energy", AFFECT),         # середня енергія по всіх слотах
    ("mood", AFFECT),           # середній настрій
    ("dayScore", AFFECT),       # середня оцінка дня
    ("flames", HABITS),         # середня кількість вогників за вечір
    ("mock", LEARNING),         # відповіді на питання за тиждень
    ("roadmap", LEARNING),      # тем роадмепу позначено за тиждень
    ("applied", SEARCH),        # подач за тиждень
    ("funnelMoves", SEARCH),    # переходів стадії за тиждень
    ("news", ATTENTION),        # прочитаних новин за тиждень
    ("opens", ATTENTION),       # відкриттів застосунку за тиждень
]
FEATURE_KEYS = [k for k, _ in FEATURES]
DOMAIN_OF = dict(FEATURES)

# ─────────────────────────────────────────────────────────────────────────────
# 2. КУРОВАНИЙ СПИСОК ГІПОТЕЗ
#
# ⚠️ НЕ декартів добуток. BH ділить бюджет помилки на кількість гіпотез, тож
# кожна пара, яку ти не збирався перевіряти, зʼїдає чутливість тих, які
# збирався. Заміряно: скорочення зі 156 пар до ~24 ПОДВОЮЄ потужність при
# N = 26...52 (44% проти 19% на 26 тижнях) і не додає хибних рядків.
#
# Критерій включення один: чи можна з цього рядка щось ЗРОБИТИ. «Сон -> подачі»
# веде до рішення; «новини -> вогники» — ні, навіть якби витримало поправку.
#
# lag=1 — «наступного тижня», lag=0 — «того ж тижня». Лаг лежить у гіпотезі, а
# не в модулі, бо в списку співіснують обидва види.
# ─────────────────────────────────────────────────────────────────────────────

HYPOTHESES = [
    # відновлення -> вихід
    ("sleep", "applied", 1),
    ("sleep", "mock", 1),
    ("sleep", "roadmap", 1),
    ("sleep", "energy", 1),
    ("sleep", "dayScore", 0),
    # звички -> відновлення й вихід
    ("flames", "sleep", 1),
    ("flames", "energy", 1),
    ("flames", "roadmap", 1),
    # афект -> вихід
    ("energy", "applied", 1),
    ("energy", "roadmap", 1),
    ("mood", "applied", 1),
    ("mood", "funnelMoves", 1),
    # робота -> самопочуття (зворотний бік: чи виснажує)
    ("applied", "energy", 1),
    ("applied", "mood", 1),
    ("applied", "sleep", 1),
    ("roadmap", "dayScore", 0),
    ("roadmap", "mood", 1),
    ("mock", "dayScore", 0),
    # рух воронки -> афект
    ("funnelMoves", "mood", 1),
    ("funnelMoves", "dayScore", 0),
    # увага -> вихід і назад
    ("news", "applied", 1),
    ("opens", "roadmap", 1),
    ("opens", "applied", 1),
    ("applied", "funnelMoves", 1),
]

# ─────────────────────────────────────────────────────────────────────────────
# 3. КОНСТАНТИ
# ─────────────────────────────────────────────────────────────────────────────

Q = 0.10                    # рівень BH (частка хибних серед показаних)
MIN_PAIR_N = 10             # менше точок після вирівнювання — пара не рахується
GATE_WEEKS = 26             # нижче — блок каже «потрібно ще N тижнів»
USEFUL_WEEKS = 39           # заміряна межа, з якої блок починає бути корисним
MIN_CHECKIN_DAYS = 3        # діб чек-іну, щоб тиждень вважався придатним
MAX_MODE_SHARE = 0.5        # ряд, де одне значення займає >половини тижнів, — не ряд
MIN_DISTINCT = 4            # і де менше стількох різних значень — теж


# ─────────────────────────────────────────────────────────────────────────────
# 4. МАТЕМАТИКА
# ─────────────────────────────────────────────────────────────────────────────

def ranks(xs: list[float]) -> np.ndarray:
    """Ранги з усередненням при звʼязках — те саме, що ranks() у JS."""
    return stats.rankdata(np.asarray(xs, float), method="average")


def spearman(xs: list[float], ys: list[float], n_eff: float | None = None):
    """rho + двобічне p. n_eff підмінює лише ЗНАМЕННИК свободи, не сам rho."""
    n = len(xs)
    rx, ry = ranks(xs), ranks(ys)
    rx = rx - rx.mean()
    ry = ry - ry.mean()
    denom = math.sqrt(float((rx**2).sum()) * float((ry**2).sum()))
    rho = float(rx @ ry / denom) if denom > 1e-12 else 0.0
    nn = n if n_eff is None else n_eff
    if nn <= 2 or abs(rho) >= 1:
        return rho, (0.0 if abs(rho) >= 1 else 1.0)
    t = rho * math.sqrt((nn - 2) / max(1e-12, 1 - rho * rho))
    return rho, float(2 * stats.t.sf(abs(t), df=nn - 2))


def acf1(xs: list[float]) -> float:
    """Автокореляція лагу 1 — те, наскільки тиждень схожий на попередній."""
    x = np.asarray(xs, float)
    x = x - x.mean()
    d = float((x**2).sum())
    return float((x[:-1] * x[1:]).sum() / d) if d > 1e-12 else 0.0


def eff_n(xs: list[float], ys: list[float]) -> float:
    """Кенʼєлл-Квенуй: N_eff = N * (1 - r1x*r1y) / (1 + r1x*r1y).

    Скільки НЕЗАЛЕЖНОЇ інформації насправді в двох автокорельованих рядах.
    Затиснуто в [4, N]: від'ємний добуток автокореляцій дав би N_eff > N,
    тобто більше інформації, ніж є спостережень."""
    a, b = acf1(xs), acf1(ys)
    f = (1 - a * b) / (1 + a * b + 1e-12)
    return max(4.0, len(xs) * min(1.0, max(0.05, f)))


def bh_keep(pvals: list[float], q: float = Q) -> list[bool]:
    """Беньяміні-Хохберг: які гіпотези лишаються при частці хибних <= q."""
    m = len(pvals)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: pvals[i])
    thr = 0
    for rank_i, idx in enumerate(order, start=1):
        if pvals[idx] <= q * rank_i / m:
            thr = rank_i
    keep = [False] * m
    for rank_i, idx in enumerate(order, start=1):
        if rank_i <= thr:
            keep[idx] = True
    return keep


# ─────────────────────────────────────────────────────────────────────────────
# 5. ВИРІВНЮВАННЯ ПАРИ
#
# Ряди мають діри: тиждень без чек-іну — None, а не нуль. Дві вибірки:
#   · рівнева — беремо тижні, де присутні обидва кінці пари;
#   · різницева — беремо лише СУСІДНІ присутні тижні, бо різниця через діру
#     означала б «зміну за два тижні», а це вже інша величина.
# ─────────────────────────────────────────────────────────────────────────────

def level_samples(drv, tgt, lag):
    xs, ys = [], []
    for i in range(len(drv) - lag):
        a, b = drv[i], tgt[i + lag]
        if a is not None and b is not None:
            xs.append(float(a))
            ys.append(float(b))
    return xs, ys


def diff_samples(drv, tgt, lag):
    xs, ys = [], []
    for i in range(1, len(drv) - lag):
        a0, a1 = drv[i - 1], drv[i]
        b0, b1 = tgt[i + lag - 1], tgt[i + lag]
        if None not in (a0, a1, b0, b1):
            xs.append(float(a1) - float(a0))
            ys.append(float(b1) - float(b0))
    return xs, ys


def mode_share(xs: list[float]) -> float:
    if not xs:
        return 1.0
    vals, counts = np.unique(np.asarray(xs, float), return_counts=True)
    return float(counts.max() / len(xs))


def series_usable(xs) -> tuple[bool, str]:
    """Чи має ряд достатньо варіативності, щоб рангова кореляція щось значила.

    ⚠️ Це не косметика. Заміряно: розріджений лічильник (0.7 події на тиждень,
    49% нульових тижнів) зрізає спостережуваний |rho| з 0.75 до 0.20 — такий
    звʼязок не побачити НІ ЗА ЯКОГО N. Ряд треба виключати чесно, а не мовчки
    показувати «звʼязку не знайдено»."""
    vals = [v for v in xs if v is not None]
    if len(vals) < MIN_PAIR_N:
        return False, "мало тижнів"
    if len(set(vals)) < MIN_DISTINCT:
        return False, "майже стале значення"
    if mode_share(vals) > MAX_MODE_SHARE:
        return False, "одне значення в більшості тижнів"
    return True, ""


def contrast(drv, tgt, lag):
    """Читабельний ефект: «12 проти 6». Медіанний спліт драйвера -> середні цілі."""
    return contrast_of(level_samples(drv, tgt, lag))


def contrast_of(samples):
    """Те саме на ВЖЕ вирівняній вибірці — дзеркало contrastOf() у JS-порті."""
    xs, ys = samples
    if len(xs) < MIN_PAIR_N:
        return None
    med = float(np.median(xs))
    hi = [y for x, y in zip(xs, ys) if x > med]
    lo = [y for x, y in zip(xs, ys) if x <= med]
    if len(hi) < 3 or len(lo) < 3:
        return None
    mh, ml = float(np.mean(hi)), float(np.mean(lo))
    vh = float(np.var(hi, ddof=1)) if len(hi) > 1 else 0.0
    vl = float(np.var(lo, ddof=1)) if len(lo) > 1 else 0.0
    pooled = math.sqrt(((len(hi) - 1) * vh + (len(lo) - 1) * vl) / (len(hi) + len(lo) - 2))
    d = (mh - ml) / pooled if pooled > 1e-9 else 0.0
    return {"high": round(mh, 2), "low": round(ml, 2), "nHigh": len(hi), "nLow": len(lo),
            "d": round(d, 3)}


# ─────────────────────────────────────────────────────────────────────────────
# 6. АНАЛІЗ
# ─────────────────────────────────────────────────────────────────────────────

def analyze(series: dict[str, list], weeks_usable: int, hypotheses=None) -> dict:
    """series: ключ -> список довжиною = число тижнів, None там, де немає даних."""
    hyps = HYPOTHESES if hypotheses is None else hypotheses

    skipped = []
    usable_key = {}
    for key in FEATURE_KEYS:
        ok, why = series_usable(series.get(key, []))
        usable_key[key] = ok
        if not ok:
            skipped.append({"key": key, "reason": why})

    considered = []
    levels = []
    for drv_k, tgt_k, lag in hyps:
        if not usable_key.get(drv_k) or not usable_key.get(tgt_k):
            continue
        drv, tgt = series[drv_k], series[tgt_k]
        lx, ly = level_samples(drv, tgt, lag)
        dx, dy = diff_samples(drv, tgt, lag)
        if len(lx) < MIN_PAIR_N or len(dx) < MIN_PAIR_N:
            continue
        # ⚠️ ОДИН виклик на рівневу пару, як у JS-порті: `n_eff` підмінює лише
        # ступені свободи, тож `rho` в обох випадках той самий.
        rho_l, p_eff = spearman(lx, ly, n_eff=eff_n(lx, ly))
        rho_d, p_dif = spearman(dx, dy)
        levels.append((lx, ly))
        considered.append({
            "from": drv_k, "to": tgt_k, "lag": lag,
            "rho": round(rho_l, 4), "rhoDiff": round(rho_d, 4),
            "pEff": p_eff, "pDiff": p_dif,
            "n": len(lx), "nDiff": len(dx),
        })

    tested = len(considered)
    keep_eff = bh_keep([c["pEff"] for c in considered])
    keep_dif = bh_keep([c["pDiff"] for c in considered])

    rows = []
    for i, c in enumerate(considered):
        if not (keep_eff[i] and keep_dif[i]):
            continue
        # ⚠️ Знак мусить збігатися в обох поправках. Розбіжність означає, що
        # рівневий і різницевий погляди сперечаються про НАПРЯМОК — показувати
        # тоді нічого, хай навіть обидва p дрібні.
        if c["rho"] * c["rhoDiff"] <= 0:
            continue
        row = dict(c)
        row["p"] = round(max(c["pEff"], c["pDiff"]), 6)
        row["effect"] = contrast_of(levels[i])
        row.pop("pEff")
        row.pop("pDiff")
        rows.append(row)

    rows.sort(key=lambda r: (r["p"], -abs(r["rho"])))
    ready = weeks_usable >= GATE_WEEKS
    return {
        "ready": ready,
        "weeks": weeks_usable,
        "weeksNeeded": max(0, GATE_WEEKS - weeks_usable),
        "tested": tested,
        "shown": len(rows) if ready else 0,
        "rows": rows if ready else [],
        "skipped": skipped,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 7. СИНТЕТИКА ДЛЯ ЗОЛОТИХ ВЕКТОРІВ
# ─────────────────────────────────────────────────────────────────────────────

def synth(weeks: int = 60, seed: int = 42) -> dict[str, list]:
    """Тижневі ряди з ЗАКЛАДЕНОЮ істиною: сон(t-1) -> подачі(t), сильно.

    Форма кожного ряду мірою відповідає реальному: сон — години з десятими,
    енергія/настрій/оцінка — 1..5, вогники — 0..5, решта — лічильники."""
    rng = np.random.default_rng(seed)

    def ar1(phi):
        x = np.zeros(weeks)
        for t in range(1, weeks):
            x[t] = phi * x[t - 1] + rng.normal(0, 1)
        return (x - x.mean()) / (x.std() + 1e-9)

    z_sleep = ar1(0.55)
    z_noise = ar1(0.3)
    z_applied = np.zeros(weeks)
    z_applied[1:] = 0.8 * z_sleep[:-1] + math.sqrt(1 - 0.8**2) * z_noise[1:]
    z_applied = (z_applied - z_applied.mean()) / (z_applied.std() + 1e-9)

    out = {
        "sleep": [round(float(v), 1) for v in np.clip(7.0 + 0.9 * z_sleep, 4.5, 10.0)],
        "energy": [float(v) for v in np.clip(np.round(3.1 + 0.9 * ar1(0.5)), 1, 5)],
        "mood": [float(v) for v in np.clip(np.round(3.3 + 0.9 * ar1(0.45)), 1, 5)],
        "dayScore": [float(v) for v in np.clip(np.round(3.2 + 1.0 * ar1(0.4)), 1, 5)],
        "flames": [float(v) for v in np.clip(np.round(3.4 + 1.2 * ar1(0.6)), 0, 5)],
        "mock": [float(v) for v in rng.poisson(np.exp(0.4 * ar1(0.35) + 2.0))],
        "roadmap": [float(v) for v in rng.poisson(np.exp(0.5 * ar1(0.3) + 1.1))],
        "applied": [float(v) for v in rng.poisson(np.exp(0.5 * z_applied + 1.9))],
        "funnelMoves": [float(v) for v in rng.poisson(np.exp(0.5 * ar1(0.25) + 1.2))],
        "news": [float(v) for v in rng.poisson(np.exp(0.4 * ar1(0.4) + 2.4))],
        "opens": [float(v) for v in rng.poisson(np.exp(0.3 * ar1(0.5) + 2.6))],
    }
    # Дві діри — щоб золоті вектори пінили й вирівнювання з None, а не лише
    # щасливий шлях. Тижні 9 і 10 підряд: різниця через діру не має рахуватись.
    for k in ("sleep", "energy", "mood", "dayScore", "flames"):
        out[k][9] = None
        out[k][10] = None
    return out


def emit_golden(path: Path) -> dict:
    series = synth(60, seed=42)
    weeks_usable = sum(1 for v in series["dayScore"] if v is not None)
    early = {k: v[:14] for k, v in series.items()}
    payload = {
        "_readme": "Згенеровано research/levers_model.py --emit-golden. НЕ редагувати руками.",
        "featureOrder": FEATURE_KEYS,
        "domains": DOMAIN_OF,
        "hypotheses": [list(h) for h in HYPOTHESES],
        "constants": {
            "Q": Q,
            "MIN_PAIR_N": MIN_PAIR_N,
            "GATE_WEEKS": GATE_WEEKS,
            "USEFUL_WEEKS": USEFUL_WEEKS,
            "MIN_CHECKIN_DAYS": MIN_CHECKIN_DAYS,
            "MAX_MODE_SHARE": MAX_MODE_SHARE,
            "MIN_DISTINCT": MIN_DISTINCT,
        },
        "series": series,
        "weeksUsable": weeks_usable,
        # Точкові перевірки будівельних блоків — найдешевший спосіб зловити,
        # ДЕ саме розʼїхався порт, замість «підсумок інший».
        "units": {
            "acf1": [
                {"xs": [1, 2, 3, 4, 5, 6, 7, 8], "want": acf1([1, 2, 3, 4, 5, 6, 7, 8])},
                {"xs": [1, -1, 1, -1, 1, -1, 1, -1], "want": acf1([1, -1, 1, -1, 1, -1, 1, -1])},
                {"xs": [3, 3, 3, 3], "want": acf1([3, 3, 3, 3])},
            ],
            "effN": [
                {"xs": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                 "ys": [2, 1, 4, 3, 6, 5, 8, 7, 10, 9],
                 "want": eff_n([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [2, 1, 4, 3, 6, 5, 8, 7, 10, 9])},
            ],
            "spearman": [
                {"xs": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                 "ys": [2, 1, 4, 3, 6, 5, 8, 7, 10, 9],
                 "rho": spearman([1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                                 [2, 1, 4, 3, 6, 5, 8, 7, 10, 9])[0],
                 "p": spearman([1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                               [2, 1, 4, 3, 6, 5, 8, 7, 10, 9])[1]},
                # ⚠️ Звʼязки: саме тут наївні ранги через argsort розходяться
                # з середніми. Ряд і той самий ряд задом наперед мусять дати
                # ОДНЕ І ТЕ САМЕ rho.
                {"xs": [1, 1, 1, 2, 2, 3, 3, 3, 3, 4],
                 "ys": [2, 1, 3, 2, 2, 1, 4, 4, 2, 5],
                 "rho": spearman([1, 1, 1, 2, 2, 3, 3, 3, 3, 4],
                                 [2, 1, 3, 2, 2, 1, 4, 4, 2, 5])[0],
                 "p": spearman([1, 1, 1, 2, 2, 3, 3, 3, 3, 4],
                               [2, 1, 3, 2, 2, 1, 4, 4, 2, 5])[1]},
            ],
            "spearmanEffN": [
                {"xs": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                 "ys": [2, 1, 4, 3, 6, 5, 8, 7, 10, 9],
                 "nEff": 6.0,
                 "p": spearman([1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                               [2, 1, 4, 3, 6, 5, 8, 7, 10, 9], n_eff=6.0)[1]},
            ],
            "bh": [
                {"p": [0.001, 0.02, 0.04, 0.3, 0.7], "want": bh_keep([0.001, 0.02, 0.04, 0.3, 0.7])},
                {"p": [0.2, 0.3, 0.4], "want": bh_keep([0.2, 0.3, 0.4])},
                # Провал у середині не рятує дрібніші: BH бере НАЙБІЛЬШИЙ ранг,
                # що пройшов, і лишає все до нього.
                {"p": [0.001, 0.5, 0.006], "want": bh_keep([0.001, 0.5, 0.006])},
                # ⚠️ ДВА ВЕКТОРИ НИЖЧЕ ВІДРІЗНЯЮТЬ BH ВІД ПЛОСКОГО ПОРОГУ q.
                # Без них підміна «поправка на множинність» -> «кожна гіпотеза
                # окремо при p<0.10» проходить повз тести: на решті векторів
                # обидва правила дають той самий результат, і саме тому діра
                # була непомітна. Тут: 0.09 плоский поріг лишив би, BH — ні
                # (поріг першого рангу = 0.10/5 = 0.02).
                {"p": [0.09, 0.4, 0.5, 0.6, 0.7], "want": bh_keep([0.09, 0.4, 0.5, 0.6, 0.7])},
                # А тут плоский поріг лишив би ДВА, BH — лише перший.
                {"p": [0.001, 0.05, 0.9, 0.9, 0.9], "want": bh_keep([0.001, 0.05, 0.9, 0.9, 0.9])},
            ],
            "modeShare": [
                {"xs": [1, 1, 1, 2, 3], "want": mode_share([1, 1, 1, 2, 3])},
                {"xs": [1, 2, 3, 4], "want": mode_share([1, 2, 3, 4])},
            ],
            "seriesUsable": [
                {"xs": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "want": series_usable([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])[0]},
                {"xs": [0, 0, 0, 0, 0, 0, 1, 2, 3, 4], "want": series_usable([0, 0, 0, 0, 0, 0, 1, 2, 3, 4])[0]},
                {"xs": [1, 2, 3], "want": series_usable([1, 2, 3])[0]},
                {"xs": [1, 1, 1, 2, 2, 2, 1, 1, 2, 2], "want": series_usable([1, 1, 1, 2, 2, 2, 1, 1, 2, 2])[0]},
            ],
            "levelSamples": [
                {"drv": [1, None, 3, 4], "tgt": [9, 8, None, 6], "lag": 1,
                 "want": level_samples([1, None, 3, 4], [9, 8, None, 6], 1)},
            ],
            "diffSamples": [
                {"drv": [1, 2, None, 4, 5], "tgt": [1, 3, 6, 10, 15], "lag": 1,
                 "want": diff_samples([1, 2, None, 4, 5], [1, 3, 6, 10, 15], 1)},
            ],
        },
        "analysis": analyze(series, weeks_usable),
        # Порожній стан — окремий вектор: він показується частіше за будь-який
        # інший, і саме він мусить бути чесним.
        "analysisEarly": analyze(early, sum(1 for v in early["dayScore"] if v is not None)),
        "earlySeries": early,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    # indent=2 — той самий відступ, що ставить prettier у lint-staged.
    #
    # ⚠️ Відступу МАЛО: prettier ще й складає короткі масиви в один рядок, тож
    # свіжий `--emit-golden` однаково показує діф на сотні рядків, у якому
    # НІЧОГО не змінилось. Прогони `npx prettier --write` на цьому файлі —
    # діф має зникнути повністю. Якщо не зник, розійшлась саме математика.
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


# ─────────────────────────────────────────────────────────────────────────────
# 8. КОНТРОЛЬ (--measure)
# ─────────────────────────────────────────────────────────────────────────────

def measure() -> None:
    """Рівень помилки й потужність саме тієї конфігурації, що в analyze()."""
    print("=" * 78)
    print("КОНТРОЛЬ: панель без ЖОДНОГО закладеного звʼязку. Правильно — 0 рядків.")
    print("частка прогонів із >=1 показаним рядком (обіцянка BH q=0.10 — <=10%)")
    print("=" * 78)
    for weeks in (26, 39, 52, 78):
        shown = []
        for seed in range(120):
            rng = np.random.default_rng(20000 + seed)

            def ar1(phi):
                x = np.zeros(weeks)
                for t in range(1, weeks):
                    x[t] = phi * x[t - 1] + rng.normal(0, 1)
                return (x - x.mean()) / (x.std() + 1e-9)

            phis = [0.55, 0.5, 0.45, 0.4, 0.6, 0.35, 0.3, 0.3, 0.25, 0.4, 0.5]
            series = {}
            for (key, _), phi in zip(FEATURES, phis):
                z = ar1(phi)
                if key == "sleep":
                    series[key] = [round(float(v), 1) for v in np.clip(7.0 + 0.9 * z, 4.5, 10.0)]
                elif key in ("energy", "mood", "dayScore"):
                    series[key] = [float(v) for v in np.clip(np.round(3.2 + 0.9 * z), 1, 5)]
                elif key == "flames":
                    series[key] = [float(v) for v in np.clip(np.round(3.4 + 1.2 * z), 0, 5)]
                else:
                    series[key] = [float(v) for v in rng.poisson(np.exp(0.45 * z + 1.9))]
            res = analyze(series, weeks)
            shown.append(res["shown"])
        arr = np.array(shown)
        print(f"  N={weeks:>3}: {arr.mean():.2f} рядків у середньому · "
              f">=1 рядок у {100 * (arr > 0).mean():.0f}% прогонів · "
              f"перевірено гіпотез {res['tested']}")

    print()
    print("=" * 78)
    print("ПОТУЖНІСТЬ: закладено сон(t-1) -> подачі(t). Чи показує блок саме її?")
    print("=" * 78)
    for strength in (0.5, 0.8):
        print(f"\n  сила звʼязку {strength}:")
        for weeks in (26, 39, 52, 78):
            hit, other = 0, []
            for seed in range(120):
                series = synth_linked(weeks, 30000 + seed, strength)
                res = analyze(series, weeks)
                names = {(r["from"], r["to"]) for r in res["rows"]}
                hit += ("sleep", "applied") in names
                other.append(len(names - {("sleep", "applied")}))
            print(f"    N={weeks:>3}: знайшов {100 * hit / 120:>3.0f}% · "
                  f"чужих рядків поруч {np.mean(other):.2f}")


def synth_linked(weeks: int, seed: int, strength: float) -> dict[str, list]:
    rng = np.random.default_rng(seed)

    def ar1(phi):
        x = np.zeros(weeks)
        for t in range(1, weeks):
            x[t] = phi * x[t - 1] + rng.normal(0, 1)
        return (x - x.mean()) / (x.std() + 1e-9)

    z_sleep = ar1(0.55)
    z_noise = ar1(0.3)
    z_app = np.zeros(weeks)
    z_app[1:] = strength * z_sleep[:-1] + math.sqrt(1 - strength**2) * z_noise[1:]
    z_app = (z_app - z_app.mean()) / (z_app.std() + 1e-9)
    phis = [0.5, 0.45, 0.4, 0.6, 0.35, 0.3, 0.25, 0.4, 0.5]
    series = {"sleep": [round(float(v), 1) for v in np.clip(7.0 + 0.9 * z_sleep, 4.5, 10.0)],
              "applied": [float(v) for v in rng.poisson(np.exp(0.5 * z_app + 1.9))]}
    rest = [k for k in FEATURE_KEYS if k not in series]
    for key, phi in zip(rest, phis):
        z = ar1(phi)
        if key in ("energy", "mood", "dayScore"):
            series[key] = [float(v) for v in np.clip(np.round(3.2 + 0.9 * z), 1, 5)]
        elif key == "flames":
            series[key] = [float(v) for v in np.clip(np.round(3.4 + 1.2 * z), 0, 5)]
        else:
            series[key] = [float(v) for v in rng.poisson(np.exp(0.45 * z + 1.9))]
    return series


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit-golden", action="store_true")
    ap.add_argument("--measure", action="store_true")
    ap.add_argument("--weeks", type=int, default=60)
    args = ap.parse_args()

    if args.emit_golden:
        out = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "levers-golden.json"
        emit_golden(out)
        print(f"golden -> {out}")
        return

    if args.measure:
        measure()
        return

    series = synth(args.weeks)
    weeks_usable = sum(1 for v in series["dayScore"] if v is not None)
    res = analyze(series, weeks_usable)
    print(f"\n=== ВАЖЕЛІ · {res['weeks']} придатних тижнів ===")
    if not res["ready"]:
        print(f"  потрібно ще {res['weeksNeeded']} тижнів")
        return
    for r in res["rows"]:
        when = "наступного тижня" if r["lag"] == 1 else "того ж тижня"
        eff = r["effect"]
        tail = f" · {eff['high']} проти {eff['low']}" if eff else ""
        print(f"  {r['from']:>12} -> {when:<17} {r['to']:<12} "
              f"rho={r['rho']:+.2f} p={r['p']:.4f} n={r['n']}{tail}")
    print(f"\n  перевірено {res['tested']} гіпотез, показано {res['shown']}")
    if res["skipped"]:
        print("  виключені ряди: " + ", ".join(f"{s['key']} ({s['reason']})" for s in res["skipped"]))
    print()


if __name__ == "__main__":
    main()
