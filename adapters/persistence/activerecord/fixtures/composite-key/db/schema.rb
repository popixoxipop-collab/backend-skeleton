ActiveRecord::Schema[8.1].define(version: 1) do
  create_table "hero_team_links", primary_key: ["team_id", "hero_id"], force: :cascade do |t|
    t.integer "team_id", null: false
    t.integer "hero_id", null: false
    t.integer "joined_year"
  end
end
