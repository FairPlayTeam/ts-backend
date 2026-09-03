import { z } from "zod";

const CSSColor = z.string().min(1);

export const ThemeColorsSchema = z.object({
  primary: CSSColor,
  primary100: CSSColor,
  primary200: CSSColor,
  primary300: CSSColor,
  primary400: CSSColor,
  primary500: CSSColor,
  background: CSSColor,
  foreground: CSSColor,
  card: CSSColor,
  cardForeground: CSSColor,
  muted: CSSColor,
  mutedForeground: CSSColor,
  accent: CSSColor,
  accentForeground: CSSColor,
  destructive: CSSColor,
  border: CSSColor,
  input: CSSColor,
  ring: CSSColor,
});

export type ThemeColors = z.infer<typeof ThemeColorsSchema>;
