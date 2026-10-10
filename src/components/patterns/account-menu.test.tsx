import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu, type AccountMenuProps } from '@/components/patterns/account-menu';
import { audit, render, screen, userEvent, waitFor, within } from '@/components/test-utils';

const profile = {
  name: 'Ana Ribeiro',
  email: 'ana.ribeiro@exemplo.test',
  imageUrl: 'https://lh3.googleusercontent.test/a/ana',
};

function props(overrides: Partial<AccountMenuProps> = {}): AccountMenuProps {
  return {
    profile,
    theme: 'system',
    saveTheme: vi.fn().mockResolvedValue({ status: 'saved' }),
    signOutAction: vi.fn().mockResolvedValue(undefined),
    helpAction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const trigger = () => screen.getByRole('button', { name: /Menu da conta/ });

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return screen.findByRole('menu');
}

afterEach(() => {
  document.documentElement.classList.remove('light', 'dark');
  window.localStorage.clear();
});

describe('AccountMenu', () => {
  // BR-022-09 / BR-001-05: name, e-mail and picture, as Google supplied them.
  it('names the person on the trigger, with the visible name inside the accessible one', () => {
    render(<AccountMenu {...props()} />);
    expect(trigger()).toHaveAccessibleName(/Ana Ribeiro/);
  });

  it('shows the Google name, e-mail and picture when open', async () => {
    const user = userEvent.setup();
    render(<AccountMenu {...props()} />);
    const menu = await open(user);

    expect(within(menu).getByText('Ana Ribeiro')).toBeInTheDocument();
    expect(within(menu).getByText('ana.ribeiro@exemplo.test')).toBeInTheDocument();
    expect(menu.querySelector('img')).toHaveAttribute('src', profile.imageUrl);
  });

  it('falls back to initials when Google sent no picture', async () => {
    const user = userEvent.setup();
    render(<AccountMenu {...props({ profile: { ...profile, imageUrl: null } })} />);
    const menu = await open(user);

    expect(menu.querySelector('img')).toBeNull();
    expect(within(menu).getByText('AR')).toBeInTheDocument();
  });

  it('uses the e-mail when Google sent no name', () => {
    render(<AccountMenu {...props({ profile: { ...profile, name: null, imageUrl: null } })} />);
    expect(trigger()).toHaveAccessibleName(/ana\.ribeiro@exemplo\.test/);
  });

  // BR-022-10: the items, in the order of the approved prototype.
  it('holds Conta, Preferências, Privacidade, the guide, the theme and Sair', async () => {
    const user = userEvent.setup();
    render(<AccountMenu {...props()} />);
    const menu = await open(user);

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Conta', 'Preferências', 'Privacidade', 'Guia de primeiros passos', 'Sair']);
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['Claro', 'Escuro', 'Sistema']);
  });

  it('links Conta, Preferências and Privacidade to their pages', async () => {
    const user = userEvent.setup();
    render(<AccountMenu {...props()} />);
    const menu = await open(user);

    expect(within(menu).getByRole('menuitem', { name: 'Conta' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Preferências' })).toHaveAttribute(
      'href',
      '/preferences',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Privacidade' })).toHaveAttribute(
      'href',
      '/privacy',
    );
  });

  // BR-022-11 / BR-001-07: a form submission, never a link a GET could follow.
  it('signs out by submitting a form, not by following a link', async () => {
    const user = userEvent.setup();
    const signOutAction = vi.fn().mockResolvedValue(undefined);
    render(<AccountMenu {...props({ signOutAction })} />);
    const menu = await open(user);

    const sair = within(menu).getByRole('menuitem', { name: 'Sair' });
    expect(sair).not.toHaveAttribute('href');
    expect(sair.closest('a')).toBeNull();

    await user.click(sair);
    await waitFor(() => expect(signOutAction).toHaveBeenCalled());
  });

  // The submission must not depend on the menu content still being mounted.
  it('signs out from the keyboard too, after the menu has closed', async () => {
    const user = userEvent.setup();
    const signOutAction = vi.fn().mockResolvedValue(undefined);
    render(<AccountMenu {...props({ signOutAction })} />);
    await open(user);

    await user.keyboard('{End}{Enter}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(signOutAction).toHaveBeenCalled());
  });

  // SPEC-020 BR-020-13: reopening the guide is a state change too.
  it('reopens the guide by submitting a form', async () => {
    const user = userEvent.setup();
    const helpAction = vi.fn().mockResolvedValue(undefined);
    render(<AccountMenu {...props({ helpAction })} />);
    const menu = await open(user);

    const guide = within(menu).getByRole('menuitem', { name: 'Guia de primeiros passos' });
    expect(guide).not.toHaveAttribute('href');

    await user.click(guide);
    await waitFor(() => expect(helpAction).toHaveBeenCalled());
  });

  // DS-20: operable from the keyboard alone.
  it('opens from the keyboard, moves with the arrows and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<AccountMenu {...props()} />);

    trigger().focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    await waitFor(() =>
      expect(within(menu).getByRole('menuitem', { name: 'Conta' })).toHaveFocus(),
    );

    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Preferências' })).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
  });

  // BR-022-30: applies on the click, persists through `saveTheme`.
  it('applies a theme without a reload and saves it to the account', async () => {
    const user = userEvent.setup();
    const saveTheme = vi.fn().mockResolvedValue({ status: 'saved' });
    render(<AccountMenu {...props({ saveTheme })} />);
    const menu = await open(user);

    expect(within(menu).getByRole('menuitemradio', { name: 'Sistema' })).toBeChecked();
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Escuro' }));

    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem('amw-theme')).toBe('dark');
    await waitFor(() => expect(saveTheme).toHaveBeenCalledWith('dark'));
    // The menu stays open so the person sees the result.
    expect(within(menu).getByRole('menuitemradio', { name: 'Escuro' })).toBeChecked();
  });

  it('puts the previous theme back when the account refuses the save', async () => {
    const user = userEvent.setup();
    const saveTheme = vi.fn().mockResolvedValue({ status: 'error' });
    render(<AccountMenu {...props({ theme: 'light', saveTheme })} />);
    const menu = await open(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Escuro' }));

    await waitFor(() => expect(document.documentElement).toHaveClass('light'));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(within(menu).getByRole('menuitemradio', { name: 'Claro' })).toBeChecked();
  });

  // A save that throws (session ended elsewhere, database down) must not
  // reach an error boundary and replace the page.
  it('puts the previous theme back when the save throws', async () => {
    const user = userEvent.setup();
    const saveTheme = vi.fn().mockRejectedValue(new Error('No authenticated session'));
    render(<AccountMenu {...props({ theme: 'light', saveTheme })} />);
    const menu = await open(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Escuro' }));

    await waitFor(() => expect(document.documentElement).toHaveClass('light'));
    expect(window.localStorage.getItem('amw-theme')).toBe('light');
    expect(within(menu).getByRole('menuitemradio', { name: 'Claro' })).toBeChecked();
  });

  // DS-20 / DS-48: the highlighted option's fill is nearly the track's, so
  // keyboard focus must be a ring.
  it('shows a focus ring on the theme options', async () => {
    const user = userEvent.setup();
    render(<AccountMenu {...props()} />);
    const menu = await open(user);

    for (const option of within(menu).getAllByRole('menuitemradio')) {
      expect(option.className).toContain('focus-visible:ring-ring');
    }
  });

  it('does not save when the chosen theme is already the current one', async () => {
    const user = userEvent.setup();
    const saveTheme = vi.fn().mockResolvedValue({ status: 'saved' });
    render(<AccountMenu {...props({ theme: 'dark', saveTheme })} />);
    const menu = await open(user);

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Escuro' }));
    expect(saveTheme).not.toHaveBeenCalled();
  });

  it('has no axe violations, closed or open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<AccountMenu {...props()} />);
    expect(await audit(baseElement)).toHaveNoViolations();

    await open(user);
    expect(await audit(baseElement)).toHaveNoViolations();
  });
});
