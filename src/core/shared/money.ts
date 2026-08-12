import Decimal from 'decimal.js';

/**
 * AR-06/AR-07/AR-08: money and quantities are `NUMERIC(20,8)` in Postgres and a
 * `Decimal` in the domain, wrapped so that domain code never touches `Decimal`
 * directly and a JS `number` can never enter a money path.
 *
 * Why this file is the most consequential in the project: a float reaching a
 * money field corrupts data silently and unfixably. 0.1 + 0.2 is wrong by
 * 5.5e-17 — invisible in one trade, a reconciliation failure across ten years
 * of them.
 *
 * AR-09: nothing here rounds. Rounding happens once, at display, in the i18n
 * formatter. The single unavoidable exception is division, which for a
 * repeating decimal must terminate somewhere; `PRECISION` below is where.
 */

/**
 * 40 significant digits. `NUMERIC(20,8)` needs 28; the surplus absorbs
 * intermediate division in average-cost and accrual chains without the error
 * reaching the 8th decimal place that is actually persisted.
 */
const PRECISION = 40;

Decimal.set({
  precision: PRECISION,
  // Never emit exponential notation — these strings go straight into NUMERIC
  // columns and JSON payloads (AR-10), where `1e-9` is not a valid literal
  // everywhere it lands.
  toExpNeg: -PRECISION,
  toExpPos: PRECISION,
  // Division must terminate; truncation rather than rounding keeps the result
  // deterministic and never inflates a figure the user will reconcile.
  rounding: Decimal.ROUND_DOWN,
});

/** Accepted inputs. Deliberately not `number` — that is the whole point. */
export type NumericInput = string | Decimal;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

function parse(input: NumericInput, kind: string): Decimal {
  if (input instanceof Decimal) return input;
  const trimmed = input.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new TypeError(`${kind}: "${input}" is not a plain decimal literal`);
  }
  return new Decimal(trimmed);
}

/**
 * An amount of Brazilian reais. Immutable (DV-06); every operation returns a
 * new instance.
 */
export class Money {
  readonly #value: Decimal;

  private constructor(value: Decimal) {
    this.#value = value;
  }

  static fromString(value: NumericInput): Money {
    return new Money(parse(value, 'Money'));
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  /**
   * The only sanctioned way a `number` becomes money, and it exists solely for
   * literals written by hand in tests and seeds. Never call this on a value
   * that arrived from a parser, an API or a database — AR-06 exists because
   * that path is how corruption enters.
   */
  static unsafeFromNumber(value: number): Money {
    if (!Number.isFinite(value)) throw new TypeError(`Money: ${value} is not finite`);
    return new Money(new Decimal(value));
  }

  plus(other: Money): Money {
    return new Money(this.#value.plus(other.#value));
  }

  minus(other: Money): Money {
    return new Money(this.#value.minus(other.#value));
  }

  /** Unit price × quantity, or a scaling factor such as a split ratio. */
  times(factor: Quantity | NumericInput): Money {
    return new Money(this.#value.times(toDecimal(factor)));
  }

  /** Total ÷ quantity — this is how `preço médio` is derived. */
  dividedBy(divisor: Quantity | NumericInput): Money {
    const d = toDecimal(divisor);
    if (d.isZero()) throw new RangeError('Money: division by zero');
    return new Money(this.#value.dividedBy(d));
  }

  negated(): Money {
    return new Money(this.#value.negated());
  }

  abs(): Money {
    return new Money(this.#value.abs());
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isNegative(): boolean {
    return this.#value.isNegative() && !this.#value.isZero();
  }

  isPositive(): boolean {
    return this.#value.isPositive() && !this.#value.isZero();
  }

  equals(other: Money): boolean {
    return this.#value.equals(other.#value);
  }

  /** -1, 0 or 1. Named to read at the call site: `a.comparedTo(b) > 0`. */
  comparedTo(other: Money): number {
    return this.#value.comparedTo(other.#value);
  }

  /**
   * Full-precision plain decimal string. This is the serialisation format for
   * NUMERIC columns, pg-boss payloads and server-action results — AR-10: never
   * let a `Decimal` reach `JSON.stringify`, because it comes back a float.
   */
  toString(): string {
    return this.#value.toFixed();
  }

  toJSON(): string {
    return this.toString();
  }

  /** For the i18n formatter only — the one place AR-09 permits rounding. */
  toDecimal(): Decimal {
    return this.#value;
  }
}

/**
 * A number of shares, quotas or units. Distinct from `Money` so the compiler
 * refuses `price.plus(quantity)`.
 */
export class Quantity {
  readonly #value: Decimal;

  private constructor(value: Decimal) {
    this.#value = value;
  }

  static fromString(value: NumericInput): Quantity {
    return new Quantity(parse(value, 'Quantity'));
  }

  static zero(): Quantity {
    return new Quantity(new Decimal(0));
  }

  /** See `Money.unsafeFromNumber` — tests and seeds only. */
  static unsafeFromNumber(value: number): Quantity {
    if (!Number.isFinite(value)) throw new TypeError(`Quantity: ${value} is not finite`);
    return new Quantity(new Decimal(value));
  }

  plus(other: Quantity): Quantity {
    return new Quantity(this.#value.plus(other.#value));
  }

  minus(other: Quantity): Quantity {
    return new Quantity(this.#value.minus(other.#value));
  }

  /** Split and bonificação ratios scale a quantity. */
  times(factor: Quantity | NumericInput): Quantity {
    return new Quantity(this.#value.times(toDecimal(factor)));
  }

  dividedBy(divisor: Quantity | NumericInput): Quantity {
    const d = toDecimal(divisor);
    if (d.isZero()) throw new RangeError('Quantity: division by zero');
    return new Quantity(this.#value.dividedBy(d));
  }

  negated(): Quantity {
    return new Quantity(this.#value.negated());
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isNegative(): boolean {
    return this.#value.isNegative() && !this.#value.isZero();
  }

  isPositive(): boolean {
    return this.#value.isPositive() && !this.#value.isZero();
  }

  equals(other: Quantity): boolean {
    return this.#value.equals(other.#value);
  }

  comparedTo(other: Quantity): number {
    return this.#value.comparedTo(other.#value);
  }

  toString(): string {
    return this.#value.toFixed();
  }

  toJSON(): string {
    return this.toString();
  }

  toDecimal(): Decimal {
    return this.#value;
  }
}

function toDecimal(value: Quantity | NumericInput): Decimal {
  return value instanceof Quantity ? value.toDecimal() : parse(value, 'operand');
}

/** Sum with an explicit empty case, so `[]` yields zero rather than undefined. */
export function sumMoney(values: readonly Money[]): Money {
  return values.reduce((acc, v) => acc.plus(v), Money.zero());
}

export function sumQuantity(values: readonly Quantity[]): Quantity {
  return values.reduce((acc, v) => acc.plus(v), Quantity.zero());
}
