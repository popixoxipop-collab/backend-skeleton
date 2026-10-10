// Offline oracle config: `prisma migrate diff --from-empty|--from-schema ... --to-schema ... --script`
// never opens this connection; the placeholder URL only satisfies config validation.
import { defineConfig } from 'prisma/config';

export default defineConfig({
	schema: 'fixtures/normal/schema.prisma',
	datasource: { url: 'postgresql://oracle:oracle@127.0.0.1:1/oracle' },
});
