import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_FACTS_CONTRACT,
  assertModelFactsEnvelope,
  extractActiveRecordModelFacts,
  extractEloquentModelFacts,
} from '../../scanners/language/ruby-php/model-facts.mjs';

test('ActiveRecord: explicit table, primary key and literal relation metadata are preserved', () => {
  const report = extractActiveRecordModelFacts([
    'class Article < ApplicationRecord',
    '  self.table_name = "published_articles"',
    '  self.primary_key = "article_uid"',
    '  belongs_to :author, class_name: "User", foreign_key: :author_uid',
    '  has_many :comments',
    'end',
    '',
  ].join('\n'), { file: 'app/models/article.rb' });
  assert.equal(report.contract, MODEL_FACTS_CONTRACT);
  assertModelFactsEnvelope(report);
  assert.equal(report.models.length, 1);
  const article = report.models[0];
  assert.equal(article.table.value, 'published_articles');
  assert.equal(article.primaryKey.value, 'article_uid');
  assert.deepEqual(article.relations.map((x) => [x.kind, x.name]), [['belongs_to', 'author'], ['has_many', 'comments']]);
  assert.equal(article.relations[0].className, 'User');
  assert.equal(article.relations[0].foreignKey, 'author_uid');
  assert.equal(report.unknowns.length, 0);
});

test('ActiveRecord: implicit table and primary key stay unknown rather than applying Rails conventions', () => {
  const report = extractActiveRecordModelFacts('class Person < ApplicationRecord\nend\n', { file: 'app/models/person.rb' });
  assert.equal(report.models[0].table, null);
  assert.equal(report.models[0].primaryKey, null);
  assert.deepEqual(report.unknowns.map((x) => x.code).sort(), ['MODEL_PRIMARY_KEY_IMPLICIT', 'MODEL_TABLE_IMPLICIT']);
});

test('ActiveRecord: polymorphic relation records an explicit uncertainty', () => {
  const report = extractActiveRecordModelFacts('class Picture < ApplicationRecord\n  belongs_to :imageable, polymorphic: true\nend\n');
  assert.equal(report.models[0].relations[0].polymorphic, true);
  assert.equal(report.unknowns[0].code, 'MODEL_POLYMORPHIC_RELATION');
});

test('Eloquent: explicit persistence properties are preserved without default inference', () => {
  const report = extractEloquentModelFacts([
    '<?php',
    'class User extends Model {',
    "  protected $table = 'accounts';",
    "  protected $primaryKey = 'user_uuid';",
    "  protected $keyType = 'string';",
    '  public $incrementing = false;',
    "  protected $fillable = ['name', 'email'];",
    "  protected $guarded = ['role'];",
    '}',
    '',
  ].join('\n'), { file: 'app/Models/User.php' });
  assertModelFactsEnvelope(report);
  const user = report.models[0];
  assert.equal(user.table.value, 'accounts');
  assert.equal(user.primaryKey.value, 'user_uuid');
  assert.equal(user.keyType, 'string');
  assert.equal(user.incrementing, false);
  assert.deepEqual(user.fillable, ['name', 'email']);
  assert.deepEqual(user.guarded, ['role']);
  assert.equal(report.unknowns.length, 0);
});

test('Eloquent: omitted table/primary key remain explicit unknowns', () => {
  const report = extractEloquentModelFacts('<?php\nclass User extends Model {\n}\n');
  assert.equal(report.models[0].table, null);
  assert.equal(report.models[0].primaryKey, null);
  assert.deepEqual(report.unknowns.map((x) => x.code).sort(), ['MODEL_PRIMARY_KEY_IMPLICIT', 'MODEL_TABLE_IMPLICIT']);
});

test('ActiveRecord: association-like calls inside methods are not treated as class-level declarations', () => {
  const report = extractActiveRecordModelFacts([
    'class User < ApplicationRecord',
    '  has_many :posts',
    '  def debug_relation',
    '    has_many :not_a_model_declaration',
    '  end',
    'end',
    '',
  ].join('\n'));
  assert.deepEqual(report.models[0].relations.map((x) => x.name), ['posts']);
});

test('Eloquent: typed and morphTo relation methods are recorded without inventing a polymorphic target', () => {
  const report = extractEloquentModelFacts([
    '<?php',
    'class Comment extends Model {',
    '  public function post() {',
    "    return $this->belongsTo(Post::class, 'post_uuid');",
    '  }',
    '  public function commentable() {',
    '    return $this->morphTo();',
    '  }',
    '}',
    '',
  ].join('\n'));
  const relations = report.models[0].relations;
  assert.deepEqual(relations.map((x) => [x.kind, x.name]), [['belongsTo', 'post'], ['morphTo', 'commentable']]);
  assert.equal(relations[0].targetClass, 'Post');
  assert.equal(relations[0].foreignKey, 'post_uuid');
  assert.equal(relations[1].targetClass, null);
  assert.ok(report.unknowns.some((x) => x.code === 'MODEL_POLYMORPHIC_RELATION'));
});

test('model facts reject repository escape paths', () => {
  assert.throws(() => extractActiveRecordModelFacts('class X < ApplicationRecord\nend\n', { file: '../x.rb' }), /repository root/);
  assert.throws(() => extractEloquentModelFacts('<?php class X extends Model {}', { file: '/tmp/X.php' }), /repository-relative/);
});
