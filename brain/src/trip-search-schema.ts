/** The research output is data for cards, never arbitrary nested prose objects. */
const text = { type: 'string' };
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const TRIP_SEARCH_FORMAT = {
  type: 'json_schema',
  name: 'trip_search',
  strict: true,
  schema: object({
    summary: text,
    options: {
      type: 'array',
      maxItems: 12,
      items: object({
        kind: { type: 'string', enum: ['transport', 'stay', 'activity'] },
        title: text,
        provider: text,
        source_url: text,
        checked_at: text,
        availability: { type: 'string', enum: ['unverified', 'page_observed'] },
        price: nullable(
          object({
            amount: { type: 'number' },
            currency: text,
            unit: {
              type: 'string',
              enum: ['person', 'group', 'room_night', 'stay', 'ticket', 'entry'],
            },
            quantity: { type: 'integer' },
            includes: text,
            excludes: text,
            total_confirmed: { type: 'boolean' },
          }),
        ),
        dates: text,
        schedule: text,
        location: text,
        cancellation: text,
        tradeoffs: text,
        missing: text,
        highlights: { type: 'array', maxItems: 3, items: text },
        duration_minutes: { type: ['integer', 'null'] },
        rating: nullable(
          object({
            value: { type: 'number' },
            scale: { type: 'integer', enum: [5, 10] },
            count: { type: 'integer' },
            source: text,
          }),
        ),
      }),
    },
  }),
};
