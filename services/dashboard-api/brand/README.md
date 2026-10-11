# Team Alpha wolf

The logo and favicon used by the dashboard page. The page has its own inline copies (the
gateway forwards only `/` to it), so these files are the masters for anything else.

- `mark.svg`: static logo, 64×64 grid, for dark backgrounds (it has no backplate)
- `animated.svg`: the header logo. Sound waves from the cups, an occasional blink and ear flick,
  all off under `prefers-reduced-motion`. Every selector is prefixed `.ta-wolf`, so it is safe
  to inline. In the page its keyline uses the brand-block colour `#160B35` instead of `#0B1020`.
- `favicon.svg`: simplified drawing on a rounded `#160B35` tile; reads at 16px on light and dark tabs.
