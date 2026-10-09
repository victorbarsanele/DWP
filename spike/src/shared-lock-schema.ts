import { EntitySchema } from "@mikro-orm/core";

export interface SharedLockRow {
  id: string;
  balance: string;
}

export const LockSchema = new EntitySchema<SharedLockRow>({
  name: "SharedLockRow",
  tableName: "shared_lock_rows",
  properties: {
    id: { type: "uuid", primary: true },
    balance: { type: "numeric", precision: 19, scale: 2 },
  },
});
