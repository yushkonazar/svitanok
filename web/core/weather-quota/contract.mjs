// Atomic accounting for live OpenWeather calls. The live weather payload stays
// an ordinary KV cache; only the daily external-call budget needs a control plane.

export const WEATHER_QUOTA_DO_NAME = 'weather-quota';
export const WEATHER_LIVE_COUNTER_KEY = 'weatherLiveCounter';
