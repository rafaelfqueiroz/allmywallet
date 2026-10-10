'use client';

import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { CircleAlert, FileText, Upload } from 'lucide-react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export interface FileUploadProps {
  /** The form field name. Required: this is a form control, not a widget. */
  readonly name: string;
  /** Given by `Field` when wrapped in one, so the label points at the input. */
  readonly id?: string;
  readonly accept?: string;
  readonly multiple?: boolean;
  readonly required?: boolean;
  readonly disabled?: boolean;
  /** Headline of the empty zone. Defaults to a generic catalogue line. */
  readonly title?: ReactNode;
  /** Short note beside "ou escolha um arquivo" — the accepted types, say. */
  readonly acceptHint?: ReactNode;
  /** A refusal to show in the zone, in `danger`; always visible (BR-022-21). */
  readonly error?: ReactNode;
  readonly className?: string;
  /** Cloned in by `Field`. */
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
}

interface Chosen {
  readonly name: string;
  readonly size: number;
}

/**
 * SPEC-022 BR-022-23 / DS-37 — a pt-BR drop zone around a **native**
 * `<input type="file">`.
 *
 * **The native input is the control; the zone is only what it looks like.**
 * The input is transparent and stretched over the whole zone, so a click
 * anywhere opens the picker and a file dropped anywhere is handled by the
 * browser itself — no handler of ours has to catch `drop`, which is why the
 * form still posts with JavaScript disabled, and why the browser's English
 * "Choose Files" / "No file chosen" chrome is never visible (it is painted
 * underneath, at `opacity-0`). Its `title` is set so the browser's own English
 * tooltip is not what a hover shows either.
 *
 * With JavaScript the zone adds what a static page cannot: the dragging state,
 * the chosen names and sizes, and the pending state from `useFormStatus` while
 * the surrounding form's action runs. None of it is load-bearing for the
 * submission.
 *
 * The focus ring follows the input's `:focus-visible` through `has-`, since the
 * input itself is invisible and a ring drawn on it would be too (DS-19).
 */
export function FileUpload({
  name,
  id,
  accept,
  multiple = false,
  required = false,
  disabled = false,
  title,
  acceptHint,
  error,
  className,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: FileUploadProps) {
  const t = useTranslations('fileUpload');
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const errorId = `${inputId}-error`;
  const { pending } = useFormStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [chosen, setChosen] = useState<readonly Chosen[]>([]);
  // A refusal describes the file that was sent. Once another is chosen it no
  // longer describes anything on screen, so it steps aside until the next
  // submission, which may bring a refusal of its own.
  const [errorDismissed, setErrorDismissed] = useState(false);

  // React resets the form after an action settles, which clears the input
  // without firing `change`. Without this the zone would keep naming files the
  // input no longer holds.
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const onReset = () => setChosen([]);
    const onSubmit = () => setErrorDismissed(false);
    form.addEventListener('reset', onReset);
    form.addEventListener('submit', onSubmit);
    return () => {
      form.removeEventListener('reset', onReset);
      form.removeEventListener('submit', onSubmit);
    };
  }, []);

  const hasError = error !== undefined && error !== null && error !== false && !errorDismissed;
  const state = hasError ? 'error' : pending ? 'pending' : dragging ? 'dragging' : 'idle';
  const summary = chosen.length === 0 ? t('none') : t('count', { count: chosen.length });

  const onDrag = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('Files')) setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    // Moving between children of the zone is not leaving it.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  };

  return (
    <div
      data-slot="file-upload"
      data-state={state}
      aria-busy={pending || undefined}
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={onDragLeave}
      onDrop={() => setDragging(false)}
      className={cn(
        'relative flex min-h-36 w-full items-center justify-center rounded-xl border border-dashed border-input bg-muted p-6 text-center transition-colors',
        'hover:bg-accent has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50',
        'data-[state=dragging]:border-primary data-[state=dragging]:bg-primary/10',
        'data-[state=error]:border-solid data-[state=error]:border-danger data-[state=error]:bg-danger-surface',
        'has-disabled:pointer-events-none has-disabled:opacity-50',
        className,
      )}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        name={name}
        title={summary}
        {...(accept ? { accept } : {})}
        multiple={multiple}
        required={required}
        disabled={disabled}
        aria-invalid={invalid || hasError || undefined}
        aria-describedby={
          [describedBy, hasError ? errorId : null].filter(Boolean).join(' ') || undefined
        }
        onChange={(event) => {
          setErrorDismissed(true);
          setChosen(
            Array.from(event.currentTarget.files ?? [], (f) => ({ name: f.name, size: f.size })),
          );
        }}
        className="peer absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />

      {/* Everything below is painted *under* the input and ignores the pointer,
          so the click and the drop land on the native control. */}
      <div className="pointer-events-none flex max-w-full flex-col items-center gap-2">
        {hasError ? (
          <>
            <CircleAlert aria-hidden className="size-6 text-danger" />
            <p id={errorId} role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
            <span className="text-sm font-medium text-primary">{t('chooseOther')}</span>
          </>
        ) : chosen.length > 0 ? (
          <>
            <FileText aria-hidden className="size-6 text-primary" />
            <p className="text-sm font-medium">{state === 'pending' ? t('sending') : summary}</p>
            <ul className="flex max-w-full flex-col gap-0.5 text-sm text-muted-foreground">
              {chosen.map((file, index) => (
                <li key={`${file.name}-${index}`} className="truncate">
                  {file.name} · {t('sizeKb', { size: Math.max(1, Math.round(file.size / 1024)) })}
                </li>
              ))}
            </ul>
            <span className="text-sm font-medium text-primary">{t('replace')}</span>
          </>
        ) : (
          <>
            <span className="flex size-9 items-center justify-center rounded-lg border bg-card text-primary">
              <Upload aria-hidden className="size-4" />
            </span>
            <p className="text-sm font-medium">
              {state === 'dragging' ? t('dropping') : (title ?? t('title'))}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('or')} <span className="font-medium text-primary">{t('choose')}</span>
              {acceptHint ? <> · {acceptHint}</> : null}
            </p>
            <p className="text-sm text-muted-foreground">{summary}</p>
          </>
        )}
      </div>
    </div>
  );
}
