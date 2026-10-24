// Adaptive local-level / weekly state-space forecasts. Money is supplied in minor units.
// Model selection is chronological; held-out observations never fit their own model.
export const MODEL_VERSION = 'local-level-weekly-v1';
/** @param {number[]} xs @param {number} [p] */
export function quantile(xs, p = 0.5) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b),
    k = (s.length - 1) * p,
    i = Math.floor(k);
  return (s[i] ?? 0) + ((s[Math.min(i + 1, s.length - 1)] ?? 0) - (s[i] ?? 0)) * (k - i);
}
/** @param {(number|null)[]} values @param {number} q @param {number} r @param {number[]} [effects] @param {number} [offset] */
export function filterLocalLevel(values, q, r, effects = Array(7).fill(0), offset = 0) {
  let level = values.find((v) => v != null) ?? 0,
    variance = Math.max(r, 1) * 10,
    loss = 0;
  /** @type {number[]} */ const residuals = [];
  values.forEach((value, i) => {
    variance += q;
    if (value == null) {
      residuals.push(0);
      return;
    }
    const error = value - (effects[(i + offset) % 7] ?? 0) - level,
      innovation = variance + r;
    loss += Math.log(innovation) + (error * error) / innovation;
    const gain = variance / innovation;
    level += gain * error;
    variance = (1 - gain) * variance;
    residuals.push(error);
  });
  return { level, variance, loss, residuals };
}
/** @param {(number|null)[]} values @param {boolean} weekly @param {number} offset */
function fit(values, weekly, offset) {
  const known = values.filter((v) => v != null);
  const center = quantile(known),
    deviations = known.map((v) => Math.abs(v - center));
  const scale = Math.max(1, quantile(deviations) * 1.4826, Math.abs(center) * 0.1);
  let r = scale * scale;
  const effects = Array(7).fill(0);
  if (!weekly) {
    const candidates = [0.03, 0.06, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9].map((alpha) => {
      let level = values.find((v) => v != null) ?? 0,
        loss = 0;
      const residuals = values.map((value) => {
        if (value == null) return 0;
        const error = value - level;
        loss += error * error;
        level += alpha * error;
        return error;
      });
      return {
        level,
        loss,
        residuals,
        variance: (r * alpha) / (2 - alpha),
        r,
        q: (r * alpha * alpha) / (1 - alpha),
        effects,
      };
    });
    const best = candidates.sort((a, b) => a.loss - b.loss)[0];
    if (!best) throw new Error('Немає моделі для оцінки');
    return best;
  }
  if (weekly && known.length >= 21) {
    // Shrink weekday effects toward zero on short / sparse personal histories.
    const base = known.reduce((a, b) => a + b, 0) / Math.max(1, known.length);
    const lagged = values.flatMap((v, i) =>
      v != null && i >= 7 && values[i - 7] != null ? [v - (values[i - 7] ?? 0)] : [],
    );
    const change = quantile(lagged);
    const weeklyNoise = Math.max(
      1,
      (quantile(lagged.map((v) => Math.abs(v - change))) * 1.4826) / Math.sqrt(2),
    );
    const between = Math.max(1, known.reduce((n, v) => n + (v - base) ** 2, 0) / known.length);
    // Empirical noise-to-signal prior: consistent weekdays keep their real seasonality.
    const prior = Math.min(7, (weeklyNoise * weeklyNoise) / between);
    r = weeklyNoise * weeklyNoise;
    for (let d = 0; d < 7; d++) {
      const matches = values.flatMap((v, i) =>
        v != null && (i + offset) % 7 === d
          ? [{ v, weight: Math.exp((i - values.length + 1) / 35) }]
          : [],
      );
      effects[d] =
        matches.reduce((n, x) => n + (x.v - base) * x.weight, 0) /
        (prior + matches.reduce((n, x) => n + x.weight, 0));
    }
    const mean = effects.reduce((a, b) => a + b, 0) / 7;
    effects.forEach((v, i) => (effects[i] = v - mean));
  }
  const candidates = [0.0001, 0.001, 0.01, 0.03, 0.1, 0.3, 1].map((ratio) => {
    const state = filterLocalLevel(values, r * ratio, r, effects, offset);
    return { ...state, q: r * ratio, r, effects };
  });
  const best = candidates.sort((a, b) => a.loss - b.loss)[0];
  if (!best) throw new Error('Немає моделі для оцінки');
  return best;
}
/** @param {(number|null)[]} values @param {number} days @param {number} [offset]
 * offset is the weekday of the first calendar observation (Monday=0). */
export function adaptiveForecast(values, days, offset = 0) {
  const count = values.filter((v) => v != null).length;
  const names = count >= 21 ? ['ets-level', 'kalman-weekly'] : ['ets-level'];
  const scores = names.map((name) => {
    const errors = [];
    for (let end = 21; end + 7 <= values.length; end += 7) {
      const training = fit(values.slice(0, end), name === 'kalman-weekly', offset);
      const held = values.slice(end, end + 7);
      if (held.some((v) => v == null)) continue;
      const actual = held.map((v) => v ?? 0);
      const predicted = actual.map((_, i) =>
        Math.max(0, training.level + (training.effects[(end + i + offset) % 7] ?? 0)),
      );
      const day = actual.reduce((n, v, i) => n + Math.abs(v - (predicted[i] ?? 0)), 0) / 7;
      const total =
        Math.abs(actual.reduce((n, v) => n + v, 0) - predicted.reduce((a, b) => a + b, 0)) / 7;
      errors.push(0.5 * day + 0.5 * total);
    }
    return {
      name,
      folds: errors.length,
      mae: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
    };
  });
  const chosen =
    [...scores]
      .filter((s) => s.mae != null)
      .sort((a, b) => (a.mae ?? Infinity) - (b.mae ?? Infinity))[0]?.name ?? 'ets-level';
  const model = fit(values, chosen === 'kalman-weekly', offset);
  const points = Array.from({ length: days }, (_, i) =>
    Math.max(0, Math.round(model.level + (model.effects[(values.length + i + offset) % 7] ?? 0))),
  );
  return {
    model: chosen,
    version: MODEL_VERSION,
    count,
    scores,
    points,
    residuals: model.residuals,
    noise: Math.max(
      1,
      quantile(
        model.residuals.map((v) => Math.abs(v)),
        0.75,
      ),
    ),
    status: count < 7 ? 'limited' : count < 28 ? 'developing' : 'estimated',
  };
}
