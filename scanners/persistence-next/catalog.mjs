const TARGETS = [
	{
		id:'jpa-hibernate', state:'implemented-draft', ingestion:'legacy-adapter-bridge',
		producer:'java-spring', requires_live_verification:true,
		limitations:['legacy bridge only exposes the source facts present in the current Spring scanner'],
	},
	{
		id:'sqlalchemy-sqlmodel', state:'implemented-draft', ingestion:'legacy-adapter-bridge',
		producer:'python-fastapi', requires_live_verification:true,
		limitations:['current legacy bridge is SQLModel-oriented; SQLAlchemy general mapping is not claimed'],
	},
	{
		id:'typeorm', state:'implemented-draft', ingestion:'legacy-adapter-bridge',
		producer:'typescript-express', requires_live_verification:true,
		limitations:['current legacy bridge reflects the existing TypeORM extraction surface only'],
	},
	{
		id:'active-record', state:'implemented-draft', ingestion:'t07-model-facts+direct-provider',
		producer:'t07-ruby-php', requires_live_verification:true,
		limitations:['implicit Rails inflection, STI and polymorphic targets remain unknown'],
	},
	{
		id:'prisma', state:'implemented-draft', ingestion:'t10-provider',
		producer:'prisma-schema', requires_live_verification:true,
		limitations:['default schema candidates only; no schema-folder/runtime Prisma Client claim'],
	},
	{
		id:'django-orm', state:'implemented-draft', ingestion:'t10-provider',
		producer:'django-source', requires_live_verification:true,
		limitations:['direct models.Model only; implicit app-label table and implicit id remain unknown'],
	},
	{
		id:'eloquent', state:'implemented-draft', ingestion:'t07-model-facts',
		producer:'t07-ruby-php', requires_live_verification:true,
		limitations:['implicit Laravel naming and polymorphic targets remain unknown'],
	},
	{
		id:'drizzle', state:'blocked-upstream-facts', ingestion:'persistence-source-facts',
		producer:'t04-js-ts', requires_live_verification:true,
		blocker:'CR-T10-003: T04 declaration/call semantic facts are not available yet',
	},
	{
		id:'ef-core', state:'blocked-upstream-facts', ingestion:'persistence-source-facts',
		producer:'t08-csharp', requires_live_verification:true,
		blocker:'CR-T10-002: T08 EF Core persistence semantic facts are not available yet',
	},
	{
		id:'gorm', state:'blocked-upstream-facts', ingestion:'persistence-source-facts',
		producer:'t08-go', requires_live_verification:true,
		blocker:'CR-T10-002: T08 GORM persistence semantic facts are not available yet',
	},
	{
		id:'sequelize', state:'blocked-upstream-facts', ingestion:'persistence-source-facts',
		producer:'t04-js-ts', requires_live_verification:true,
		blocker:'CR-T10-003: T04 declaration/call semantic facts are not available yet',
	},
	{
		id:'diesel', state:'blocked-upstream-facts', ingestion:'persistence-source-facts',
		producer:'t08-rust', requires_live_verification:true,
		blocker:'T08 Rust semantic/compiler facts are not available in the current native-server pilot',
	},
].map((entry)=>Object.freeze({
	...entry,
	limitations:Object.freeze([...(entry.limitations ?? [])]),
}));

export const PERSISTENCE_TARGET_CATALOG = Object.freeze(TARGETS);

export function listPersistenceTargets() {
	return PERSISTENCE_TARGET_CATALOG.map((entry)=>({
		...entry,
		limitations:[...entry.limitations],
	}));
}

export function persistenceTargetById(id) {
	const found=PERSISTENCE_TARGET_CATALOG.find((entry)=>entry.id===id);
	return found ? {...found,limitations:[...found.limitations]} : null;
}

export function persistenceTargetSummary() {
	const counts={};
	for(const target of PERSISTENCE_TARGET_CATALOG) counts[target.state]=(counts[target.state]??0)+1;
	return {
		total:PERSISTENCE_TARGET_CATALOG.length,
		counts,
		implemented_draft:PERSISTENCE_TARGET_CATALOG.filter((target)=>target.state==='implemented-draft').map((target)=>target.id),
		blocked_upstream:PERSISTENCE_TARGET_CATALOG.filter((target)=>target.state==='blocked-upstream-facts').map((target)=>target.id),
	};
}
