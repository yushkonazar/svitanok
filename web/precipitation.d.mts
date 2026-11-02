export function precipitationFields(hour: {
  rain?: { '1h'?: number };
  snow?: { '1h'?: number };
  weather?: { id?: number }[];
}): {
  rainMm?: number;
  snowMm?: number;
  precipMm?: number;
  precipType?: string;
};
