/** The MangoLove mark: a gold-orange mango + leaf (matches the app icon). */
export function Logo({ size = 22 }: { readonly size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="mango-mark" x1="0.15" y1="0.05" x2="0.85" y2="1">
          <stop offset="0" stopColor="#ffd24d" />
          <stop offset="0.52" stopColor="#ff9f1c" />
          <stop offset="1" stopColor="#ff6f59" />
        </linearGradient>
      </defs>
      <path
        d="M36 12 C 36 8, 37 5, 40 4"
        stroke="#7a5b3a"
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
      <path d="M40 6 C 46 0, 56 1, 60 6 C 55 12, 45 12, 40 8 Z" fill="#46b96a" />
      <path d="M41 7 C 47 5, 53 5, 58 7" stroke="#2f8f50" strokeWidth={1.3} fill="none" />
      <path
        d="M40 11 C 51 13, 54 26, 51 39 C 48 52, 39 58, 29 55 C 17 51, 13 37, 18 25 C 22 15, 31 10, 40 11 Z"
        fill="url(#mango-mark)"
      />
      <ellipse
        cx={28}
        cy={27}
        rx={5.5}
        ry={9}
        fill="#fff"
        opacity={0.22}
        transform="rotate(-22 28 27)"
      />
    </svg>
  );
}
