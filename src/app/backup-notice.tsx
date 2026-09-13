import { getTranslations } from 'next-intl/server';
import type { FailedBackup } from '@/app/backup-status';
import { formatDateTime } from '@/i18n/format';
import { ErrorState } from '@/components/patterns/error-state';
import { Stack } from '@/components/layout/stack';
import { Text } from '@/components/ui/text';

/**
 * SPEC-021 BR-021-20 — a failed backup stays on screen until one succeeds.
 *
 * `ErrorState` rather than `Note`: this is a problem to act on, not a standing
 * disclosure (`role="alert"`). It is only ever rendered while that is true —
 * once a backup succeeds the newest row is a success and nothing renders.
 */
export async function BackupNotice({ failure }: { readonly failure: FailedBackup }) {
  const t = await getTranslations('app.backupNotice');
  const reason = failure.reason ?? '—';
  const failedAt = formatDateTime(failure.failedAt);

  return (
    <ErrorState
      data-slot="backup-notice"
      title={t('title')}
      description={
        <Stack gap="xs">
          <Text>
            {failure.lastSuccessAt
              ? t('withLastSuccess', {
                  failedAt,
                  reason,
                  lastSuccessAt: formatDateTime(failure.lastSuccessAt),
                })
              : t('withoutSuccess', { failedAt, reason })}
          </Text>
          <Text tone="muted">{t('action')}</Text>
        </Stack>
      }
    />
  );
}
