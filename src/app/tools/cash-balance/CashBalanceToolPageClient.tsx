'use client';
import { useSearchParams } from 'next/navigation';
import CashBalanceToolClient from './CashBalanceToolClient';

export default function CashBalanceToolPageClient({ portfolios }: { portfolios: any[] }) {
  const searchParams = useSearchParams();
  const resetKey = searchParams.get('reset') || 'default';

  return <CashBalanceToolClient key={resetKey} portfolios={portfolios} />;
}