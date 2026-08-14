import { uuidv7 } from 'uuidv7';

/**
 * DV-05: branded identifiers. Passing an `AssetId` where a `WalletId` belongs is
 * a class of bug the compiler should catch, not a test.
 *
 * AR-25: UUIDv7 — time-ordered, so it clusters in the index instead of
 * scattering writes across the B-tree the way v4 does. Generated in application
 * code because the deployment target is Postgres 17, which has no native
 * `uuidv7()`; when it moves to 18 the default can move into the schema without
 * changing anything here.
 */

declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Branded<string, 'UserId'>;
export type AssetId = Branded<string, 'AssetId'>;
export type WalletId = Branded<string, 'WalletId'>;
export type TransactionId = Branded<string, 'TransactionId'>;
export type PositionId = Branded<string, 'PositionId'>;
export type ImportBatchId = Branded<string, 'ImportBatchId'>;
export type InstitutionId = Branded<string, 'InstitutionId'>;
export type ImportRowId = Branded<string, 'ImportRowId'>;
export type FixedIncomeContractId = Branded<string, 'FixedIncomeContractId'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The single place a raw string becomes an identifier. It validates, so an id
 * that arrived from outside the system cannot silently be a SQL fragment or an
 * empty string — this matters because ids are interpolated into
 * `current_setting('app.user_id')::uuid` comparisons (AR-11).
 */
function brandId<T extends string>(value: string, kind: string): T {
  if (!isUuid(value)) throw new TypeError(`${kind}: "${value}" is not a UUID`);
  return value as T;
}

export const UserId = {
  of: (value: string): UserId => brandId<UserId>(value, 'UserId'),
  generate: (): UserId => uuidv7() as UserId,
};

export const AssetId = {
  of: (value: string): AssetId => brandId<AssetId>(value, 'AssetId'),
  generate: (): AssetId => uuidv7() as AssetId,
};

export const WalletId = {
  of: (value: string): WalletId => brandId<WalletId>(value, 'WalletId'),
  generate: (): WalletId => uuidv7() as WalletId,
};

export const TransactionId = {
  of: (value: string): TransactionId => brandId<TransactionId>(value, 'TransactionId'),
  generate: (): TransactionId => uuidv7() as TransactionId,
};

export const PositionId = {
  of: (value: string): PositionId => brandId<PositionId>(value, 'PositionId'),
  generate: (): PositionId => uuidv7() as PositionId,
};

export const ImportBatchId = {
  of: (value: string): ImportBatchId => brandId<ImportBatchId>(value, 'ImportBatchId'),
  generate: (): ImportBatchId => uuidv7() as ImportBatchId,
};

export const InstitutionId = {
  of: (value: string): InstitutionId => brandId<InstitutionId>(value, 'InstitutionId'),
  generate: (): InstitutionId => uuidv7() as InstitutionId,
};

export const ImportRowId = {
  of: (value: string): ImportRowId => brandId<ImportRowId>(value, 'ImportRowId'),
  generate: (): ImportRowId => uuidv7() as ImportRowId,
};

export const FixedIncomeContractId = {
  of: (value: string): FixedIncomeContractId =>
    brandId<FixedIncomeContractId>(value, 'FixedIncomeContractId'),
  generate: (): FixedIncomeContractId => uuidv7() as FixedIncomeContractId,
};
