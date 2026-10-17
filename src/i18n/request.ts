import { getRequestConfig } from 'next-intl/server';
import messages from '@/i18n/messages/pt-BR.json';
import { DEFAULT_LOCALE, TIME_ZONE } from '@/i18n/locale';

export { DEFAULT_LOCALE, TIME_ZONE };

export default getRequestConfig(async () => ({
  locale: DEFAULT_LOCALE,
  timeZone: TIME_ZONE,
  messages,
}));
