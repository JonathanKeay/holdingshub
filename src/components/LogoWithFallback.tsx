'use client';

import { useState } from 'react';

export function LogoWithFallback({
  src,
  alt,
  className = 'h-4 w-4 mr-2',
  ...rest
}: {
  src: string | null;
  alt?: string;
  className?: string;
  [key: string]: any;
}) {
  const [error, setError] = useState(false);

  if (!src || error) return null;

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setError(true)}
      {...rest}
      loading={rest?.loading ?? 'lazy'}
      decoding={rest?.decoding ?? 'async'}
    />
  );
}

