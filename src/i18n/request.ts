import { getRequestConfig } from 'next-intl/server';
import messages from '@/i18n/messages/pt-BR.json';

/**
 * AR-45: pt-BR is the only locale in v1. The catalogue exists so SPEC-016
 * BR-016-17's vocabulary requirement is checkable — not because a second
 * language is planned. There is therefore no locale segment in the URL and no
 * negotiation.
 */
export const DEFAULT_LOCALE = 'pt-BR';
export const TIME_ZONE = 'America/Sao_Paulo';

export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  timeZone: TIME_ZONE,
  messages,
}));
