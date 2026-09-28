// Where each registrar lets you check allotment. The three big ones cover
// almost every mainboard IPO; anything else falls back to BSE's checker.
const MAP: [string[], string, string][] = [
  [["kfin", "karvy"], "KFin Technologies", "https://ipostatus.kfintech.com/"],
  [["bigshare"], "Bigshare Services", "https://ipo.bigshareonline.com/IPO_Status.html"],
  [["intime", "mufg", "mpms"], "MUFG Intime", "https://in.mpms.mufg.com/Initial_Offer/public-issues.html"],
];
export const BSE_STATUS = "https://www.bseindia.com/investors/appli_check.aspx";

export function registrarLink(name: string | null): { label: string; url: string; known: boolean } {
  const n = (name ?? "").toLowerCase();
  for (const [keys, label, url] of MAP) if (keys.some((k) => n.includes(k))) return { label, url, known: true };
  return { label: "BSE", url: BSE_STATUS, known: false };
}
