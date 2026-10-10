import { describe, expect, it } from 'vitest';
import { FileUpload } from '@/components/patterns/file-upload';
import { Field } from '@/components/patterns/field';
import { audit, fireEvent, render, screen, userEvent, waitFor } from '@/components/test-utils';

const sheet = (name = 'movimentacao-2026-09.xlsx', size = 48 * 1024) =>
  new File([new Uint8Array(size)], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

const zone = (container: HTMLElement) =>
  container.querySelector('[data-slot="file-upload"]') as HTMLElement;

function Labelled(props: Partial<React.ComponentProps<typeof FileUpload>>) {
  return (
    <Field id="extrato" label="Arquivo">
      <FileUpload name="file" accept=".xlsx,.xls" {...props} />
    </Field>
  );
}

describe('FileUpload', () => {
  it('is a native file input, so it posts without JavaScript', () => {
    render(<Labelled multiple required />);
    const input = screen.getByLabelText('Arquivo');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('name', 'file');
    expect(input).toHaveAttribute('accept', '.xlsx,.xls');
    expect(input).toHaveAttribute('multiple');
    expect(input).toBeRequired();
  });

  // BR-022-23 — the browser's own English chrome is never what a user reads.
  it('shows Portuguese text and keeps the native input transparent', () => {
    const { container } = render(<Labelled acceptHint=".xlsx ou .xls" />);
    expect(screen.getByText('Arraste o arquivo aqui')).toBeInTheDocument();
    expect(screen.getByText('escolha um arquivo')).toBeInTheDocument();
    expect(screen.getByText('Nenhum arquivo selecionado')).toBeInTheDocument();
    expect(screen.getByText(/\.xlsx ou \.xls/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/choose|no file/i);

    const input = screen.getByLabelText('Arquivo');
    expect(input.className).toContain('opacity-0');
    expect(input.className).toContain('inset-0');
    // The browser's hover tooltip would otherwise read "No file chosen".
    expect(input).toHaveAttribute('title', 'Nenhum arquivo selecionado');
  });

  it('takes its headline from the caller', () => {
    render(<Labelled title="Arraste o extrato da B3 aqui" />);
    expect(screen.getByText('Arraste o extrato da B3 aqui')).toBeInTheDocument();
  });

  it('names the chosen file, its size and offers to replace it', async () => {
    const user = userEvent.setup();
    const { container } = render(<Labelled />);
    await user.upload(screen.getByLabelText('Arquivo'), sheet());

    expect(zone(container)).toHaveAttribute('data-state', 'idle');
    expect(screen.getByText('1 arquivo')).toBeInTheDocument();
    expect(screen.getByText(/movimentacao-2026-09\.xlsx · 48 KB/)).toBeInTheDocument();
    expect(screen.getByText('Trocar')).toBeInTheDocument();
    expect(screen.queryByText('Nenhum arquivo selecionado')).not.toBeInTheDocument();
  });

  it('counts several files and lists each', async () => {
    const user = userEvent.setup();
    render(<Labelled multiple />);
    await user.upload(screen.getByLabelText('Arquivo'), [sheet('a.xlsx'), sheet('b.xlsx')]);
    expect(screen.getByText('2 arquivos')).toBeInTheDocument();
    expect(screen.getByText(/a\.xlsx/)).toBeInTheDocument();
    expect(screen.getByText(/b\.xlsx/)).toBeInTheDocument();
  });

  it('shows the dragging state while files are over it, and drops it on leave', () => {
    const { container } = render(<Labelled />);
    const target = zone(container);

    fireEvent.dragEnter(target, { dataTransfer: { types: ['Files'] } });
    expect(target).toHaveAttribute('data-state', 'dragging');
    expect(screen.getByText('Solte para enviar')).toBeInTheDocument();

    fireEvent.dragLeave(target, { relatedTarget: document.body });
    expect(target).toHaveAttribute('data-state', 'idle');
    expect(screen.queryByText('Solte para enviar')).not.toBeInTheDocument();
  });

  it('ignores a drag that carries no files', () => {
    const { container } = render(<Labelled />);
    fireEvent.dragEnter(zone(container), { dataTransfer: { types: ['text/plain'] } });
    expect(zone(container)).toHaveAttribute('data-state', 'idle');
  });

  it('forgets the chosen files when the form is reset', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <form>
        <Labelled />
      </form>,
    );
    await user.upload(screen.getByLabelText('Arquivo'), sheet());
    expect(screen.getByText('1 arquivo')).toBeInTheDocument();

    fireEvent.reset(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByText('Nenhum arquivo selecionado')).toBeInTheDocument());
  });

  it('shows the pending state while the surrounding form submits', async () => {
    let finish: () => void = () => undefined;
    const action = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const user = userEvent.setup();
    const { container } = render(
      <form action={action}>
        <Labelled />
        <button type="submit">Enviar</button>
      </form>,
    );
    await user.upload(screen.getByLabelText('Arquivo'), sheet());
    await user.click(screen.getByRole('button', { name: 'Enviar' }));

    await waitFor(() => expect(zone(container)).toHaveAttribute('data-state', 'pending'));
    expect(screen.getByText('Enviando…')).toBeInTheDocument();
    expect(zone(container)).toHaveAttribute('aria-busy', 'true');
    finish();
  });

  it('carries a focus ring that follows the input’s keyboard focus', async () => {
    const user = userEvent.setup();
    const { container } = render(<Labelled />);
    expect(zone(container).className).toContain('has-focus-visible:ring-ring');
    await user.tab();
    expect(screen.getByLabelText('Arquivo')).toHaveFocus();
  });

  describe('error', () => {
    it('shows the refusal in the zone, announced, in danger, with no way to miss it', () => {
      const { container } = render(<Labelled error="Envie a planilha .xlsx." />);
      const message = screen.getByRole('alert');
      expect(message).toHaveTextContent('Envie a planilha .xlsx.');
      expect(message.className).toContain('text-danger');
      expect(screen.getByText('Escolher outro')).toBeInTheDocument();
      expect(zone(container)).toHaveAttribute('data-state', 'error');
      expect(zone(container).className).toContain('data-[state=error]:border-danger');

      const input = screen.getByLabelText('Arquivo');
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription('Envie a planilha .xlsx.');
    });

    it('steps aside for a newly chosen file, and returns on the next submission', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <form onSubmit={(event) => event.preventDefault()}>
          <Labelled error="Envie a planilha .xlsx." />
        </form>,
      );
      await user.upload(screen.getByLabelText('Arquivo'), sheet('outro.xlsx'));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(zone(container)).toHaveAttribute('data-state', 'idle');
      expect(screen.getByText(/outro\.xlsx/)).toBeInTheDocument();

      fireEvent.submit(container.querySelector('form') as HTMLFormElement);
      expect(screen.getByRole('alert')).toHaveTextContent('Envie a planilha .xlsx.');
    });
  });

  it('can be disabled', () => {
    render(<Labelled disabled />);
    expect(screen.getByLabelText('Arquivo')).toBeDisabled();
  });

  it('has no axe violations empty, with files, dragging, in error and disabled', async () => {
    const user = userEvent.setup();
    const empty = render(<Labelled />);
    expect(await audit(empty.container)).toHaveNoViolations();
    fireEvent.dragEnter(zone(empty.container), { dataTransfer: { types: ['Files'] } });
    expect(await audit(empty.container)).toHaveNoViolations();
    await user.upload(screen.getByLabelText('Arquivo'), sheet());
    expect(await audit(empty.container)).toHaveNoViolations();
    empty.unmount();

    const failed = render(<Labelled error="Envie a planilha .xlsx." />);
    expect(await audit(failed.container)).toHaveNoViolations();
    failed.unmount();

    const disabled = render(<Labelled disabled />);
    expect(await audit(disabled.container)).toHaveNoViolations();
  });
});
