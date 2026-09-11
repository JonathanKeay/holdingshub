export const POSITIVE_BADGE = 'inline-block rounded px-1 font-bold text-tgreen bg-tgreen-bg';
export const NEGATIVE_BADGE = 'inline-block rounded px-1 font-bold text-tred bg-tred-bg';

export const POSITIVE_TEXT = 'text-tgreen';
export const NEGATIVE_TEXT = 'text-tred';
// Theme-aware brand text (light: themeblue, dark/system-dark: accent)
export const THEME_BLUE_TEXT = 'text-brand-text';
export const THEME_LBLUE_TEXT = 'text-themeblue-disabled';


// Reusable blue badge used for total-cost / small badges (includes font-weight & bg)
export const THEME_BLUE_BADGE =
	'text-xs font-bold rounded px-1 inline-block text-brand-text bg-[var(--color-themeblue-bg)]';

// State VAriants
export const THEME_BLUE_DISABLED = 'text-white font-bold bg-themeblue-disabled-bg';
export const THEME_BLUE_HOVER = 'text-white font-bold bg-[var(--color-themeblue-hover-bg)]';
export const THEME_BLUE_CHECKED = 'text-brand-text font-bold bg-background';
export const THEME_BLUE_ACTIVE = 'text-white font-bold bg-themeblue';

// Add this: text + background together so cells show the blue background
export const THEME_BLUE_DISABLED_BG = 'text-foreground font-bold bg-themeblue-disabled-bg';

export const SOFT_ROW_BG = 'bg-Tsoft-tint';
export const ROW_HOVER_BG = 'hover:bg-Thoverlight-tint';
export const DIVIDER = 'border-Tdivider';