class Hero < ActiveRecord::Base
  TABLE_PREFIX = "acme_"

  self.table_name = "#{TABLE_PREFIX}heroes"
  self.primary_key = "id"
end
