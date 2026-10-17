Sona — Raydium Fee Key marketplace

Run with Node.js 24 or later:
  npm ci
  npm run build
  npm start

The Node server serves the existing website, marketplace and authenticated API.
Serve the full application rather than dist/ alone to enable wallet-backed
listings and settlement. No paid API key is required.

See README.md for setup, configuration, supported assets and verification.
See docs/TECHNICAL-READINESS.md for implementation details and current limits.
See evidence/RAYDIUM-SOURCES.md for protocol verification provenance.

The checked-in Framer export retains the supplied website's layout, typography,
illustrations and animations. Sona branding uses the supplied wordmark and symbol.
Third-party runtime and brand-asset provenance are retained.

Optional editorial alignment: python3 scripts/align-capability-copy.py
This updates exact copy in the existing export without changing its layout.
