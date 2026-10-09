class HeroTeamLink < ActiveRecord::Base
  self.table_name = "hero_team_links"
  self.primary_key = [:team_id, :hero_id]
end
