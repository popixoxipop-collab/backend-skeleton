// fixture-pin: typeorm@0.3.31 case: unknown-entity-forms
import { Entity, PrimaryGeneratedColumn } from 'typeorm';

const LEDGER_TABLE = 'ledger_entries';

@Entity({ name: 'audit_logs' })
export class AuditLog {
	@PrimaryGeneratedColumn()
	id!: number;
}

@Entity(LEDGER_TABLE)
export class LedgerEntry {
	@PrimaryGeneratedColumn()
	id!: number;
}
