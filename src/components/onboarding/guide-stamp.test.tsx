import { describe, expect, it } from 'vitest';
import { GuideStamp } from '@/components/onboarding/guide-stamp';
import { B3_GUIDE_VERIFIED_AS_OF } from '@/components/onboarding/verification';
import { formatBusinessDate } from '@/i18n/format';
import { audit, render, screen } from '@/components/test-utils';

/**
 * SPEC-020 BR-020-24 — "each diagram set carries a 'verified against B3 as of
 * `<date>`' stamp, visible to the user." AR-47/BR-016-18: `dd/mm/yyyy`, never
 * the ISO string `B3_GUIDE_VERIFIED_AS_OF` is stored as.
 */
describe('GuideStamp', () => {
  it('renders the verification date as dd/mm/yyyy, not the ISO string it is stored as', () => {
    render(<GuideStamp label="Verificado na B3 em" />);

    expect(screen.getByText(/^Verificado na B3 em \d{2}\/\d{2}\/\d{4}$/)).toBeInTheDocument();
    expect(screen.queryByText(/\d{4}-\d{2}-\d{2}/)).not.toBeInTheDocument();
  });

  it('renders the exact committed verification date', () => {
    render(<GuideStamp label="Verificado na B3 em" />);
    expect(
      screen.getByText(formatBusinessDate(B3_GUIDE_VERIFIED_AS_OF), { exact: false }),
    ).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<GuideStamp label="Verificado na B3 em" />);
    expect(await audit(container)).toHaveNoViolations();
  });
});
