class Article < ApplicationRecord
  self.table_name = "published_articles"
  self.primary_key = "article_id"
end
