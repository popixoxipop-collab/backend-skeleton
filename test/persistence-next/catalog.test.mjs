import test from 'node:test';
import assert from 'node:assert/strict';
import {
	listPersistenceTargets,
	persistenceTargetById,
	persistenceTargetSummary,
} from '../../scanners/persistence-next/catalog.mjs';

test('T10 catalog covers exactly the twelve persistence targets from the scale plan',()=>{
	const targets=listPersistenceTargets();
	assert.equal(targets.length,12);
	assert.deepEqual(targets.map((x)=>x.id),[
		'jpa-hibernate','sqlalchemy-sqlmodel','typeorm','active-record','prisma','django-orm','eloquent',
		'drizzle','ef-core','gorm','sequelize','diesel',
	]);
});

test('catalog distinguishes implemented draft ingestion from upstream fact blockers',()=>{
	const summary=persistenceTargetSummary();
	assert.equal(summary.total,12);
	assert.equal(summary.counts['implemented-draft'],7);
	assert.equal(summary.counts['blocked-upstream-facts'],5);
	assert.deepEqual(summary.blocked_upstream,['drizzle','ef-core','gorm','sequelize','diesel']);
});

test('no catalog target claims runtime support without live verification',()=>{
	for(const target of listPersistenceTargets()) assert.equal(target.requires_live_verification,true,target.id);
});

test('blocked targets name their upstream dependency instead of silently disappearing',()=>{
	for(const id of ['drizzle','ef-core','gorm','sequelize','diesel']){
		const target=persistenceTargetById(id);
		assert.equal(target.state,'blocked-upstream-facts');
		assert.equal(typeof target.blocker,'string');
		assert.ok(target.blocker.length>0);
	}
});

test('catalog returns copies rather than mutable shared records',()=>{
	const a=persistenceTargetById('prisma');
	a.limitations.push('mutated');
	const b=persistenceTargetById('prisma');
	assert.equal(b.limitations.includes('mutated'),false);
});
