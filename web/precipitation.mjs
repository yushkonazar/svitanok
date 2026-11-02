/** Keep provider precipitation identity; temperature alone cannot identify snow.
 * @param {{rain?:{'1h'?:number},snow?:{'1h'?:number},weather?:{id?:number}[]}} hour */
export function precipitationFields(hour) {
  const valid = (/** @type {unknown} */ value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const rain = valid(hour.rain?.['1h']) ? Number(hour.rain?.['1h']) : null;
  const snow = valid(hour.snow?.['1h']) ? Number(hour.snow?.['1h']) : null;
  const id = hour.weather?.[0]?.id ?? 0;
  const type =
    (rain ?? 0) > 0 && (snow ?? 0) > 0
      ? 'mixed'
      : (snow ?? 0) > 0
        ? 'snow'
        : (rain ?? 0) > 0
          ? 'rain'
          : [611, 612, 613, 615, 616].includes(id)
            ? 'mixed'
            : id >= 600 && id < 700
              ? 'snow'
              : id >= 200 && id < 600
                ? 'rain'
                : undefined;
  return {
    ...(rain != null ? { rainMm: rain } : {}),
    ...(snow != null ? { snowMm: snow } : {}),
    ...(rain != null || snow != null ? { precipMm: (rain ?? 0) + (snow ?? 0) } : {}),
    ...(type ? { precipType: type } : {}),
  };
}
