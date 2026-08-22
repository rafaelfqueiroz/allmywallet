import { ChartPie, Layers, Upload, Wallet, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Grid } from '@/components/layout/grid';
import { Cluster } from '@/components/layout/cluster';
import { Section } from '@/components/patterns/section';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

/**
 * What the product does, in four cards.
 *
 * Every claim here is a shipped surface, checked against the routes that exist
 * rather than against the roadmap: the ledger (SPEC-006), wallets as views over
 * it (SPEC-010), the reports at `/reports/*` (SPEC-011..015) and the `.xlsx`
 * import with its confirm step (SPEC-005). A landing page that promises a
 * screen the user cannot reach is the cheapest way to lose them on day one.
 */
const FEATURES: readonly { readonly id: string; readonly icon: LucideIcon }[] = [
  { id: 'consolidation', icon: Layers },
  { id: 'wallets', icon: Wallet },
  { id: 'reports', icon: ChartPie },
  { id: 'import', icon: Upload },
];

export function FeatureGrid() {
  const t = useTranslations('marketing.features');

  return (
    <Section title={t('title')}>
      <Grid cols={2} gap="lg">
        {FEATURES.map(({ id, icon: Icon }) => (
          <Card key={id}>
            <CardHeader>
              <Cluster gap="sm">
                <Icon className="size-5 text-primary" aria-hidden="true" />
                {/* `asChild` so this is a real h3 under the section's h2 — the
                    card titles are the page's outline, not labels inside it. */}
                <CardTitle asChild>
                  <h3>{t(`${id}.title`)}</h3>
                </CardTitle>
              </Cluster>
            </CardHeader>
            <CardContent>
              <Text tone="muted">{t(`${id}.description`)}</Text>
            </CardContent>
          </Card>
        ))}
      </Grid>
    </Section>
  );
}
