// Minimal shared types for Supabase-backed entities used in app code.

export type Portfolio = {
	id: string;
	name: string;
	base_currency?: string | null;
};

// Extend here if needed later:
// export type Asset = { id: string; ticker: string; currency: string; name?: string | null };
// export type Transaction = { /* ... */ };

