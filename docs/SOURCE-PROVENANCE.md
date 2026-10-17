# Source and asset provenance

The repository separates the Sona marketplace implementation from the systems it integrates and the visual material supplied for the website.

| Material | Origin and scope |
| --- | --- |
| `marketplace/src/server/`, `marketplace/src/client/`, `marketplace/src/chain/`, related tests and verification scripts | Sona application implementation: authentication, listing workflow, protocol validation and transaction construction. It uses external Solana libraries and standard programs. |
| `marketplace/dist/` | The supplied Framer site export, Sona adaptations and generated wallet bundle. Existing layout, illustrations and animations are retained. The generated bundle contains third-party dependency code. |
| Root application, `build/` and framework setup | Sites/Vinext hosting template and Sona hosting integration. Existing template notices remain in place. |
| `marketplace/evidence/RAYDIUM-SOURCES.md` | Official Raydium source references, account layouts, program identifiers and validation limits. Sona does not implement or own Raydium's lock or pool programs. |
| `marketplace/dist/assets/brands/manifest.json` | Token, protocol and wallet logo source URLs and recorded file hashes. Brand assets are used for identification and do not imply partnership. |
| `marketplace/vendor/bigint-buffer/` | Documented application dependency replacement. Its README explains its implementation and scope. |

The supplied wordmark and symbol identify Sona. A public source release does not grant a blanket license to reuse the artwork, third-party fonts, trademarks or the original supplied design. See the root [rights notice](../LICENSE). Where a component has an explicit upstream license, that license remains authoritative.

Dependency versions and integrity hashes are recorded in the two `package-lock.json` files. The wallet build retains bundled license comments. Existing Framer component credits and external-library notices have not been removed to imply originality.

Historical interface fixtures, private feedback, one-time conversion history, databases, authentication sessions, private keys and deployment credentials are excluded from the public source. Public test fixtures are retained and explicitly identified as fixtures. Removing private workspace history is not evidence that every file was authored independently; the origin boundaries above remain part of the public record.
