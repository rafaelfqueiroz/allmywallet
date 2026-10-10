import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Money as MoneyValue, Quantity } from '@/core/shared/money';
import { PageShell } from '@/components/patterns/page-shell';
import { Section } from '@/components/patterns/section';
import { EmptyState } from '@/components/patterns/empty-state';
import { ErrorState } from '@/components/patterns/error-state';
import { StatCard, StatCardSkeleton } from '@/components/patterns/stat-card';
import { Money } from '@/components/patterns/money';
import { Field } from '@/components/patterns/field';
import { FileUpload } from '@/components/patterns/file-upload';
import { RouteTabs } from '@/components/patterns/route-tabs';
import { ScopeSelector } from '@/components/patterns/scope-selector';
import { StateBadge } from '@/components/patterns/state-badge';
import { SubNav } from '@/components/patterns/sub-nav';
import { Stack } from '@/components/layout/stack';
import { Cluster } from '@/components/layout/cluster';
import { Grid } from '@/components/layout/grid';
import { List, ListItem } from '@/components/layout/list';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { ChartLegend } from '@/components/charts/chart-legend';
import { assetClassColor } from '@/components/charts/palette';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Eye, Upload, Wallet } from 'lucide-react';
import { DemoTable } from './_components/DemoTable';

/**
 * The kitchen-sink route the visual suite photographs (DL-16).
 *
 * **Not reachable unless explicitly enabled.** The guard is an opt-in env var,
 * not `NODE_ENV !== 'production'`: the standalone server the visual suite runs
 * against *is* a production build (`output: 'standalone'` sets NODE_ENV
 * accordingly), so a NODE_ENV guard 404s the very page the screenshots are of
 * — which it duly did on the first attempt. `ALLOW_DEV_ROUTES` is set by
 * `scripts/e2e-server.sh` and by nothing that deploys.
 *
 * A page enumerating every component is surface area with no user behind it,
 * so it stays off by default.
 *
 * It renders every primitive in every variant *in one document* so a single
 * screenshot per theme and viewport covers the whole system. Four images
 * instead of forty, and any drift shows up as a diff rather than as nothing.
 *
 * AR-44 does not apply the way it does elsewhere — the labels here are
 * component names, not user-facing prose — but the ESLint rule does not know
 * that, so the copy still comes from the catalogue.
 */
/**
 * Dynamic, not static: the guard above reads an env var, and a prerendered
 * copy would bake in whatever it said at build time — which is "off", so the
 * page would be a permanent 404 no matter what the server was told.
 */
export const dynamic = 'force-dynamic';

const BUTTON_VARIANTS = [
  'default',
  'outline',
  'secondary',
  'ghost',
  'destructive',
  'link',
] as const;
const BADGE_VARIANTS = [
  'default',
  'secondary',
  'destructive',
  'outline',
  'ghost',
  'link',
  'success',
  'progress',
  'warning',
  'danger',
  'neutral',
] as const;

const STATUS_VARIANTS = ['success', 'progress', 'warning', 'danger', 'neutral'] as const;
const WATCH_STATES = ['buy', 'hold', 'sell', 'unknown'] as const;

/**
 * Fixture data, not copy. Ticker codes are proper nouns that render identically
 * in every locale — routing them through next-intl would put `PETR4` in the
 * translation catalogue, which is where nobody would ever look for it.
 */
/** Fixture wallets for the scope selector — names, not copy (see above). */
const SAMPLE_WALLETS = [
  { walletId: '00000000-0000-4000-8000-000000000001', name: 'Aposentadoria' },
  { walletId: '00000000-0000-4000-8000-000000000002', name: 'Reserva de Oportunidade' },
] as const;

const SAMPLE_ROWS = [
  { code: 'PETR4', quantity: '100', change: '1500.25' },
  { code: 'HGLG11', quantity: '42', change: '-320.75' },
] as const;

export default async function PrimitivesPage() {
  if (process.env.ALLOW_DEV_ROUTES !== 'true') notFound();

  const t = await getTranslations('common');
  const vocabulary = await getTranslations('vocabulary');

  return (
    // The page's own header is the `PageHeader` demo (BR-022-14): scope
    // selector and primary action on the right. One `<h1>` per document.
    <PageShell
      width="wide"
      title={vocabulary('patrimonio')}
      description={t('loading')}
      scope={<ScopeSelector wallets={SAMPLE_WALLETS} />}
      actions={<Button>{t('save')}</Button>}
    >
      <Section title={vocabulary('composicao')}>
        <Cluster gap="sm">
          {BUTTON_VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {t('save')}
            </Button>
          ))}
        </Cluster>
        <Cluster gap="sm">
          <Button size="xs">{t('save')}</Button>
          <Button size="sm">{t('save')}</Button>
          <Button size="default">{t('save')}</Button>
          <Button size="lg">{t('save')}</Button>
          <Button disabled>{t('save')}</Button>
        </Cluster>
        <Cluster gap="sm">
          {BADGE_VARIANTS.map((variant) => (
            <Badge key={variant} variant={variant}>
              {vocabulary('proventos')}
            </Badge>
          ))}
        </Cluster>
        {/* SPEC-022 BR-022-31/32 — status badges with their dot, the watch
            states, and the one wording for an estimated value. */}
        <Cluster gap="sm">
          {STATUS_VARIANTS.map((variant) => (
            <Badge key={variant} variant={variant} dot>
              {vocabulary('proventos')}
            </Badge>
          ))}
          {WATCH_STATES.map((state) => (
            <StateBadge key={state} state={state} label={vocabulary('precoMedio')} />
          ))}
          <Badge variant="outline">{t('estimated')}</Badge>
        </Cluster>
      </Section>

      {/* SPEC-022 BR-022-15/16 — route tabs and the vertical sub-navigation.
          The first tab and section point here, so each renders its active
          state. */}
      <Section title={vocabulary('patrimonio')}>
        <RouteTabs
          label={vocabulary('patrimonio')}
          tabs={[
            { href: '/primitives', label: vocabulary('patrimonio') },
            { href: '/primitives/composicao', label: vocabulary('composicao') },
            { href: '/primitives/proventos', label: vocabulary('proventos') },
          ]}
        />
        <SubNav
          label={vocabulary('composicao')}
          className="max-w-xs"
          items={[
            { href: '/primitives', label: vocabulary('patrimonio'), icon: <Wallet /> },
            { href: '/primitives/importar', label: vocabulary('proventos'), icon: <Upload /> },
            { href: '/primitives/observar', label: vocabulary('rentabilidade'), icon: <Eye /> },
          ]}
        />
      </Section>

      <Section title={vocabulary('precoMedio')}>
        <Cluster gap="md" align="end">
          <Field id="demo-text" label={vocabulary('patrimonio')} width="md">
            <Input placeholder={vocabulary('patrimonio')} />
          </Field>
          <Field id="demo-invalid" label={vocabulary('proventos')} error={t('empty')} width="md">
            <Input />
          </Field>
          <Field id="demo-select" label={vocabulary('composicao')} width="md">
            <NativeSelect>
              <option>{vocabulary('patrimonio')}</option>
            </NativeSelect>
          </Field>
          <Field id="demo-check" label={vocabulary('rentabilidade')} width="xs">
            <Checkbox defaultChecked />
          </Field>
        </Cluster>
        {/* BR-022-20 — a field with instructions beside two without, in one
            row: their controls must line up, which only a screenshot shows. */}
        <Cluster gap="md" align="end">
          <Field id="demo-plain" label={vocabulary('patrimonio')} width="lg">
            <Input defaultValue={vocabulary('patrimonio')} />
          </Field>
          <Field id="demo-hinted" label={vocabulary('composicao')} hint={t('loading')} width="lg">
            <Input defaultValue={vocabulary('composicao')} />
          </Field>
          <Field id="demo-long-select" label={vocabulary('rentabilidade')} width="lg">
            <NativeSelect defaultValue="long">
              <option value="long">{SAMPLE_WALLETS[1].name}</option>
            </NativeSelect>
          </Field>
        </Cluster>
        {/* BR-022-23 — the pt-BR drop zone, empty and refused. */}
        <Grid cols={2} gap="md">
          <Field id="demo-upload" label={vocabulary('proventos')}>
            <FileUpload name="demo-upload" accept=".xlsx" title={vocabulary('proventos')} />
          </Field>
          <Field id="demo-upload-error" label={vocabulary('proventos')}>
            <FileUpload
              name="demo-upload-error"
              accept=".xlsx"
              title={vocabulary('proventos')}
              error={t('empty')}
            />
          </Field>
        </Grid>
      </Section>

      <Section title={vocabulary('proventos')}>
        <DemoTable />
      </Section>

      {/* Controls on a card, where their hover fills land on the card layer.
       * tests/e2e/screens.spec.ts hovers each and runs axe on the settled
       * state — the review of #218 found a placeholder at 4.28:1 only there. */}
      <Section title={vocabulary('precoMedio')}>
        <Card>
          <CardContent>
            <Cluster gap="md" align="end">
              <Select>
                <SelectTrigger aria-label={vocabulary('composicao')} data-hover-subject="">
                  <SelectValue placeholder={vocabulary('patrimonio')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="patrimonio">{vocabulary('patrimonio')}</SelectItem>
                </SelectContent>
              </Select>
              <Input
                aria-label={vocabulary('proventos')}
                placeholder={vocabulary('proventos')}
                data-hover-subject=""
              />
              <NativeSelect aria-label={vocabulary('rentabilidade')} data-hover-subject="">
                <option>{vocabulary('rentabilidade')}</option>
              </NativeSelect>
              <Button variant="outline" data-hover-subject="">
                {t('save')}
              </Button>
            </Cluster>
          </CardContent>
        </Card>
      </Section>

      <Section title={vocabulary('rentabilidade')}>
        <Grid cols={4} gap="md">
          <StatCard
            label={vocabulary('patrimonio')}
            value={<Money value={MoneyValue.fromString('1234567.89')} />}
          />
          <StatCard
            label={vocabulary('rentabilidade')}
            value={<Money value={MoneyValue.fromString('0.1234')} kind="percent" signed />}
          />
          <StatCard
            label={vocabulary('proventos')}
            value={<Money value={MoneyValue.fromString('-4321.5')} signed />}
          />
          <StatCardSkeleton />
        </Grid>
      </Section>

      <Section title={vocabulary('proventos')}>
        <Table>
          <TableCaption className="sr-only">{vocabulary('proventos')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{vocabulary('patrimonio')}</TableHead>
              <TableHead scope="col">{vocabulary('precoMedio')}</TableHead>
              <TableHead scope="col">{vocabulary('rentabilidade')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SAMPLE_ROWS.map((row) => (
              <TableRow key={row.code}>
                <TableCell className="py-row">{row.code}</TableCell>
                <TableCell className="py-row">
                  <Money value={Quantity.fromString(row.quantity)} kind="quantity" />
                </TableCell>
                <TableCell className="py-row">
                  <Money value={MoneyValue.fromString(row.change)} signed />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title={t('loading')}>
        <Stack gap="sm">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-64" />
        </Stack>
      </Section>

      <Section title={t('empty')}>
        <Grid cols={2} gap="md">
          <EmptyState title={t('empty')} description={t('loading')} />
          <ErrorState title={t('empty')} description={t('loading')} />
        </Grid>
      </Section>

      <Section title={vocabulary('composicao')}>
        <Stack gap="sm">
          <ChartLegend
            entries={[
              { label: 'stock', color: assetClassColor('stock'), value: '30%' },
              { label: 'fii', color: assetClassColor('fii'), value: '20%' },
              { label: 'bdr', color: assetClassColor('bdr'), value: '15%' },
              { label: 'etf', color: assetClassColor('etf'), value: '12%' },
              { label: 'tesouro_direto', color: assetClassColor('tesouro_direto'), value: '10%' },
              { label: 'cdb', color: assetClassColor('cdb'), value: '6%' },
              { label: 'lci', color: assetClassColor('lci'), value: '4%' },
              { label: 'lca', color: assetClassColor('lca'), value: '3%' },
            ]}
          />
          <List gap="sm">
            <ListItem separated>
              <Text tone="muted">{vocabulary('patrimonio')}</Text>
            </ListItem>
            <ListItem separated>
              <Text tone="muted">{vocabulary('proventos')}</Text>
            </ListItem>
          </List>
        </Stack>
      </Section>
    </PageShell>
  );
}
