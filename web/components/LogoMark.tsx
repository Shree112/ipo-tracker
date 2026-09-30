// The IPO Copilot mark: bids building up to a spark (the listing pop, and the
// "copilot" that watches them). Same drawing as app/icon.svg.
export default function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo-mark-svg" width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <defs>
        <linearGradient id="lmBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c1b18" />
          <stop offset="1" stopColor="#0a0a0a" />
        </linearGradient>
        <radialGradient id="lmGlow" cx="0.72" cy="0.28" r="0.72">
          <stop offset="0" stopColor="#d9c4a0" stopOpacity="0.24" />
          <stop offset="1" stopColor="#d9c4a0" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="lmGold" x1="0" y1="1" x2="0.6" y2="0">
          <stop offset="0" stopColor="#9c7a45" />
          <stop offset="0.6" stopColor="#e3cc9f" />
          <stop offset="1" stopColor="#fff1d6" />
        </linearGradient>
        <linearGradient id="lmRim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f3e3c3" stopOpacity="0.6" />
          <stop offset="0.5" stopColor="#f3e3c3" stopOpacity="0.08" />
          <stop offset="1" stopColor="#f3e3c3" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="496" height="496" rx="116" fill="url(#lmBg)" />
      <rect x="8" y="8" width="496" height="496" rx="116" fill="url(#lmGlow)" />
      <rect x="10" y="10" width="492" height="492" rx="114" fill="none" stroke="url(#lmRim)" strokeWidth="5" />
      <rect x="104" y="292" width="64" height="116" rx="20" fill="url(#lmGold)" opacity="0.55" />
      <rect x="196" y="232" width="64" height="176" rx="20" fill="url(#lmGold)" opacity="0.78" />
      <rect x="288" y="172" width="64" height="236" rx="20" fill="url(#lmGold)" />
      <path
        d="M396 88 C 402 134, 416 148, 462 154 C 416 160, 402 174, 396 220 C 390 174, 376 160, 330 154 C 376 148, 390 134, 396 88 Z"
        fill="#fff1d6"
      />
    </svg>
  );
}
