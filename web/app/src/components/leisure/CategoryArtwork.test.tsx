import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CategoryArtwork, categoryArtwork } from './CategoryArtwork.tsx';
import { categoryLabels, type LeisureItem } from '../../api/leisure.ts';

describe('category illustrations', () => {
  it('gives all seven categories distinct covers with a clear illustration label', () => {
    expect(new Set(Object.values(categoryArtwork)).size).toBe(7);
    for (const category of Object.keys(categoryArtwork) as LeisureItem['category'][]) {
      const { unmount } = render(<CategoryArtwork category={category} eager />);
      expect(screen.getByRole('img')).toHaveAttribute('src', categoryArtwork[category]);
      expect(screen.getByRole('img')).toHaveAccessibleName(
        `Ілюстрація категорії «${categoryLabels[category]}»`,
      );
      expect(screen.getByText('Ілюстрація')).toBeInTheDocument();
      unmount();
    }
  });
  it('shows a stable category fallback when an image fails and recovers for the next category', () => {
    const { rerender } = render(<CategoryArtwork category="cinema" />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Кіно')).toBeInTheDocument();
    rerender(<CategoryArtwork category="food" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', categoryArtwork.food);
  });
});
