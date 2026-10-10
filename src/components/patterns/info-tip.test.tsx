import { describe, expect, it } from 'vitest';
import { InfoTip } from '@/components/patterns/info-tip';
import { audit, render, screen, userEvent, waitFor } from '@/components/test-utils';

const TEXT = 'Quanto a alocação pode se afastar do alvo.';

function Example() {
  return (
    <>
      <span id="tol-label">Tolerância de desvio</span>
      <InfoTip id="tol-info" label="Tolerância de desvio" labelledBy="tol-label">
        {TEXT}
      </InfoTip>
      <button type="button">Outro</button>
    </>
  );
}

const icon = () => screen.getByRole('button', { name: 'Instruções sobre Tolerância de desvio' });

describe('InfoTip', () => {
  it('is named after the field it explains, in Portuguese', () => {
    render(<Example />);
    expect(icon()).toBeInTheDocument();
  });

  it('names itself from the label element when the label is not a string', () => {
    render(
      <>
        <span id="x-label">
          Tolerância <em>de desvio</em>
        </span>
        <InfoTip
          id="x-info"
          label={
            <>
              Tolerância <em>de desvio</em>
            </>
          }
          labelledBy="x-label"
        >
          {TEXT}
        </InfoTip>
      </>,
    );
    expect(screen.getByRole('button')).toHaveAccessibleName(/Instruções sobre.*Tolerância/);
  });

  it('is closed until asked', () => {
    render(<Example />);
    expect(screen.queryByText(TEXT)).not.toBeInTheDocument();
    expect(icon()).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on keyboard focus, leaving focus on the icon', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();
    expect(icon()).toHaveFocus();
    expect(screen.getByText(TEXT)).toBeInTheDocument();
  });

  it('opens on hover and closes shortly after the pointer leaves', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.hover(icon());
    expect(screen.getByText(TEXT)).toBeInTheDocument();

    await user.unhover(icon());
    await waitFor(() => expect(screen.queryByText(TEXT)).not.toBeInTheDocument());
  });

  // WCAG 1.4.13 hoverable: the pointer can travel onto the content.
  it('stays open while the pointer is over its content', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.hover(icon());
    await user.unhover(icon());
    await user.hover(screen.getByText(TEXT));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByText(TEXT)).toBeInTheDocument();
  });

  it('opens on click or tap, and a second click does not slam it shut', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(icon());
    expect(screen.getByText(TEXT)).toBeInTheDocument();
    await user.click(icon());
    expect(screen.getByText(TEXT)).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();
    expect(screen.getByText(TEXT)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(TEXT)).not.toBeInTheDocument());
  });

  it('closes on blur', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Outro' })).toHaveFocus();
    await waitFor(() => expect(screen.queryByText(TEXT)).not.toBeInTheDocument());
  });

  it('is not dismissed by a passing pointer once opened by focus', async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();
    await user.hover(icon());
    await user.unhover(icon());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByText(TEXT)).toBeInTheDocument();
  });

  it('carries a focus-visible ring and does not submit a surrounding form', () => {
    render(
      <form>
        <Example />
      </form>,
    );
    expect(icon().className).toContain('focus-visible:ring-ring');
    expect(icon()).toHaveAttribute('type', 'button');
  });

  it('has no axe violations closed or open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<Example />);
    expect(await audit(baseElement)).toHaveNoViolations();
    await user.tab();
    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
