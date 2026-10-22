export const LEISURE_EVENT_CATEGORIES: string[];
export const LEISURE_EVENT_FORMATS: Record<string, string>;
export const LEISURE_FORMAT_CATEGORIES: Record<string, string>;
export function classifyLeisureEvent(item: any): {
  category: string;
  eventFormat: string;
  classificationEvidence: string;
};
export function classifiedLeisureItem(item: any, override?: any): any;
