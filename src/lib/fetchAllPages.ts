// src/lib/fetchAllPages.ts
//
// Reads every row a query matches. PostgREST caps each response at max_rows
// (1,000) without any error, so a single unpaged select silently loses rows
// once a table grows past that. This pages through the whole result instead.
//
// Every page is ordered by id (unique), so rows cannot be skipped or repeated
// at a page boundary. A failure on any page returns the error and no data,
// never a partial list.

export const FETCH_ALL_PAGE_SIZE = 1000;

export type PageError = { code?: string; message?: string; details?: string; hint?: string } | null | undefined;

export type PagedQuery<T> = {
  order: (col: string) => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: PageError }> };
};

/** `build` must return a fresh, unordered query each time it is called. */
export async function fetchAllPages<T>(build: () => PagedQuery<T>): Promise<{ data: T[] | null; error: PageError }> {
  const out: T[] = [];
  for (let from = 0; ; from += FETCH_ALL_PAGE_SIZE) {
    const { data, error } = await build().order('id').range(from, from + FETCH_ALL_PAGE_SIZE - 1);
    if (error) return { data: null, error };
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < FETCH_ALL_PAGE_SIZE) return { data: out, error: null };
  }
}
