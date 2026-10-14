import type { ConfigKey } from '@/config/registry';

/**
 * The hidden field carrying what a parameter form showed for `key` when it
 * loaded (`saveUserParameters` writes only what the user changed). Shared by
 * the form and its action; a `'use server'` module may export only actions.
 */
export const loadedFieldName = (key: ConfigKey) => `loaded:${key}`;
