import type { Rules } from "./queries";

// Starting points offered at first sign-in. Each is a complete rule set; the
// member can fine-tune it on the Alerts page later.
export type Preset = {
  id: string;
  title: string;
  blurb: string;
  rules: Partial<Rules>;
};

const OFF: Partial<Rules> = {
  gmp_pct_min: null,
  profit_per_lot_min: null,
  sub_total_min: null,
  sub_retail_min: null,
  sub_qib_min: null,
  anchor_mf_min: null,
  size_min_cr: null,
  size_max_cr: null,
};

export const PRESETS: Preset[] = [
  {
    id: "steady",
    title: "Steady listing gains",
    blurb: "Only IPOs the grey market rates well. Fewer emails, better odds.",
    rules: { ...OFF, gmp_pct_min: 15, match_mode: "all" },
  },
  {
    id: "more",
    title: "More chances",
    blurb: "Anything with a positive signal: GMP of 5% or ₹1,500 a lot. More emails, some duds.",
    rules: { ...OFF, gmp_pct_min: 5, profit_per_lot_min: 1500, match_mode: "any" },
  },
  {
    id: "big",
    title: "Big, well-known names",
    blurb: "Issues of ₹1,000 crore or more with a positive GMP. Household names, deeper books.",
    rules: { ...OFF, gmp_pct_min: 5, size_min_cr: 1000, match_mode: "all" },
  },
  {
    id: "demand",
    title: "Hot demand only",
    blurb: "GMP of 10% and retail subscribed 3x. Arrives once bidding shows real demand, usually on day 2.",
    rules: { ...OFF, gmp_pct_min: 10, sub_retail_min: 3, match_mode: "all" },
  },
];
