class Hero < ActiveRecord::Base
  self.table_name = "heroes"
  self.primary_key = "id"
end
