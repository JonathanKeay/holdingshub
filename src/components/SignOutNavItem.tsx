'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

export default function SignOutNavItem({
  className = '',
  variant = 'icon', // 'icon' | 'default'
}: {
  className?: string;
  variant?: 'icon' | 'default';
}) {
  const router = useRouter();
  const supabase = React.useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      ),
    []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  );

  const onSignOut = async () => {
    try {
      await supabase.auth.signOut();
    } finally {
      router.replace('/login');
      router.refresh();
    }
  };

  return (
    <button
      type="button"
      onClick={onSignOut}
      title="Sign out"
      aria-label="Sign out"
      className={`flex items-center gap-2 px-3 py-2 rounded hover:bg-red-50 hover:text-red-600 text-gray-600 ${className}`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-5 w-5 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12H3m12 0l-3-3m3 3l-3 3m0 6h6a2 2 0 002-2V8a2 2 0 00-2-2h-6" />
      </svg>
      {variant === 'default' && <span className="text-sm">Sign out</span>}
    </button>
  );
}