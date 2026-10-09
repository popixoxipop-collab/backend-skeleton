class Hero < ActiveRecord::Base
  self.table_name = "heroes"
  self.primary_key = "id"
  belongs_to :team, class_name: "Team", foreign_key: "team_id"
end
