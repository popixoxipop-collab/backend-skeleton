#!/usr/bin/env node
// Generates the smallest bootable Rails application for the version installed by CI, then
// exercises both scanner modes. This stays outside `npm test`: it requires a real Ruby/Rails
// toolchain and intentionally boots application code for the runtime half.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScan } from '../scanners/index.mjs';

const railsVersion = process.env.BSKEL_RAILS_VERSION;
if (!railsVersion || !/^8\.(?:0|1)\.\d+(?:\.\d+)?$/.test(railsVersion)) {
	throw new Error('BSKEL_RAILS_VERSION must name an exact Rails 8.0.x or 8.1.x release');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), `bskel-rails-${railsVersion}-`));
const write = (rel, body, mode = null) => {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	if (mode !== null) fs.chmodSync(file, mode);
};

try {
	write('Gemfile', `source "https://rubygems.org"\ngem "rails", "${railsVersion}"\n`);
	write('config/boot.rb', 'ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)\nrequire "bundler/setup"\n');
	write('config/application.rb', `require_relative "boot"
require "rails/all"
Bundler.require(*Rails.groups)
module BskelSmoke
  class Application < Rails::Application
    config.load_defaults ${railsVersion.startsWith('8.1.') ? '8.1' : '8.0'}
    config.eager_load = false
    config.secret_key_base = "bskel-rails-integration-smoke-only"
  end
end
`);
	write('config/environment.rb', 'require_relative "application"\nRails.application.initialize!\n');
	write('config/routes.rb', `Rails.application.routes.draw do
  namespace :api do
    resources :articles, only: [:index, :show, :create] do
      member do
        get :preview
      end
    end
  end
  get "/health", to: "health#show"
end
`);
	write('app/controllers/application_controller.rb', 'class ApplicationController < ActionController::Base\nend\n');
	write('app/controllers/api/articles_controller.rb', 'module Api\n  class ArticlesController < ApplicationController\n  end\nend\n');
	write('app/controllers/health_controller.rb', 'class HealthController < ApplicationController\nend\n');
	write('app/models/application_record.rb', 'class ApplicationRecord < ActiveRecord::Base\n  primary_abstract_class\nend\n');
	write('app/models/article.rb', 'class Article < ApplicationRecord\n  self.table_name = "published_articles"\n  self.primary_key = "article_uid"\nend\n');
	write('bin/rails', '#!/usr/bin/env ruby\nAPP_PATH = File.expand_path("../config/application", __dir__)\nrequire "rails/commands"\n', 0o755);

	execFileSync('bundle', ['install', '--local'], { cwd: root, stdio: 'inherit' });

	const staticReport = runScan({ repoRoot: root, terms: ['article'] });
	assert.equal(staticReport.adapter, 'ruby-rails');
	const staticArticles = staticReport.related_modules.find((m) => m.module === 'articles');
	assert.ok(staticArticles, 'static scan must recover the articles module');
	assert.deepEqual(
		staticArticles.controllers[0].endpoints.map((ep) => `${ep.verb} ${ep.path}`).sort(),
		['GET /api/articles', 'GET /api/articles/{id}', 'GET /api/articles/{id}/preview', 'POST /api/articles'].sort(),
	);
	assert.ok(staticArticles.controllers[0].endpoints.every((ep) => ep.operationIdSource === 'bskel-synthesized'));
	assert.equal(staticArticles.entities[0].table, 'published_articles');
	assert.equal(staticArticles.entities[0].idField, 'article_uid');

	const runtimeReport = runScan({ repoRoot: root, terms: ['article'], runtimeRoutes: true });
	assert.equal(runtimeReport.adapter, 'ruby-rails');
	assert.equal(runtimeReport.runtime_introspection?.kind, 'rails-routes');
	assert.equal(runtimeReport.runtime_introspection?.status, 'used');
	const runtimeArticles = runtimeReport.related_modules.find((m) => m.module === 'articles');
	assert.ok(runtimeArticles, 'runtime scan must recover the articles module');
	assert.deepEqual(
		runtimeArticles.controllers[0].endpoints.map((ep) => `${ep.verb} ${ep.path}`).sort(),
		['GET /api/articles', 'GET /api/articles/{id}', 'GET /api/articles/{id}/preview', 'POST /api/articles'].sort(),
	);

	process.stdout.write(`Rails ${railsVersion} static + runtime scanner smoke passed\n`);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
