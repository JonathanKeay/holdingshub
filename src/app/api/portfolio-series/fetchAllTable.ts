// src/app/api/portfolio-series/fetchAllTable.ts
//
// Pages through every row of a table (PostgREST silently caps a response at
// 1,000 rows). Kept outside route.ts because a Next.js route file may only
// export route handlers, and this needs to be testable on its own.
//
// Every page is ordered by id (unique), so rows cannot be skipped or repeated
// at a page boundary. Callers re-sort rows themselves; this order only
// guarantees completeness. A failed page throws.

export async function fetchAllTable<T = any>(
  supabase: any,
  table: string,
  opts?: { pageSize?: number; select?: string }
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  const pageSize = Math.min(opts?.pageSize ?? 1000, 1000);
  const select = opts?.select ?? '*';
  while (true) {
    const { data, error } = await supabase.from(table).select(select).order('id').range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}
