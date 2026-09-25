import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSymfonyRouteAttributeFacts } from '../../scanners/language/ruby-php/dsl-facts.mjs';

test('stacked Symfony Route attributes bind to the same following method', () => {
  const report = extractSymfonyRouteAttributeFacts([
    '<?php',
    'final class BlogController {',
    "  #[Route('/', name: 'blog_index', methods: ['GET'])]",
    "  #[Route('/page/{page}', name: 'blog_page', methods: ['GET'])]",
    '  public function index(): Response {}',
    '}',
    '',
  ].join('\n'));
  assert.equal(report.facts.length, 2);
  assert.ok(report.facts.every((fact) => fact.status === 'literal'));
  assert.ok(report.facts.every((fact) => fact.attributes.targetKind === 'method'));
  assert.ok(report.facts.every((fact) => fact.attributes.targetName === 'index'));
});

test('non-route attributes between Route and method do not break target ownership', () => {
  const report = extractSymfonyRouteAttributeFacts([
    '<?php',
    'final class BlogController {',
    "  #[Route('/comment/new', methods: ['POST'])]",
    "  #[IsGranted('IS_AUTHENTICATED')]",
    '  public function commentNew(): Response {}',
    '}',
    '',
  ].join('\n'));
  assert.equal(report.facts.length, 1);
  assert.equal(report.facts[0].status, 'literal');
  assert.equal(report.facts[0].attributes.targetName, 'commentNew');
});

test('Route inside a multi-attribute group can own the following class', () => {
  const report = extractSymfonyRouteAttributeFacts([
    '<?php',
    "#[Route('/profile'), IsGranted(User::ROLE_USER)]",
    'final class UserController {}',
    '',
  ].join('\n'));
  assert.equal(report.facts.length, 1);
  assert.equal(report.facts[0].status, 'literal');
  assert.equal(report.facts[0].attributes.path, '/profile');
  assert.equal(report.facts[0].attributes.targetKind, 'class');
  assert.equal(report.facts[0].attributes.targetName, 'UserController');
});
