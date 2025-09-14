'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { THEME_BLUE_TEXT } from '@/lib/uiColors';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const BTN_BASE =
  'inline-flex items-center rounded-md font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
const BTN_MD = 'text-sm px-3.5 py-2';
const BTN_GHOST =
  `${THEME_BLUE_TEXT} border border-themeblue-hover hover:bg-Thoverlight-tint focus-visible:ring-themeblue`;

export default function UserMenu() {
  const router = useRouter();

  const onSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <button className={`${BTN_BASE} ${BTN_GHOST} ${BTN_MD}`} onClick={onSignOut}>
      Sign out
    </button>
  );
}
