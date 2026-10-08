// fixture-pin: typeorm@0.3.31 case: composite-key
import { Entity, PrimaryColumn } from 'typeorm';

@Entity('tenant_users')
export class TenantUser {
	@PrimaryColumn('varchar')
	userId!: string;

	@PrimaryColumn('varchar')
	tenantId!: string;
}
