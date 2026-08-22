import { describe, expect, it } from 'vitest';
import messages from '@/i18n/messages/pt-BR.json';
import { MarketingShell } from '@/components/marketing/marketing-shell';
import { Hero } from '@/components/marketing/hero';
import { FeatureGrid } from '@/components/marketing/feature-grid';
import { TrustPoints } from '@/components/marketing/trust-points';
import { CallToAction } from '@/components/marketing/call-to-action';
import { audit, render, screen, within } from '@/components/test-utils';

const marketing = messages.marketing;

/**
 * #37 — the public surface.
 *
 * The assertions here are structural and factual rather than about wording:
 * copy on a landing page is expected to change, and a test that pins a
 * sentence gets deleted the first time marketing edits it. What must not
 * change is the document outline, where the calls to action point, and that
 * the two claims the product is arranged around are actually on the page.
 */
describe('Hero', () => {
  it('carries the page’s only h1', () => {
    render(<Hero />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('sends its call to action into sign-in', () => {
    render(<Hero />);
    expect(screen.getByRole('link', { name: marketing.hero.cta })).toHaveAttribute(
      'href',
      '/signin',
    );
  });

  // SPEC-001 BR-001-01 / SPEC-003 BR-003-08 stated where the decision is made,
  // not only in the policy behind it.
  it('says at the point of decision that no password is asked for', () => {
    render(<Hero />);
    expect(screen.getByText(/nenhuma senha/i)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Hero />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('FeatureGrid', () => {
  it('describes every shipped surface once', () => {
    render(<FeatureGrid />);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4);
  });

  // The cards are the page's outline, not labels inside it: an h3 under the
  // section's h2 is what makes the page navigable by heading.
  it('titles each card as a heading below the section', () => {
    render(<FeatureGrid />);
    expect(
      screen.getByRole('heading', { level: 2, name: marketing.features.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: marketing.features.wallets.title }),
    ).toBeInTheDocument();
  });

  it('hides the decorative icons from assistive technology', () => {
    const { container } = render(<FeatureGrid />);
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
  });

  it('has no axe violations', async () => {
    const { container } = render(<FeatureGrid />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('TrustPoints', () => {
  // Both are architectural facts (BR-003-08, BR-004-02), which is what makes
  // them publishable at all. If either ever stops being true, this page is the
  // first place that has to change — and this test is what says so.
  it('states that no credential is collected and that CPF is discarded', () => {
    render(<TrustPoints />);
    expect(screen.getByText(/senha de banco/i)).toBeInTheDocument();
    expect(screen.getByText(/CPF/)).toBeInTheDocument();
  });

  it('reaches the privacy policy without signing in', () => {
    render(<TrustPoints />);
    expect(screen.getByRole('link', { name: marketing.trust.policyLink })).toHaveAttribute(
      'href',
      '/privacy-policy',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<TrustPoints />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('CallToAction', () => {
  it('is a region named by its own heading', () => {
    render(<CallToAction />);
    expect(screen.getByRole('region', { name: marketing.cta.title })).toBeInTheDocument();
  });

  it('sends the visitor into sign-in', () => {
    render(<CallToAction />);
    expect(screen.getByRole('link', { name: marketing.cta.button })).toHaveAttribute(
      'href',
      '/signin',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<CallToAction />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('MarketingShell', () => {
  it('frames the page in the three landmarks a public page is read by', () => {
    render(<MarketingShell />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('offers the policy and sign-in from the footer', () => {
    render(<MarketingShell />);
    // Scoped: "Entrar" appears in the header too, and an unscoped query would
    // pass on the wrong one the day the footer link is dropped.
    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByRole('link', { name: marketing.footer.privacyPolicy })).toHaveAttribute(
      'href',
      '/privacy-policy',
    );
    expect(footer.getByRole('link', { name: marketing.footer.signIn })).toHaveAttribute(
      'href',
      '/signin',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(<MarketingShell />);
    expect(await audit(container)).toHaveNoViolations();
  });
});

describe('the composed page', () => {
  const page = (
    <MarketingShell>
      <Hero />
      <FeatureGrid />
      <TrustPoints />
      <CallToAction />
    </MarketingShell>
  );

  // TS-27: the whole-page pass jsdom *can* do. Contrast and paint are checked
  // by the Playwright suites; composition order is checked here.
  it('reads as one h1 followed by sections, never a wall of h1s', () => {
    render(page);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(3);
  });

  it('has no axe violations once composed', async () => {
    const { container } = render(page);
    expect(await audit(container)).toHaveNoViolations();
  });
});
