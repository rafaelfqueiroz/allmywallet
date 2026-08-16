/**
 * SPEC-004 BR-004-16 — the published data protection contact.
 *
 * LGPD art. 41 requires the controller to appoint an *encarregado* (DPO) and
 * to publish the channel for reaching them. "Publish" means a data subject can
 * find it without asking, which is why it renders on the policy page rather
 * than living in a README.
 *
 * A constant rather than a SPEC-002 config key: this is not an operator
 * tunable like a cadence or a threshold, and it changes at roughly the rate
 * the policy text itself does — so it belongs next to
 * `CURRENT_PRIVACY_POLICY_VERSION`, and changing it should mean bumping that
 * version in the same commit.
 *
 * ⚠️ **PLACEHOLDER — must be replaced with a real, monitored address before
 * the first real user account exists.** A published contact that nobody reads
 * is worse than none: it converts a legal obligation into a promise the
 * product visibly fails to keep. The address does not need to be a person;
 * an alias that reaches one is fine.
 */
export const DATA_PROTECTION_CONTACT = 'privacidade@allmywallet.example.com';
