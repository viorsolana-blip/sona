"""Keep exported Sona copy aligned with the current local implementation.

Only exact editorial strings are changed; markup, styling and state code remain
untouched. The checked-in Sona export is the current visual source.
"""
from pathlib import Path
import html
import json
import re

ROOT = Path(__file__).resolve().parents[1]

REPLACEMENTS = {
    "Solana’s first decentralized Liquidity Marketplace 🪎. Trade eligible LP positions and fee rights, built for the trenches.": "A liquidity marketplace for Solana. Discover verified Raydium Fee Keys and trade the fee rights they represent.",
    "In development: a liquidity marketplace for Solana. Explore the interface for eligible LP positions and transferable fee rights.": "A liquidity marketplace for Solana. Discover verified Raydium Fee Keys and trade the fee rights they represent.",
    "Sona — Solana’s first decentralized Liquidity Marketplace 🪎. Discover eligible LP positions and transferable fee rights on Solana.": "Sona — a liquidity marketplace for Raydium CPMM Fee Keys on Solana. Connect your wallet, list verified fee rights and settle with both parties’ approval.",
    "Sona — a liquidity marketplace for Solana, in development. Explore the interface for eligible LP positions and transferable fee rights.": "Sona — a liquidity marketplace for Raydium CPMM Fee Keys on Solana. Connect your wallet, list verified fee rights and settle with both parties’ approval.",
    "Solana’s first decentralized Liquidity Marketplace 🪎. A new market for eligible positions and fee rights.": "A market for verified Raydium Fee Keys on Solana.",
    "A Solana liquidity marketplace in development. Designed for eligible positions and fee rights.": "A market for verified Raydium Fee Keys on Solana.",
    "Solana’s first decentralized Liquidity Marketplace 🪎": "A liquidity marketplace for Solana.",
    "A Solana liquidity marketplace in development.": "A liquidity marketplace for Solana.",
    "Solana’s liquidity marketplace. Discover eligible positions, compare lock terms and trade transferable rights. Built for the trenches, with privacy-conscious deal discovery and verifiable settlement.": "Sona connects wallet-held Raydium Fee Keys with buyers. Verify the rights, agree a price and settle the NFT transfer and SOL payment together. Each sale requires the seller’s approval.",
    "A liquidity marketplace in development for Solana. The current interface explores position discovery, lock terms and transferable rights. Wallet connections and settlement are not yet available.": "Sona connects wallet-held Raydium Fee Keys with buyers. Verify the rights, agree a price and settle the NFT transfer and SOL payment together. Each sale requires the seller’s approval.",
    "Sona is a decentralized liquidity marketplace focused on Solana. It brings eligible LP positions and transferable fee rights into a market where traders can compare assets, lock terms and ownership rights.": "Sona is a marketplace for verified Raydium CPMM Fee Keys. Connect a wallet to discover supported fee rights, create a listing and approve a sale. Listings are stored by the marketplace; settlement uses Solana’s existing programs.",
    "Sona is building a liquidity marketplace for Solana. The current interface uses illustrative positions to explore assets, lock terms and ownership rights. Live trading is not yet available.": "Sona is a marketplace for verified Raydium CPMM Fee Keys. Connect a wallet to discover supported fee rights, create a listing and approve a sale. Listings are stored by the marketplace; settlement uses Solana’s existing programs.",
    "Verifiable settlement on Solana. Clear terms for every supported position.": "Fee Key transfer and SOL payment settle together on Solana. Both wallets approve the transaction.",
    "Solana settlement is planned. The current interface does not submit transactions.": "Fee Key transfer and SOL payment settle together on Solana. Both wallets approve the transaction.",
    "On-chain settlement": "Atomic settlement",
    "Settlement in development": "Atomic settlement",
    "Liquidity stays locked. Ownership can move. Sona brings a new market for eligible LP positions and fee rights to Solana.": "Liquidity stays locked. Fee rights can move. Sona connects buyers and sellers of verified Raydium Fee Keys on Solana.",
    "Liquidity stays locked. Eligible rights can move. Sona is building a market for transferable positions on Solana.": "Liquidity stays locked. Fee rights can move. Sona connects buyers and sellers of verified Raydium Fee Keys on Solana.",
    "Sona connects Solana liquidity with new opportunities through eligible positions and transferable fee rights.": "Sona connects verified Raydium Fee Keys with buyers on Solana.",
    "Sona is building around eligible Solana positions and transferable fee rights.": "Sona connects verified Raydium Fee Keys with buyers on Solana.",
    "Bring eligible Solana LP positions or fee rights to market. Compare assets, lock terms and transfer permissions. The underlying liquidity stays in its pool; only supported rights can change hands.": "Connect your wallet to find verified Raydium CPMM Fee Keys. List your fee rights at a price in SOL. The seller approves each buyer before the Fee Key and payment move together; underlying liquidity stays locked.",
    "Explore the intended listing flow for eligible Solana LP positions and fee rights. Live support depends on verifying each pool, lock and transfer permission. The current positions are illustrative.": "Connect your wallet to find verified Raydium CPMM Fee Keys. List your fee rights at a price in SOL. The seller approves each buyer before the Fee Key and payment move together; underlying liquidity stays locked.",
    "Explore eligible positions with clear pool, asset and lock details. Compare asking prices and fee rights before committing. Position values and pool fees can change; returns are not guaranteed.": "Compare verified Fee Keys, their pool assets and asking prices. A Fee Key transfers fee-collection rights, not the locked liquidity itself. Future fees can change; returns are not guaranteed.",
    "Explore illustrative positions with pool, asset and lock details. Live integrations are not yet available. Position values and pool fees can change; returns are not guaranteed.": "Compare verified Fee Keys, their pool assets and asking prices. A Fee Key transfers fee-collection rights, not the locked liquidity itself. Future fees can change; returns are not guaranteed.",
    "Privacy-conscious discovery is part of Sona’s vision: share a deal with its intended counterparty. A private listing is not an anonymous transfer; Solana settlement remains publicly verifiable.": "Private deal discovery is planned. Current listings are public, and on-chain settlement exposes wallet addresses and transaction details. A private conversation would not make a Solana transfer confidential.",
    "Private deal discovery is a planned feature. Current links use this browser’s saved workspace and cannot be shared with a counterparty. Unlisted discovery would not make on-chain settlement confidential.": "Private deal discovery is planned. Current listings are public, and on-chain settlement exposes wallet addresses and transaction details. A private conversation would not make a Solana transfer confidential.",
    "Solana moves fast. Memecoins. Perps. Private execution. The next frontier is liquidity itself. Sona gives eligible positions and fee rights a market.": "A market starts with clear rights. Pool assets. Lock terms. Transfer permissions. Sona starts with verified Raydium CPMM Fee Keys.",
    "A market starts with clear rights. Pool assets. Lock terms. Transfer permissions. Sona is building around the positions that can actually move.": "A market starts with clear rights. Pool assets. Lock terms. Transfer permissions. Sona starts with verified Raydium CPMM Fee Keys.",
    "More eligible positions give traders more choice. Sona brings token teams and liquidity providers into one Solana-focused marketplace.": "More eligible Fee Keys can give buyers more choice. Sona starts with Raydium CPMM fee rights on Solana.",
    "More eligible positions would give traders more choice. Sona is building a marketplace for Solana token teams and liquidity providers.": "More eligible Fee Keys can give buyers more choice. Sona starts with Raydium CPMM fee rights on Solana.",
    "Better discovery helps buyers compare the rights, risks and terms behind each position. Keep sensitive deal discussions discreet while settlement stays verifiable.": "Verified pool and lock details help buyers compare fee rights before making a purchase request. Both wallets approve settlement. Private discovery is planned.",
    "Better discovery should make rights, risks and terms easier to compare. Private discovery and on-chain settlement are planned; neither is available in the current interface.": "Verified pool and lock details help buyers compare fee rights before making a purchase request. Both wallets approve settlement. Private discovery is planned.",
    "More positions → better discovery → more counterparties → a deeper liquidity market. A network built around useful activity on Solana.": "More positions → better discovery → more counterparties → a deeper liquidity market. This is the intended growth model, not reported activity.",
    "CLEAR TERMS. TRANSFERABLE RIGHTS. SOLANA SETTLEMENT. A LIQUIDITY MARKET BUILT AROUND REAL POSITIONS.": "Clear terms. Verified fee rights. Atomic settlement on Solana.",
    "Clear terms. Transferable rights. A Solana liquidity marketplace in development.": "Clear terms. Verified fee rights. Atomic settlement on Solana.",
    "Solana is home to fast-moving token launches, active liquidity pools and a growing privacy ecosystem. Sona focuses on that market, with Solana-native positions and publicly verifiable settlement.": "Sona uses Solana’s existing Token, Associated Token and System programs to exchange a verified Fee Key for SOL in one transaction. Both wallets sign; no custom Sona settlement program or standing escrow is used.",
    "Sona is being designed for Solana positions and transferable fee rights. Protocol integrations and on-chain settlement are still in development.": "Sona uses Solana’s existing Token, Associated Token and System programs to exchange a verified Fee Key for SOL in one transaction. Both wallets sign; no custom Sona settlement program or standing escrow is used.",
    "Eligibility depends on the Solana pool, lock and transfer permissions. LP tokens, concentrated-liquidity positions and fee rights are different assets. Follow @SonaFiTrade for confirmed support and launch updates.": "The current integration supports Raydium CPMM Burn & Earn Fee Keys. Sona verifies the mint, owner, lock account, pool and locked LP escrow on Solana. Other LP assets and protocols are not supported.",
    "No live protocol integrations are currently available. Eligibility will depend on each Solana pool, lock and transfer permission. Protocol names in the interface describe illustrative positions, not confirmed support.": "The current integration supports Raydium CPMM Burn & Earn Fee Keys. Sona verifies the mint, owner, lock account, pool and locked LP escrow on Solana. Other LP assets and protocols are not supported.",
    "$SONA is live on base": "Built for Solana",
    "In development for Solana": "Built for Solana",
    "Unlock trapped capital, accelerate DeFi. Sona transforms locked liquidity into tradable, composable financial instruments.": "Liquidity stays locked. Fee rights can move. Sona connects buyers and sellers of verified Raydium Fee Keys on Solana.",
    "Every major breakthrough in crypto makes something new tradeable. ICOs. NFTs. Memecoins. Perps. Liquidity markets are next. Sona is creating the asset class.": "A market starts with clear rights. Pool assets. Lock terms. Transfer permissions. Sona starts with verified Raydium CPMM Fee Keys.",
    "Sona is a Solana-focused marketplace for eligible liquidity positions and transferable fee rights. Product availability and supported positions are announced through official Sona channels. The marketplace concept includes:": "Sona implements a marketplace for verified Raydium CPMM Fee Keys on Solana. Wallet authentication, chain-verified inventory, persistent listings and bilateral atomic settlement are implemented. Each sale requires the seller’s approval and the buyer’s signature. Listings are coordinated by the marketplace server; there is no custom Sona program or standing escrow. This build runs locally; a public deployment and independent security audit have not been completed. The current scope includes:",
    "Sona is developing a Solana-focused marketplace for eligible liquidity positions and transferable fee rights. The current interface uses illustrative data stored in this browser; wallet connections, live protocol integrations and on-chain settlement are not available. The intended marketplace includes:": "Sona implements a marketplace for verified Raydium CPMM Fee Keys on Solana. Wallet authentication, chain-verified inventory, persistent listings and bilateral atomic settlement are implemented. Each sale requires the seller’s approval and the buyer’s signature. Listings are coordinated by the marketplace server; there is no custom Sona program or standing escrow. This build runs locally; a public deployment and independent security audit have not been completed. The current scope includes:",
    "To interact with the Sona DApp, you must connect a compatible cryptocurrency wallet. You are solely responsible for the security of your wallet, private keys, and seed phrases.": "Connect a compatible Solana wallet to authenticate, list verified Fee Keys or approve a purchase. You remain responsible for the security of your wallet, private keys and seed phrases. Sona does not request or store your private keys.",
    "The current Sona interface does not connect cryptocurrency wallets. If wallet connections become available, you will remain solely responsible for the security of your wallet, private keys, and seed phrases.": "Connect a compatible Solana wallet to authenticate, list verified Fee Keys or approve a purchase. You remain responsible for the security of your wallet, private keys and seed phrases. Sona does not request or store your private keys.",
    "All transactions initiated from your connected wallet are your responsibility. Sona does not have access to your private keys and cannot reverse or modify on-chain transactions. You must ensure you are interacting with the correct Sona smart contracts at all times.": "Wallet authentication uses a signed message. A sale requires both wallets to sign the same transaction, exchanging one verified Fee Key for the agreed SOL price. Check the mint, price, recipient and network before signing. Solana transaction fees and account-creation costs apply. Once a seller’s signed approval is released, it may remain executable until its blockhash expires; removing a listing cannot revoke that signature.",
    "The current interface does not request wallet signatures or submit on-chain transactions. Any future transactions initiated from your connected wallet will be your responsibility. Sona does not have access to your private keys. Before any future on-chain interaction, verify the published program addresses and transaction details; blockchain transactions may be irreversible.": "Wallet authentication uses a signed message. A sale requires both wallets to sign the same transaction, exchanging one verified Fee Key for the agreed SOL price. Check the mint, price, recipient and network before signing. Solana transaction fees and account-creation costs apply. Once a seller’s signed approval is released, it may remain executable until its blockhash expires; removing a listing cannot revoke that signature.",
    "The Sona protocol, its smart contract architecture, website, branding, and original content are and will remain the exclusive property of Sona and its licensors. The Service is protected by copyright, trademark, and other applicable laws.": "The Sona website, interface, branding and original content are and will remain the property of Sona and its licensors, subject to applicable third-party and open-source licenses. Raydium and Solana programs remain the work of their respective authors.",
    "The Sona website, interface, branding, original content, and any future protocol architecture are and will remain the exclusive property of Sona and its licensors. The Service is protected by copyright, trademark, and other applicable laws.": "The Sona website, interface, branding and original content are and will remain the property of Sona and its licensors, subject to applicable third-party and open-source licenses. Raydium and Solana programs remain the work of their respective authors.",
    "Transactions executed through the Sona DApp are governed by the underlying smart contracts. Sona does not claim ownership over any LP positions, tokens, or assets transacted through the platform.": "Settlement uses Solana’s existing Token, Associated Token and System programs. The Fee Key transfer and SOL payment are atomic: either both execute, or both roll back. Network fees may still be charged for a failed transaction. Sona does not claim ownership of users’ Fee Keys, tokens or other assets.",
    "Actions in the current interface are saved locally and do not transfer LP positions, tokens, or other assets. Any future on-chain transactions would be governed by the applicable deployed programs. Sona does not claim ownership over users’ LP positions, tokens, or assets.": "Settlement uses Solana’s existing Token, Associated Token and System programs. The Fee Key transfer and SOL payment are atomic: either both execute, or both roll back. Network fees may still be charged for a failed transaction. Sona does not claim ownership of users’ Fee Keys, tokens or other assets.",
    "While Sona's smart contracts are developed with security as a priority, no smart contract is entirely free from risk. You acknowledge that interacting with on-chain protocols carries inherent risks including but not limited to bugs, exploits, and unforeseen vulnerabilities.": "No independent security audit has been completed. Sona uses existing Solana programs rather than a custom settlement program, but the application, wallet integrations and underlying protocols can still contain bugs or vulnerabilities. Tests and published receipts are evidence of specific behavior, not a security guarantee.",
    "No Sona settlement program or security audit is currently provided with this interface. Any future smart-contract interaction would carry inherent risks including but not limited to bugs, exploits, and unforeseen vulnerabilities. No smart contract is entirely free from risk.": "No independent security audit has been completed. Sona uses existing Solana programs rather than a custom settlement program, but the application, wallet integrations and underlying protocols can still contain bugs or vulnerabilities. Tests and published receipts are evidence of specific behavior, not a security guarantee.",
    "Sona interacts with public Solana data. This website does not collect contact form submissions; its contact control opens the official Sona X account. Private deal discovery does not hide public wallet addresses or settlement.": "Sona reads public Solana account data to verify wallet holdings and Fee Keys. Authentication sessions, listings and purchase records are stored by the marketplace server. Solana wallet addresses and transaction details are public. Private deal discovery is planned and does not currently hide this information. This website’s contact control opens the official Sona X account.",
    "The current interface uses illustrative data and saves workspace activity in this browser. It does not read wallet holdings or submit transactions to Solana. This website does not collect contact form submissions; its contact control opens the official Sona X account. Any future private deal discovery would not by itself hide public wallet addresses or settlement.": "Sona reads public Solana account data to verify wallet holdings and Fee Keys. Authentication sessions, listings and purchase records are stored by the marketplace server. Solana wallet addresses and transaction details are public. Private deal discovery is planned and does not currently hide this information. This website’s contact control opens the official Sona X account.",
    "Designed for Solana": "Built on Solana",
    "Listed on Solana": "Fee rights on Solana",
    "Illustrative position": "Fee rights on Solana",
    "Private listings are unlisted, not anonymous. Settlement remains verifiable on-chain.": "Private discovery is planned. Wallet addresses and settlement remain public on Solana.",
    "Private links use this browser’s saved workspace. They do not enable shared discovery or on-chain settlement.": "Private discovery is planned. Wallet addresses and settlement remain public on Solana.",
    "Fees / 30d": "Example fees / 30d",
    "Past 30 days": "Illustrative",
    "Fees · past 30 days": "Example fees · 30 days",
    "Historical illustration": "Illustrative, not recorded fees",
    "Sona protocol, website, decentralized application (DApp), and related services": "Sona website, wallet application and related services",
    "Privacy-conscious deal discovery; private listings do not make settlement anonymous.": "Private deal discovery is planned and is not enabled in this release.",
    "Discover LP Positions": "Discover Fee Keys",
    "Privacy-Conscious Deals": "Private discovery · planned",
    "BY CONNECTING YOUR WALLET, INTERACTING WITH THE DAPP, OR ACCESSING THE PLATFORM, YOU ACKNOWLEDGE THAT YOU HAVE READ THESE TERMS OF SERVICE AND AGREE TO BE BOUND BY THEM.": "By connecting your wallet, interacting with the application or accessing the platform, you acknowledge that you have read these terms of service and agree to be bound by them.",
    "Keep liquidity in the pool. Give its ownership and fee rights a market of their own.": "Keep liquidity locked in the pool. Give transferable fee rights a market of their own.",
    "Discovering eligible Solana liquidity positions and transferable fee rights.": "Discovering verified Raydium CPMM Burn & Earn Fee Keys held by a connected wallet.",
    "Exploits: Attempting to exploit vulnerabilities in the smart contracts, escrow mechanisms, or any other component of the protocol.": "Exploits: Attempting to exploit vulnerabilities in the application, authentication, transaction construction or underlying Solana programs.",
    "Any applicable marketplace fees are disclosed in the relevant product or listing before confirmation. Refer to the current published fee details for supported products.": "The current settlement transaction adds no Sona marketplace fee. The buyer pays the agreed SOL price, network fees and any required token-account creation cost.",
    "Solana transactions may require network fees paid in SOL. These fees are separate from marketplace fees and are not controlled by Sona.": "Solana transactions require network fees paid in SOL. Creating a buyer token account also requires a rent-exempt balance. These costs are separate from the listed price.",
    "The value of locked LP positions, tokens, and cryptocurrency assets is volatile and can fluctuate significantly. Sona does not guarantee any returns, yields, or profits from using the Service.": "The value of Fee Keys, tokens and cryptocurrency assets can fluctuate significantly. Future pool fees are uncertain. Sona does not guarantee returns, yields or profits from using the Service."
}


def align_text(text):
    for old, new in sorted(REPLACEMENTS.items(), key=lambda item: -len(item[0])):
        text = text.replace(old, new)
        text = text.replace(old.replace(" ", "\u00a0"), new)
        text = text.replace(html.escape(old, quote=False), html.escape(new, quote=False))
    return text


def align_animated_paragraphs(text):
    def replace(match):
        content = match.group(2)
        if '<span><span style=' not in content:
            return match.group(0)
        plain = html.unescape(re.sub('<[^>]+>', '', content)).replace('\u00a0', ' ').strip()
        updated = align_text(plain)
        if updated == plain:
            return match.group(0)
        styles = re.findall(r'<span style="([^"]+)">', content)
        style = styles[-1] if styles else 'color:inherit'
        words = ["<span>" + "".join('<span style="' + style + '">' + html.escape(char) + '</span>' for char in word) + '&nbsp;</span>' for word in updated.split(' ')]
        return match.group(1) + ''.join(words) + '</p>'
    return re.sub(r'(<p\b[^>]*>)(.*?)</p>', replace, text, flags=re.S)


def align_cms(data):
    # Framer rich-text fields are length-prefixed UTF-8 JSON. Recompute only the
    # affected field lengths; preserve IDs, timestamps and the binary envelope.
    fields = []
    offset = 0
    while True:
        start = data.find(b'[1,', offset)
        if start < 0:
            break
        size = int.from_bytes(data[start - 4:start], 'big')
        body = data[start:start + size]
        json.loads(body)  # Refuse to mutate a guessed or malformed field.
        updated = align_text(body.decode('utf-8')).encode('utf-8')
        json.loads(updated)
        if updated != body:
            fields.append((start - 4, start + size, len(updated).to_bytes(4, 'big') + updated))
        offset = start + size
    for start, end, updated in reversed(fields):
        data = data[:start] + updated + data[end:]
    return data


def apply():
    changed = []
    for path in sorted((ROOT / 'dist').rglob('*')):
        if not path.is_file():
            continue
        # The live application and generated technical evidence have separate
        # owners/build steps. This editorial pass covers only the Framer site.
        relative = path.relative_to(ROOT / 'dist')
        if relative.parts[0] in {'app', 'technical', 'evidence'} or relative.name.startswith('technical'):
            continue
        if path.suffix == '.framercms':
            before = path.read_bytes()
            after = align_cms(before)
            if after != before:
                path.write_bytes(after)
                changed.append(path)
        elif path.suffix in {'.html', '.mjs', '.json', '.js'}:
            before = path.read_text()
            after = align_text(before)
            if path.suffix == '.html':
                after = align_animated_paragraphs(after)
            if after != before:
                path.write_text(after)
                changed.append(path)
    for path in changed:
        print(path.relative_to(ROOT))
    return changed


if __name__ == '__main__':
    apply()
