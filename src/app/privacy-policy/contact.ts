/**
 * SPEC-004 BR-004-16 — the published data-protection contact channel.
 *
 * **Not an encarregado.** LGPD art. 41 requires a controller to appoint one
 * and publish their contact details, but ANPD Resolução CD/ANPD nº 2/2022
 * relieves an *agente de tratamento de pequeno porte* of the appointment while
 * still requiring a published channel to data subjects. This product takes
 * that route, so the policy page says "canal de privacidade" and claims no
 * DPO. Appointing one later is an upgrade, not a correction — but the label
 * and this comment have to move together, or the page starts claiming a role
 * nobody holds.
 *
 * **What actually arrives here.** Access, portability and deletion are
 * self-service inside the account, so this channel carries the residue:
 * people who cannot sign in, rights the app does not implement (correction,
 * information about sharing), readers of the public policy who have no account
 * yet, the ANPD, and incident correspondence.
 *
 * **Requests that cannot be attributed to the account holder are refused,
 * with the reason explained.** Identity here rests entirely on the Google
 * account, and BR-001-12 rules out account recovery — so someone who has lost
 * that access cannot be verified by any means available to us. Exporting or
 * deleting on their say-so would hand one person's complete financial history
 * to another, or destroy it. The policy page states this before it bites
 * rather than leaving it to be discovered by someone already locked out.
 *
 * ⚠️ **PLACEHOLDER — no domain is registered yet.** Tracked as its own board
 * item, blocking on the first real user account rather than on launch. A
 * published contact nobody reads is worse than none: it turns a legal
 * obligation into a promise the product visibly fails to keep. Replace with a
 * role alias on the product's own domain — never a personal address, which
 * publishes the operator's own personal data on a page about not doing that.
 */
export const DATA_PROTECTION_CONTACT = 'privacidade@allmywallet.example.com';
