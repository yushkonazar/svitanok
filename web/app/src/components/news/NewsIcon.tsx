const paths = {
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  follow: 'M12 3v3m0 12v3M3 12h3m12 0h3M17.7 6.3l-2 2m-7.4 7.4-2 2m11.4 0-2-2M8.3 8.3l-2-2',
  heart:
    'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.3 3M4.6 14.9a8 8 0 0 0 13.3 3',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  hide: 'M3 3l18 18M10 10a3 3 0 0 0 4 4M9.9 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-4 4.5M6.2 6.2A20 20 0 0 0 2 12s4 7 10 7a11 11 0 0 0 5-1.2',
  arrow: 'M7 17 17 7M7 7h10v10',
  back: 'm14 6-6 6 6 6',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
};
export function NewsIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
