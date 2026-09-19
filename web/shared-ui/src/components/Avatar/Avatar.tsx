import { memo } from 'react';

export interface AvatarProps {
  /** Display name — used for the alt text and the initials fallback. */
  name: string;
  /** Optional image URL; the initials fallback renders when absent. */
  src?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-12 h-12 text-base',
};

/**
 * Deterministic background hue from the name so a given user always gets the
 * same color (no per-render randomness).
 */
const bgPalette = [
  'bg-primary-600',
  'bg-success-600',
  'bg-accent-600',
  'bg-warning-600',
  'bg-error-600',
  'bg-info-600',
  'bg-neutral-600',
  'bg-secondary-600',
];

function bgForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return bgPalette[Math.abs(hash) % bgPalette.length]!;
}

/**
 * User/entity avatar with an initials fallback.
 */
export const Avatar = memo<AvatarProps>(({ name, src, size = 'md', className = '' }) => {
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${sizeClasses[size]} rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={name}
      className={`${sizeClasses[size]} ${bgForName(name)} rounded-full flex items-center justify-center text-white font-medium ${className}`}
    >
      {initials || '??'}
    </div>
  );
});

Avatar.displayName = 'Avatar';
