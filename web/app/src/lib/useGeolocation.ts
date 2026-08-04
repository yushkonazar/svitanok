import { useEffect, useState } from 'react';

export interface GeoCoords {
  lat: number;
  lon: number;
}

/**
 * Один знімок координат браузера (не watchPosition — точність GPS «прямо
 * зараз» не потрібна, це лише привʼязка погоди до реального місця, Блок
 * «Погода»). Викликається ОДИН раз при монтуванні.
 *
 * Немає navigator.geolocation / відмовлено в дозволі / таймаут / десктоп-
 * Telegram, де геолокація часто взагалі недоступна — усе однаково тихо
 * лишається на null: WeatherBlock і так має робочий фолбек (дефолтні
 * Львів/Немовичі), тож це чисте покращення, не критичний шлях.
 */
export function useGeolocation(): GeoCoords | null {
  const [coords, setCoords] = useState<GeoCoords | null>(null);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!cancelled) setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        /* відмова/таймаут/недоступність — тихо лишаємось на null (фолбек) */
      },
      // enableHighAccuracy:false — містова точність достатня для погоди,
      // мережева локація швидша й дешевша за GPS-фікс.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 15 * 60_000 },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return coords;
}
