class Team < ActiveRecord::Base
  self.table_name = "teams"
  self.primary_key = "id"
end
