import { useState } from 'react';
import { categoryLabels, type LeisureItem } from '../../api/leisure.ts';

export const categoryArtwork: Record<LeisureItem['category'], string> = {
  exhibition: '/leisure-covers/exhibition-v1.webp',
  festival: '/leisure-covers/festival-v1.webp',
  concert: '/leisure-covers/concert-v1.webp',
  show: '/leisure-covers/show-v1.webp',
  cinema: '/leisure-covers/cinema-v1.webp',
  food: '/leisure-covers/food-v1.webp',
  trip: '/leisure-covers/trip-v1.webp',
};

export function CategoryArtwork({
  category,
  variant = 'cover',
  eager = false,
}: {
  category: LeisureItem['category'];
  variant?: 'cover' | 'thumb' | 'detail';
  eager?: boolean;
}) {
  const [failedCategory, setFailedCategory] = useState<string | null>(null);
  return (
    <div
      className={`leisure-category-art is-${variant} category-${category}`}
      title="Тематична ілюстрація категорії, не фото конкретної події"
    >
      {failedCategory !== category ? (
        <img
          src={categoryArtwork[category]}
          alt={`Ілюстрація категорії «${categoryLabels[category]}»`}
          width={960}
          height={640}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onError={() => setFailedCategory(category)}
        />
      ) : (
        <span className="leisure-art-fallback">{categoryLabels[category]}</span>
      )}
    </div>
  );
}
